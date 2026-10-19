#!/usr/bin/env node
// idl-drift Action entrypoint (Node 20+).
//
// Reads inputs from `process.env` (GitHub Actions sets `INPUT_<name>`),
// reads the committed Anchor IDL from the workspace, fetches the on-chain
// IDL account of a Solana program (canonical Program Metadata `idl` PDA,
// or legacy Anchor IDL account), and reports drift or absence.
//
// Output: a step summary plus `idl-drift-report.json`. Exits non-zero only
// when the configured failure conditions trigger.
//
// Failure semantics:
//   - 0: no rot found, or the check was unresolvable (RPC failed, etc.)
//   - 2: rot found and the relevant fail flag is on
//   - 3: usage / IO error (committed IDL unreadable, etc.)
//
// The script never throws on unresolvable RPC conditions; it reports them
// separately and leaves exit status at 0 so the check is safe on schedule.

import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync, inflateSync } from "node:zlib";
import {
  METADATA_PROGRAM,
  base58Decode,
  base58Encode,
  metadataAddress,
  anchorIdlAddress,
} from "./derive.mjs";

const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const DEVNET_RPC = "https://api.devnet-beta.solana.com";

// `sha256("internal:IdlAccount")[..8]`, from `#[account("internal")]` in
// Anchor. See coral-xyz/anchor lang/src/idl.rs and the senzenn/idl-drift
// onchain.rs constants. The legacy Anchor IDL account uses this discriminator.
const ANCHOR_IDL_DISCRIMINATOR = Buffer.from([24, 70, 98, 191, 58, 144, 123, 158]);
const ANCHOR_HEADER_LEN = 44;

// Program Metadata account header: 96 bytes, then the body. Field layout per
// coral-xyz/anchor idl.ts + solana-program/program-metadata.
const METADATA_DISCRIMINATOR = 2;
const METADATA_HEADER_LEN = 96;
const METADATA_SEED = Buffer.alloc(16, 0);
Buffer.from("idl").copy(METADATA_SEED);
const MAX_IDL_BYTES = 16 << 20;

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
  return process.env.GITHUB_WORKSPACE || process.env.IDL_DRIFT_WORKSPACE || process.cwd();
}
async function resolveRpcUrl() {
  const raw = readInput("rpc-url") || MAINNET_RPC;
  if (raw === "mainnet" || raw === "mainnet-beta") return MAINNET_RPC;
  if (raw === "devnet" || raw === "devnet-beta") return DEVNET_RPC;
  return raw;
}

