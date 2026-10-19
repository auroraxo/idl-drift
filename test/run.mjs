#!/usr/bin/env node
// Offline test driver for idl-drift.
//
// Spawns src/index.mjs with env inputs and a local HTTP server that fakes
// the Solana JSON-RPC `getAccountInfo` answer at the two derived IDL
// addresses (metadata PDA + legacy Anchor address), so no network needed.
//
// Cases:
//   1. no drift      — metadata account equals committed IDL   -> exit 0
//   2. drift         — metadata version changed                -> exit 2
//   3. missing       — both addresses null, fail-on-missing=false -> exit 0
//   4. missing       — both addresses null, fail-on-missing=true  -> exit 2
//   5. legacy anchor — zlib Anchor account, no drift           -> exit 0
//   6. both present  — metadata wins, no drift                 -> exit 0

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, deflateSync } from "node:zlib";
import {
  METADATA_PROGRAM,
  base58Encode,
  metadataAddress,
  anchorIdlAddress,
  base58Decode,
} from "../src/derive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "index.mjs");
const committedIdl = JSON.parse(
  await fs.readFile(path.join(here, "..", "testdata", "marinade_finance.json"), "utf8")
);

// Mirrors the on-chain IDL spec: `docs` never appear on-chain.
function stripDocsDeep(o) {
  if (Array.isArray(o)) return o.map(stripDocsDeep);
  if (o && typeof o === "object") {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === "docs") continue;
      out[k] = stripDocsDeep(v);
    }
    return out;
  }
  return o;
}

const ANCHOR_IDL_DISCRIMINATOR = Buffer.from([24, 70, 98, 191, 58, 144, 123, 158]);
const PROGRAM = "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD";
const programKey = base58Decode(PROGRAM);
const metadataAddr = base58Encode(metadataAddress(programKey));
const anchorAddr = base58Encode(anchorIdlAddress(programKey));

// Canonical Program Metadata `idl` account layout (96-byte header + body).
function encodeMetadataAccount(programKey, idlJson, compression = 0) {
  const json = Buffer.from(JSON.stringify(idlJson), "utf8");
  let body = json;
  if (compression === 1) body = gzipSync(json);
  if (compression === 2) body = deflateSync(json);

  const header = Buffer.alloc(96);
  header.writeUInt8(2, 0); // discriminator: initialized metadata account
  Buffer.from(programKey).copy(header, 1);
  // 33..64 = zeroable option pubkey (zero = None, ok: canonical flag at 66 is set)
  header.writeUInt8(1, 65); // authority bit (nonzero = canonical)
  header.writeUInt8(1, 66); // "upgrade authority" marker — must be nonzero per decode
  METADATA_SEED_COPY.copy(header, 67);
  header.writeUInt8(1, 83); // encoding: UTF-8
  header.writeUInt8(compression, 84);
  header.writeUInt8(1, 85); // format: JSON
  header.writeUInt8(0, 86); // data source: in-account
  header.writeUInt32LE(body.length, 87);
  // 91..95 padding (already zero)
  return Buffer.concat([header, body]);
}
const METADATA_SEED_COPY = Buffer.alloc(16, 0);
Buffer.from("idl").copy(METADATA_SEED_COPY);

