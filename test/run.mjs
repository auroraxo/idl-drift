#!/usr/bin/env node
// Offline test driver for idl-drift.
//
// Spawns src/index.mjs with env inputs and a local HTTP server that fakes
// the Solana JSON-RPC `getProgramAccounts` result, so no network needed.
//
// Cases:
//   1. no drift  — on-chain IDL equals committed IDL  -> exit 0
//   2. drift     — on-chain version changed           -> exit 2 (fail-on-drift)
//   3. missing   — no accounts returned               -> exit 0 (fail-on-missing=false)
//   4. missing   — same, fail-on-missing=true         -> exit 2

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "index.mjs");
const committedIdl = JSON.parse(
  await fs.readFile(path.join(here, "..", "testdata", "marinade_finance.json"), "utf8")
);

// Anchor IdlAccount borsh payload: 8-byte discriminator + u32 len + json bytes.
function encodeIdlAccount(idlJson) {
  const json = Buffer.from(JSON.stringify(idlJson), "utf8");
  const disc = Buffer.alloc(8, 0); // discriminator bytes not needed by our decoder
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  return Buffer.concat([disc, len, json]).toString("base64");
}

function makeServer(accounts) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        const result = accounts === null ? [] : accounts;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
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
      console.log(
        `FAIL ${name}: expected exit ${expect}, got ${JSON.stringify(got)}`
      );
      failures++;
    }
  } catch (err) {
    console.log(`FAIL ${name}: ${err}`);
    failures++;
  }
}

async function withCase(accounts, inputs, fn) {
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

const baseInputs = {
  INPUT_PROGRAM: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",
  INPUT_IDL: "idl.json",
};

await check(
  "no drift -> 0",
  0,
  () =>
    withCase([{ pubkey: "IdlAcc", account: { data: [encodeIdlAccount(committedIdl)] } }], {}, ({ url, ws }) =>
      runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws })
    )
);

await check(
  "drift -> 2",
  2,
  () =>
    withCase(
      [{ pubkey: "IdlAcc", account: { data: [encodeIdlAccount({ ...committedIdl, version: "9.9.9" })] } }],
      {},
      ({ url, ws }) => runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws })
    )
);

await check(
  "missing, fail-on-missing=false -> 0",
  0,
  () => withCase([], {}, ({ url, ws }) => runEntry({ ...baseInputs, INPUT_RPC_URL: url, GITHUB_WORKSPACE: ws }))
);

await check(
  "missing, fail-on-missing=true -> 2",
  2,
  () =>
    withCase([], {}, ({ url, ws }) =>
      runEntry({ ...baseInputs, INPUT_RPC_URL: url, INPUT_FAIL_ON_MISSING: "true", GITHUB_WORKSPACE: ws })
    )
);

process.exit(failures === 0 ? 0 : 1);