async function jsonRpcRequest(url, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "idl-drift", method, params });
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status} ${r.statusText}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC error: ${JSON.stringify(j.error)}`);
  return j.result;
}

/** Read a single account as { data: Buffer, owner: string, lamports: number } | null. */
async function getAccount(rpcUrl, address) {
  const result = await jsonRpcRequest(rpcUrl, "getAccountInfo", [
    address,
    { encoding: "base64" },
  ]);
  if (!result || !result.value) return null;
  const acc = result.value;
  if (acc.data[1] !== "base64") {
    throw new Error(`account ${address}: data is not base64`);
  }
  return {
    data: Buffer.from(acc.data[0], "base64"),
    owner: acc.owner,
    lamports: acc.lamports,
  };
}

/** The JSON IDL text inside a canonical Program Metadata `idl` account, or an error. */
function decodeMetadataAccount(data, programKey) {
  if (data.length < METADATA_HEADER_LEN) {
    return { error: `data is ${data.length} bytes, header needs ${METADATA_HEADER_LEN}` };
  }
  if (data[0] !== METADATA_DISCRIMINATOR) {
    return { error: "data does not start with the metadata discriminator (2)" };
  }
  if (Buffer.compare(data.subarray(1, 33), Buffer.from(programKey)) !== 0) {
    return { error: "metadata account is for a different program" };
  }
  if (data[66] === 0) {
    return { error: "metadata account is not canonical (no authority bit set)" };
  }
  if (Buffer.compare(data.subarray(67, 83), METADATA_SEED) !== 0) {
    return { error: "metadata account seed is not 'idl'" };
  }
  if (data[83] !== 1) {
    return { error: `metadata account encoding is ${data[83]}, only UTF-8 (1) holds JSON` };
  }
  if (data[85] > 1) {
    return { error: `metadata account format is ${data[85]}, only JSON (0/1) supported` };
  }
  if (data[86] !== 0) {
    return { error: `metadata account data source is ${data[86]}, only in-account (0) supported` };
  }
  const len = data.readUInt32LE(87);
  const start = METADATA_HEADER_LEN;
  const end = start + len;
  if (data.length < end) {
    return { error: `data is ${data.length} bytes, body needs ${end}` };
  }
  const body = data.subarray(start, end);
  let text;
  try {
    text = decodeBody(body, data[84]);
  } catch (e) {
    return { error: `cannot decode body: ${e.message}` };
  }
  if (text.length > MAX_IDL_BYTES) {
    return { error: `IDL > ${MAX_IDL_BYTES} bytes` };
  }
  return { text };
}

/** The JSON IDL text inside a legacy Anchor IDL account (44-byte header + zlib body). */
function decodeAnchorIdlAccount(data) {
  if (data.length < ANCHOR_HEADER_LEN) {
    return { error: `data is ${data.length} bytes, header needs ${ANCHOR_HEADER_LEN}` };
  }
  if (Buffer.compare(data.subarray(0, 8), ANCHOR_IDL_DISCRIMINATOR) !== 0) {
    return { error: "data does not start with the Anchor IDL discriminator" };
  }
  const len = data.readUInt32LE(40);
  const start = ANCHOR_HEADER_LEN;
  const end = start + len;
  if (data.length < end) {
    return { error: `data is ${data.length} bytes, body needs ${end}` };
  }
  let text;
  try {
    text = decodeBody(data.subarray(start, end), 2);
  } catch (e) {
    return { error: `cannot decode zlib body: ${e.message}` };
  }
  if (text.length > MAX_IDL_BYTES) {
    return { error: `IDL > ${MAX_IDL_BYTES} bytes` };
  }
  return { text };
}

function decodeBody(body, compression) {
  // 0 = none, 1 = gzip, 2 = zlib
  if (compression === 0) return body.toString("utf8");
  if (compression === 1) return gunzipSync(body).toString("utf8");
  if (compression === 2) return inflateSync(body).toString("utf8");
  throw new Error(`unknown compression ${compression}`);
}

/** Whether the JSON text has control characters in any string field. */
function hasControlCharacter(value) {
  const ctrl = (s) => s.split("").some((c) => c.charCodeAt(0) < 0x20);
  if (typeof value === "string") return ctrl(value);
  if (Array.isArray(value)) return value.some(hasControlCharacter);
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "docs") continue;
      if (ctrl(k) || hasControlCharacter(v)) return true;
    }
  }
  return false;
}

/** Field-level diff focused on the fields that drift across on-chain IDL bumps. */
const DIFF_FIELDS = ["version", "name", "instructions", "accounts", "types", "errors", "constants"];

/** Strip `docs` (a source-only annotation) recursively. Anchor's on-chain IDL
 *  spec never carries `docs`, so leaving them in would always show a diff
 *  between a committed IDL (which has docs) and its on-chain counterpart. */
function stripDocs(o) {
  if (Array.isArray(o)) return o.map(stripDocs);
  if (o && typeof o === "object") {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === "docs") continue;
      out[k] = stripDocs(v);
    }
    return out;
  }
  return o;
}

/** Compare one named field; returns a difference entry or null. */
function diffField(name, av, bv) {
  if (Array.isArray(av) && Array.isArray(bv)) {
    if (av.length !== bv.length) {
      return { field: name, kind: "length", committed: av.length, onChain: bv.length };
    }
    // Same length: find which named elements differ (instructions/accounts/types
    // carry a `name` per element; errors carry `code`).
    const keyOf = (el, i) => (el && typeof el === "object" && el.name) || String(el?.code ?? i);
    for (let i = 0; i < av.length; i++) {
      if (JSON.stringify(av[i]) === JSON.stringify(bv[i])) continue;
      // Same-length arrays can still be reordered; try a name-keyed match first.
      const key = keyOf(av[i], i);
      const idx = bv.findIndex((el) => keyOf(el, i) === key);
      if (idx >= 0 && JSON.stringify(av[i]) !== JSON.stringify(bv[idx])) {
        return { field: name, kind: "changed", entry: key };
      }
      if (idx < 0) {
        return { field: name, kind: "entries", committed: key };
      }
    }
    return null;
  }
  if (JSON.stringify(av) !== JSON.stringify(bv)) {
    return { field: name, kind: "value", committed: av, onChain: bv };
  }
  return null;
}

function diffIdl(a, b) {
  const differences = [];
  for (const k of DIFF_FIELDS) {
    const d = diffField(k, a?.[k], b?.[k]);
    if (d) differences.push(d);
  }
  return { ok: differences.length === 0, differences };
}

async function main() {
  const program = readInput("program");
  const idlPath = readInput("idl");
  if (!program) throw new Error("Missing required input: program");
  if (!idlPath) throw new Error("Missing required input: idl");
  const failOnDrift = readBool("fail-on-drift", true);
  const failOnMissing = readBool("fail-on-missing", false);
  const failOnLegacyDrift = readBool("fail-on-legacy-drift", false);
  const rpcUrl = await resolveRpcUrl();
  const root = envPath();
  const absIdlPath = path.resolve(root, idlPath);

  const report = {
    startedAt: new Date().toISOString(),
    program,
    rpcUrl,
    committedIdlPath: absIdlPath,
    checks: {
      onChainIdlAccount: { status: "pending" },
      decode: { status: "pending" },
      diff: { status: "pending" },
      legacyAnchorDiff: { status: "skipped" },
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
    report.checks.decode.committed = { ok: false, error: String(err?.message || err) };
    report.rot = { kind: "committed_idl_unreadable", detail: report.checks.decode.committed.error };
    await writeSummary(report, 3);
    return;
  }

  // 2. Derive both possible IDL account addresses, fetch them, decode whichever
  //    is present. Order: canonical metadata (Anchor 1.0+), then legacy anchor.
  let programKey;
  try {
    programKey = base58Decode(program);
    if (programKey.length !== 32) {
      throw new Error(`program address is ${programKey.length} bytes, expected 32`);
    }
  } catch (err) {
    report.checks.onChainIdlAccount = { status: "error", error: String(err?.message || err) };
    report.rot = { kind: "invalid_program", detail: report.checks.onChainIdlAccount.error };
    await writeSummary(report, 3);
    return;
  }

  const metadataAddr = base58Encode(metadataAddress(programKey));
  const anchorAddr = base58Encode(anchorIdlAddress(programKey));

  let metadataAcc = null;
  let anchorAcc = null;
  try {
    [metadataAcc, anchorAcc] = await Promise.all([
      getAccount(rpcUrl, metadataAddr),
      getAccount(rpcUrl, anchorAddr),
    ]);
  } catch (err) {
    report.checks.onChainIdlAccount = { status: "unresolvable", error: String(err?.message || err) };
    report.unresolvable.push({ kind: "rpc_failure", detail: report.checks.onChainIdlAccount.error });
    await writeSummary(report, 0);
    return;
  }

  // Filter out the "system account" case: a holder has lamports but owner is the System
  // Program (not the metadata program / not the program), so it is not actually an IDL
  // account.
  const hasMetadata = metadataAcc && metadataAcc.owner === METADATA_PROGRAM;
  const hasAnchor = anchorAcc && anchorAcc.owner === program;

  if (hasMetadata && hasAnchor) {
    // Both exist: pick canonical metadata (Anchor 1.0+), record both for the report.
    report.checks.onChainIdlAccount = {
      status: "both",
      metadataAddress: metadataAddr,
      anchorAddress: anchorAddr,
    };
  } else if (hasMetadata) {
    report.checks.onChainIdlAccount = { status: "ok", address: metadataAddr, source: "metadata" };
  } else if (hasAnchor) {
    report.checks.onChainIdlAccount = { status: "ok", address: anchorAddr, source: "anchor" };
  } else {
    report.checks.onChainIdlAccount = { status: "missing" };
    report.rot = {
      kind: "on_chain_idl_missing",
      detail: `no on-chain IDL account at metadata ${metadataAddr} or anchor ${anchorAddr}`,
    };
    await writeSummary(report, failOnMissing ? 2 : 0);
    return;
  }

  const idlAccount = hasMetadata
    ? metadataAcc
    : anchorAcc;
  const idlSource = hasMetadata ? "metadata" : "anchor";

  let decode;
  try {
    decode = idlSource === "metadata" ? decodeMetadataAccount(idlAccount.data, programKey) : decodeAnchorIdlAccount(idlAccount.data);
  } catch (err) {
    decode = { error: String(err?.message || err) };
  }
  if (decode.error) {
    report.checks.onChainIdlAccount = {
      ...report.checks.onChainIdlAccount,
      status: idlSource === "metadata" ? "metadata_undecodable" : "anchor_undecodable",
      decodeError: decode.error,
    };
    report.unresolvable.push({
      kind: "idl_account_undecodable",
      detail: `${idlSource} at ${report.checks.onChainIdlAccount.address}: ${decode.error}`,
    });
    await writeSummary(report, 0);
    return;
  }

  let onChainIdl;
  try {
    onChainIdl = JSON.parse(decode.text);
  } catch (err) {
    report.unresolvable.push({
      kind: "idl_json_parse",
      detail: `${idlSource} at ${report.checks.onChainIdlAccount.address}: ${err.message}`,
    });
    await writeSummary(report, 0);
    return;
  }
  if (hasControlCharacter(onChainIdl)) {
    report.unresolvable.push({
      kind: "idl_control_character",
      detail: `on-chain IDL contains a control character; refused to print`,
    });
    await writeSummary(report, 0);
    return;
  }
  // Legacy IDLs have no `address`; bind it to the program we asked about.
  if (!onChainIdl.address) onChainIdl.address = program;
  if (!committedIdl.address) committedIdl.address = program;
  report.checks.decode.onChain = { ok: true, source: idlSource, address: report.checks.onChainIdlAccount.address };

  // 3. Diff. `docs` is source-only — the on-chain spec strips it — so we
  //    compare both sides with docs removed to avoid a false positive on
  //    every type that has documentation.
  const diff = diffIdl(stripDocs(committedIdl), stripDocs(onChainIdl));

  // 4. Second diff site (Option B): when BOTH accounts exist, the legacy
  //    Anchor account can silently carry a staler layout than the canonical
  //    metadata account (real mainnet case: Whirlpool legacy 2KFq…cyn). Diff
  //    it too, report-only unless fail-on-legacy-drift is set, so schedules
  //    stay green while the stale publication becomes visible.
  let legacyDiff = null;
  if (hasMetadata && hasAnchor) {
    let legacyDecode;
    try {
      legacyDecode = decodeAnchorIdlAccount(anchorAcc.data);
    } catch (err) {
      legacyDecode = { error: String(err?.message || err) };
    }
    if (legacyDecode.error) {
      report.checks.legacyAnchorDiff = { status: "unresolvable", address: anchorAddr, error: legacyDecode.error };
      report.unresolvable.push({ kind: "legacy_anchor_undecodable", detail: `${anchorAddr}: ${legacyDecode.error}` });
    } else {
      try {
        const legacyIdl = JSON.parse(legacyDecode.text);
        if (hasControlCharacter(legacyIdl)) {
          report.checks.legacyAnchorDiff = { status: "unresolvable", address: anchorAddr, error: "control character" };
          report.unresolvable.push({ kind: "legacy_anchor_control_character", detail: anchorAddr });
        } else {
          if (!legacyIdl.address) legacyIdl.address = program;
          const ld = diffIdl(stripDocs(committedIdl), stripDocs(legacyIdl));
          if (ld.ok) {
            report.checks.legacyAnchorDiff = { status: "ok", address: anchorAddr };
          } else {
            report.checks.legacyAnchorDiff = {
              status: "drift",
              address: anchorAddr,
              differences: ld.differences,
            };
            legacyDiff = ld.differences;
          }
        }
      } catch (err) {
        report.checks.legacyAnchorDiff = { status: "unresolvable", address: anchorAddr, error: err.message };
        report.unresolvable.push({ kind: "legacy_anchor_json_parse", detail: `${anchorAddr}: ${err.message}` });
      }
    }
  }

  if (diff.ok) {
    report.checks.diff = { status: "ok" };
    if (legacyDiff) {
      // Canonical is in sync but the legacy publication rotted: surface it.
      report.rot = {
        kind: "legacy_idl_drift",
        source: "anchor-legacy",
        differences: legacyDiff,
        field: legacyDiff[0]?.field,
        detail: legacyDiff.map(formatDifference).join("; "),
      };
      await writeSummary(report, failOnLegacyDrift ? 2 : 0);
      return;
    }
    report.rot = null;
    await writeSummary(report, 0);
    return;
  }
  report.checks.diff = { status: "drift", differences: diff.differences };
  report.rot = {
    kind: "idl_drift",
    source: idlSource,
    differences: diff.differences,
    field: diff.differences[0]?.field,
    detail: diff.differences.map(formatDifference).join("; "),
  };
  await writeSummary(report, failOnDrift ? 2 : 0);
}

function formatDifference(d) {
  if (d.kind === "length") return `${d.field}: ${d.committed} entries committed vs ${d.onChain} on-chain`;
  if (d.kind === "changed") return `${d.field}.${d.entry}: changed`;
  if (d.kind === "entries") return `${d.field}: entry '${d.committed}' exists committed but not on-chain`;
  if (d.kind === "value") return `${d.field}: committed ${JSON.stringify(d.committed)} vs on-chain ${JSON.stringify(d.onChain)}`;
  return `${d.field}: differs`;
}

async function writeSummary(report, exitCode) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const lines = ["### idl-drift", ""];
    lines.push(`- program: \`${report.program}\``);
    lines.push(`- rpc: \`${report.rpcUrl}\``);
    lines.push(`- committed idl: \`${report.committedIdlPath}\``);
    const onChain = report.checks.onChainIdlAccount;
    if (onChain.address) {
      lines.push(`- on-chain idl (${onChain.source ?? "metadata"}): \`${onChain.address}\``);
    } else {
      lines.push(`- on-chain idl: ${onChain.status}`);
    }
    const legacy = report.checks.legacyAnchorDiff;
    if (legacy && legacy.status !== "skipped") {
      if (legacy.status === "ok") {
        lines.push(`- legacy anchor idl: \`${legacy.address}\` in sync`);
      } else if (legacy.status === "drift") {
        lines.push(`- legacy anchor idl: \`${legacy.address}\` **drifted**`);
      } else {
        lines.push(`- legacy anchor idl: ${legacy.status}`);
      }
    }
    if (report.rot) {
      lines.push("", `**rot: ${report.rot.kind}**`);
      if (report.rot.differences?.length) {
        lines.push("");
        for (const d of report.rot.differences) lines.push(`- ${formatDifference(d)}`);
      } else if (report.rot.detail) {
        lines.push(`detail: ${report.rot.detail}`);
      }
      if (report.rot.kind === "legacy_idl_drift") {
        lines.push("", "(canonical metadata account is in sync; report-only unless `fail-on-legacy-drift: true`)");
      }
    } else if (report.unresolvable.length === 0) {
      lines.push("", "**no rot**");
    }
    if (report.unresolvable.length > 0) {
      lines.push("", "Unresolvable (RPC did not answer conclusively):");
      for (const u of report.unresolvable) lines.push(`- ${u.kind}: ${u.detail}`);
    }
    await fs.appendFile(summaryPath, lines.join("\n") + "\n");
  }

  const reportPath = path.resolve(envPath(), "idl-drift-report.json");
  try {
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  } catch {
    // best-effort
  }

  if (report.rot) {
    const detail = report.rot.differences?.length
      ? `: ${report.rot.differences.map(formatDifference).join("; ")}`
      : `: ${report.rot.kind}`;
    // Report-only findings (exit 0) must not annotate a green run as an error.
    if (exitCode === 0) {
      console.log(`::warning::idl-drift: ${report.rot.kind} (report-only)${detail}`);
    } else {
      console.log(`::error::idl-drift: rot detected${detail}`);
    }
  } else if (report.unresolvable.length === 0) {
    console.log(`::notice::idl-drift: no rot detected for ${report.program}`);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("::error::idl-drift crashed:", err);
  process.exit(3);
});