// Legacy Anchor IDL account: 8-byte disc + authority + u32 len + zlib body.
function encodeAnchorAccount(idlJson) {
  const json = Buffer.from(JSON.stringify(idlJson), "utf8");
  const body = deflateSync(json);
  const header = Buffer.alloc(44);
  ANCHOR_IDL_DISCRIMINATOR.copy(header, 0);
  Buffer.alloc(32, 7).copy(header, 8); // authority
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

// accounts: { metadata: Buffer|null, anchor: Buffer|null }
function makeServer(accounts) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        const addr = parsed.params?.[0];
        const owner =
          addr === metadataAddr ? METADATA_PROGRAM : addr === anchorAddr ? PROGRAM : "11111111111111111111111111111111";
        const data = addr === metadataAddr ? accounts.metadata : addr === anchorAddr ? accounts.anchor : null;
        const value = data
          ? { data: [data.toString("base64"), "base64"], owner, lamports: 1, executable: false, rentEpoch: 0 }
          : null;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { context: { slot: 1 }, value } }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function runEntry(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

let failures = 0;
async function check(name, expect, fn) {
  try {
    const got = await fn();
    if (got && typeof got === "object" ? got.code === expect : got === expect) {
      console.log(`ok   ${name} (exit ${got.code ?? got})`);
    } else {
      console.log(`FAIL ${name}: expected exit ${expect}, got ${JSON.stringify(got)}`);
      failures++;
    }
  } catch (err) {
    console.log(`FAIL ${name}: ${err}`);
    failures++;
  }
}

async function withCase(accounts, fn) {
  const srv = await makeServer(accounts);
  const url = `http://127.0.0.1:${srv.address().port}`;
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "idl-drift-test-"));
  await fs.copyFile(
    path.join(here, "..", "testdata", "marinade_finance.json"),
    path.join(ws, "idl.json")
  );
  try {
    return await fn({ url, ws });
  } finally {
    srv.close();
    await fs.rm(ws, { recursive: true, force: true });
  }
}

const baseInputs = { INPUT_PROGRAM: PROGRAM, INPUT_IDL: "idl.json" };

await check(
  "no drift (metadata, uncompressed) -> 0",
  0,
  () =>
    withCase({ metadata: encodeMetadataAccount(programKey, committedIdl), anchor: null }, ({ url, ws }) =>
      runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws })
    )
);

await check(
  "no drift (metadata, zlib) -> 0",
  0,
  () =>
    withCase({ metadata: encodeMetadataAccount(programKey, committedIdl, 2), anchor: null }, ({ url, ws }) =>
      runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws })
    )
);

await check(
  "drift (metadata version changed) -> 2",
  2,
  () =>
    withCase(
      { metadata: encodeMetadataAccount(programKey, { ...committedIdl, version: "9.9.9" }), anchor: null },
      ({ url, ws }) => runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws })
    )
);

await check(
  "no docs diff: on-chain IDL without docs matches committed with docs -> 0",
  0,
  () =>
    withCase(
      { metadata: encodeMetadataAccount(programKey, stripDocsDeep(committedIdl)), anchor: null },
      ({ url, ws }) => runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws })
    )
);

await check(
  "drift detail: changed instruction named in report",
  2,
  async () => {
    const onChain = structuredClone(committedIdl);
    onChain.instructions[0].args = [{ name: "ctxRenamed", type: "publicKey" }];
    return withCase(
      { metadata: encodeMetadataAccount(programKey, onChain), anchor: null },
      async ({ url, ws }) => {
        const res = await runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws });
        if (res.code !== 2) return res;
        const report = JSON.parse(await fs.readFile(path.join(ws, "idl-drift-report.json"), "utf8"));
        const d = report.rot?.differences?.[0];
        if (report.rot?.kind !== "idl_drift") throw new Error(`kind=${report.rot?.kind}`);
        if (d?.field !== "instructions" || d?.kind !== "changed") {
          throw new Error(`expected instructions/changed, got ${JSON.stringify(d)}`);
        }
        if (d.entry !== committedIdl.instructions[0].name) {
          throw new Error(`expected entry ${committedIdl.instructions[0].name}, got ${d.entry}`);
        }
        if (!res.out.includes(`instructions.${d.entry}: changed`)) {
          throw new Error(`annotation missing from output: ${res.out}`);
        }
        return res;
      }
    );
  }
);

await check(
  "missing, fail-on-missing=false -> 0",
  0,
  () => withCase({ metadata: null, anchor: null }, ({ url, ws }) => runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws }))
);

await check(
  "missing, fail-on-missing=true -> 2",
  2,
  () =>
    withCase({ metadata: null, anchor: null }, ({ url, ws }) =>
      runEntry({ ...baseInputs, INPUT_RPC_URL: url, INPUT_FAIL_ON_MISSING: "true", GITHUB_WORKSPACE: ws })
    )
);

await check(
  "legacy anchor account, no drift -> 0",
  0,
  () =>
    withCase({ metadata: null, anchor: encodeAnchorAccount(committedIdl) }, ({ url, ws }) =>
      runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws })
    )
);

