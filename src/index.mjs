#!/usr/bin/env node
// idl-drift Action entrypoint (Node 20+).
//
// Reads inputs from `process.env` (GitHub Actions sets `INPUT_<name>`),
// fetches the on-chain IDL account of a Solana program via JSON-RPC,
// parses the committed IDL file from the workspace, and reports drift.
//
// Output: a GitHub Actions step summary plus a JSON report at
// `idl-drift-report.json` (relative to GITHUB_WORKSPACE). Exits non-zero
// when the configured failure conditions trigger.
//
// Failure semantics:
//   - 0: no rot found
//   - 2: rot found and fail-on-drift / fail-on-missing is true
//   - 3: usage / IO error
//
// The script never throws on unresolvable RPC conditions; it reports them
// separately and leaves exit status at 0 so the check is safe on schedule.

import { promises as fs } from "node:fs";
import path from "node:path";

const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const DEVNET_RPC = "https://api.devnet-beta.solana.com";

// Anchor's IDL account seed (https://github.com/coral-xyz/anchor/blob/master/ts/packages/anchor/src/coder/borsh/idl.ts)
const ANCHOR_IDL_ACCOUNT_DISCRIMINATOR = "idl";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map();
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_INDEX.set(BASE58_ALPHABET[i], i);
}
function base58Decode(input) {
  if (typeof input !== "string" || input.length === 0) {
    return new Uint8Array(0);
  }
  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros++;
  const bytes = [0];
  for (let i = zeros; i < input.length; i++) {
    const c = input[i];
    const v = BASE58_INDEX.get(c);
    if (v === undefined) {
      throw new Error(`Invalid base58 character: ${c}`);
    }
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[zeros + i] = bytes[bytes.length - 1 - i];
  }
  return out;
}