await check(
  "both present, metadata wins -> 0",
  0,
  () =>
    withCase(
      { metadata: encodeMetadataAccount(programKey, committedIdl), anchor: encodeAnchorAccount({ ...committedIdl, version: "0.0.1" }) },
      ({ url, ws }) => runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws })
    )
);

// Option B: legacy Anchor account as second diff site (senzenn Whirlpool gap).
await check(
  "legacy drift, canonical ok, fail-on-legacy-drift=false -> 0 + report kind",
  0,
  () =>
    withCase(
      { metadata: encodeMetadataAccount(programKey, committedIdl), anchor: encodeAnchorAccount({ ...committedIdl, version: "0.0.1" }) },
      async ({ url, ws }) => {
        const res = await runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws });
        if (res.code !== 0) return res;
        const report = JSON.parse(await fs.readFile(path.join(ws, "idl-drift-report.json"), "utf8"));
        if (report.rot?.kind !== "legacy_idl_drift") throw new Error(`kind=${report.rot?.kind}`);
        if (report.checks.diff?.status !== "ok") throw new Error(`canonical diff=${report.checks.diff?.status}`);
        if (report.checks.legacyAnchorDiff?.status !== "drift") throw new Error(`legacy=${report.checks.legacyAnchorDiff?.status}`);
        return res;
      }
    )
);

await check(
  "legacy drift, canonical ok, fail-on-legacy-drift=true -> 2",
  2,
  () =>
    withCase(
      { metadata: encodeMetadataAccount(programKey, committedIdl), anchor: encodeAnchorAccount({ ...committedIdl, version: "0.0.1" }) },
      ({ url, ws }) =>
        runEntry({ ...baseInputs, INPUT_RPC_URL: url, INPUT_FAIL_ON_LEGACY_DRIFT: "true", GITHUB_WORKSPACE: ws })
    )
);

await check(
  "both present and in sync, no legacy rot -> 0",
  0,
  () =>
    withCase(
      { metadata: encodeMetadataAccount(programKey, committedIdl), anchor: encodeAnchorAccount(committedIdl) },
      async ({ url, ws }) => {
        const res = await runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws });
        if (res.code !== 0) return res;
        const report = JSON.parse(await fs.readFile(path.join(ws, "idl-drift-report.json"), "utf8"));
        if (report.rot !== null) throw new Error(`rot=${JSON.stringify(report.rot)}`);
        if (report.checks.legacyAnchorDiff?.status !== "ok") throw new Error(`legacy=${report.checks.legacyAnchorDiff?.status}`);
        return res;
      }
    )
);

// Address derivation vectors, cross-checked against `solana find-program-derived-address`
// / `solana create-address-with-seed` outputs (the same fixtures senzenn/idl-drift uses).
const VECTORS = [
  ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "9fQgUeE2BpGXLHopvZhDKTskXV2druezgX6hpmscbya5", "2KFqE4RWoPVbvodo8vbggCFeHPS8TDvgpwp79ALMrcyn"],
  ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "A6Y3keWVgXiJcWXYhGYYEauYaepb9NzrF6PChVeKdDoj", "AYgC53tU5BbP2NAnv5nConJxAdpQZctvmZK88pu69xRs"],
  ["dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", "7DuBKBbixzCJEFgvAxpt7MCUuSwuY854iYJ4BLpzPEVt", "8BKPjRu7Hvd6Y2J67EdLx9MsrZFQwEMVwYg7NeVbAPF8"],
];
await check("derivation vectors match solana CLI", 0, async () => {
  for (const [program, md, an] of VECTORS) {
    const pk = base58Decode(program);
    const gotMd = base58Encode(metadataAddress(pk));
    const gotAn = base58Encode(anchorIdlAddress(pk));
    if (gotMd !== md) throw new Error(`metadata ${program}: ${gotMd} != ${md}`);
    if (gotAn !== an) throw new Error(`anchor ${program}: ${gotAn} != ${an}`);
  }
  return { code: 0 };
});

process.exit(failures === 0 ? 0 : 1);