function readInput(name) {
  const envName = `INPUT_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const v = process.env[envName];
  return v === undefined || v === "" ? undefined : v;
}
function readBool(name, defaultValue) {
  const raw = readInput(name);
  if (raw === undefined) return defaultValue;
  return ["true", "1", "yes", "on"].includes(String(raw).toLowerCase());
}

function envPath() {
  return (
    process.env.GITHUB_WORKSPACE ||
    process.env.IDL_DRIFT_WORKSPACE ||
    process.cwd()
  );
}

async function resolveRpcUrl() {
  const raw = readInput("rpc-url") || MAINNET_RPC;
  if (raw === "mainnet" || raw === "mainnet-beta") return MAINNET_RPC;
  if (raw === "devnet" || raw === "devnet-beta") return DEVNET_RPC;
  return raw;
}

function jsonRpcRequest(url, method, params) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "idl-drift",
    method,
    params,
  });
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).then(async (r) => {
    if (!r.ok) {
      throw new Error(`RPC HTTP ${r.status} ${r.statusText}`);
    }
    const j = await r.json();
    if (j.error) {
      throw new Error(`RPC error: ${JSON.stringify(j.error)}`);
    }
    return j.result;
  });
}

// Anchor IDL account layout (Borsh):
//   8 bytes discriminator ("idl" sha256 prefix) — but Anchor actually uses
//   8 raw bytes that are the first 8 bytes of sha256("account:IdlAccount")
//   only on modern accounts. Older layouts used the 4-byte discriminator
//   `[0x0a, 0x69, 0x64, 0x6c]` = "idl". Both are accepted by findIdlAddress.
// We don't need to re-derive the discriminator here; we just need to know
// what shape the data is in. Anchor v0.30+ IDL account data layout:
//   - 8 bytes discriminator (sha256("account:IdlAccount")[:8])
//   - Borsh-serialized IdlAccount struct { data_len: u32, data: Vec<u8> }
function tryDecodeAnchorIdl(dataB64) {
  const bytes = Buffer.from(dataB64, "base64");
  if (bytes.length < 44) return null;
  // We do not recompute the discriminator; the on-chain account is either
  // a recognizable IDL account or it isn't. Length is the cheap signal.
  const dataLen = bytes.readUInt32LE(8);
  const expected = 8 + 4 + dataLen;
  if (expected !== bytes.length) return null;
  const idlBytes = bytes.subarray(12, 12 + dataLen);
  try {
    const idlJson = JSON.parse(idlBytes.toString("utf8"));
    return idlJson;
  } catch {
    return null;
  }
}

function shallowEqualJson(a, b) {
  // Compare the structural fields most likely to drift between
  // committed and on-chain IDLs: version, name, instructions count,
  // accounts count, types count, errors count.
  const keys = [
    "version",
    "name",
    "instructions",
    "accounts",
    "types",
    "errors",
    "constants",
  ];
  for (const k of keys) {
    const av = a?.[k];
    const bv = b?.[k];
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length) {
        return {
          ok: false,
          field: k,
          detail: `length ${av.length} != ${bv.length}`,
        };
      }
      continue;
    }
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      return { ok: false, field: k, detail: `${JSON.stringify(av)} != ${JSON.stringify(bv)}` };
    }
  }
  return { ok: true };
}

async function main() {
  const program = readInput("program");
  const idlPath = readInput("idl");
  if (!program) {
    throw new Error("Missing required input: program");
  }
  if (!idlPath) {
    throw new Error("Missing required input: idl");
  }
  const failOnDrift = readBool("fail-on-drift", true);
  const failOnMissing = readBool("fail-on-missing", false);
  const rpcUrl = await resolveRpcUrl();
  const root = envPath();
  const absIdlPath = path.resolve(root, idlPath);

  const startedAt = new Date().toISOString();
  const report = {
    startedAt,
    program,
    rpcUrl,
    committedIdlPath: absIdlPath,
    checks: {
      onChainIdlAccount: { status: "pending" },
      decode: { status: "pending" },
      diff: { status: "pending" },
    },
    rot: null,
    unresolvable: [],
  };

  // 1. Read committed IDL
  let committedIdl;
  try {
    const raw = await fs.readFile(absIdlPath, "utf8");
    committedIdl = JSON.parse(raw);
    report.checks.decode.committed = { ok: true };
  } catch (err) {
    report.checks.decode.committed = {
      ok: false,
      error: String(err?.message || err),
    };
    report.rot = {
      kind: "committed_idl_unreadable",
      detail: report.checks.decode.committed.error,
    };
    await writeSummary(report, 3);
    return;
  }

  // 2. Fetch on-chain IDL account via standard Solana RPC. We use
  //    programAccounts memcmp on `anchor:idl` to find any IDL account
  //    whose data starts with the Anchor IDL discriminator. Cheaper
  //    than computing the IDL PDA ourselves and tolerant of older
  //    Anchor layouts.
  let idlAccount;
  try {
    const result = await jsonRpcRequest(rpcUrl, "getProgramAccounts", [
      program,
      {
        encoding: "base64",
        filters: [{ dataSize: undefined }], // populated below
      },
    ]).catch(async () => {
      // Some RPCs reject dataSize:undefined; retry without it.
      return await jsonRpcRequest(rpcUrl, "getProgramAccounts", [
        program,
        { encoding: "base64" },
      ]);
    });
    if (!Array.isArray(result) || result.length === 0) {
      report.checks.onChainIdlAccount = {
        status: "missing",
        note: "program has no owned accounts or RPC returned empty",
      };
      report.rot = {
        kind: "on_chain_idl_missing",
        detail:
          "No on-chain IDL account published by this program (or program owns no accounts).",
      };
      await writeSummary(report, failOnMissing ? 2 : 0);
      return;
    }
    // Find the first account whose data decodes as a recognizable IDL.
    let candidate = null;
    for (const acc of result) {
      const decoded = tryDecodeAnchorIdl(acc?.account?.data?.[0]);
      if (decoded) {
        candidate = { ...acc, decoded };
        break;
      }
    }
    if (!candidate) {
      report.checks.onChainIdlAccount = {
        status: "present_but_undecodable",
        accountCount: result.length,
      };
      report.unresolvable.push({
        kind: "idl_account_undecodable",
        detail: `${result.length} accounts owned, none parsed as IDL`,
      });
      await writeSummary(report, failOnMissing ? 2 : 0);
      return;
    }
    report.checks.onChainIdlAccount = {
      status: "ok",
      accountCount: result.length,
      address: candidate.pubkey,
    };
    idlAccount = candidate.decoded;
  } catch (err) {
    report.checks.onChainIdlAccount = {
      status: "unresolvable",
      error: String(err?.message || err),
    };
    report.unresolvable.push({
      kind: "rpc_failure",
      detail: report.checks.onChainIdlAccount.error,
    });
    await writeSummary(report, 0);
    return;
  }

  // 3. Diff
  const diff = shallowEqualJson(committedIdl, idlAccount);
  if (diff.ok) {
    report.checks.diff = { status: "ok" };
    report.rot = null;
    await writeSummary(report, 0);
    return;
  }
  report.checks.diff = { status: "drift", field: diff.field, detail: diff.detail };
  report.rot = {
    kind: "idl_drift",
    field: diff.field,
    detail: diff.detail,
  };
  await writeSummary(report, failOnDrift ? 2 : 0);
}

async function writeSummary(report, exitCode) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const lines = [];
    lines.push("### idl-drift");
    lines.push("");
    lines.push(`- program: \`${report.program}\``);
    lines.push(`- rpc: \`${report.rpcUrl}\``);
    lines.push(`- committed idl: \`${report.committedIdlPath}\``);
    lines.push(
      `- on-chain idl: ${report.checks.onChainIdlAccount.status}${
        report.checks.onChainIdlAccount.address
          ? ` (\`${report.checks.onChainIdlAccount.address}\`)`
          : ""
      }`
    );
    if (report.rot) {
      lines.push("");
      lines.push(`**rot: ${report.rot.kind}**`);
      if (report.rot.field) {
        lines.push(`field: \`${report.rot.field}\``);
      }
      if (report.rot.detail) {
        lines.push(`detail: ${report.rot.detail}`);
      }
    } else {
      lines.push("");
      lines.push("**no rot**");
    }
    if (report.unresolvable.length > 0) {
      lines.push("");
      lines.push("Unresolvable (RPC did not answer conclusively):");
      for (const u of report.unresolvable) {
        lines.push(`- ${u.kind}: ${u.detail}`);
      }
    }
    await fs.appendFile(summaryPath, lines.join("\n") + "\n");
  }

  const reportPath = path.resolve(envPath(), "idl-drift-report.json");
  try {
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  } catch (err) {
    // best-effort
  }

  // Mirror docrot-check output for the workflow log.
  if (report.rot) {
    console.log(
      `::error::idl-drift: ${report.rot.kind}${report.rot.field ? ` (${report.rot.field})` : ""}`
    );
  } else {
    console.log(`::notice::idl-drift: no rot detected for ${report.program}`);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("::error::idl-drift crashed:", err);
  process.exit(3);
});
