#!/usr/bin/env node
// Ledger driver: runs src/index.mjs against every entry in ledger/programs.json
// against live mainnet, collects each per-program report, and renders
// ledger/README.md — the public Solana IDL drift ledger.
//
// Design: one file, no dependencies, reuses the action entrypoint via child
// process so the ledger and the CI check can never diverge.
//
// Usage: node ledger/run.mjs [--workspace <dir>]

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const entry = path.join(root, "src", "index.mjs");
const targetsPath = path.join(here, "programs.json");
const reportName = "idl-drift-report.json";

const argv = process.argv.slice(2);
const workspaceIx = argv.indexOf("--workspace");
const workspace = workspaceIx >= 0 ? path.resolve(argv[workspaceIx + 1]) : await fs.mkdtemp(path.join("/tmp", "idl-drift-ledger-"));
await fs.mkdir(workspace, { recursive: true });

const targets = JSON.parse(await fs.readFile(targetsPath, "utf8"));

async function runOne(t) {
  // Resolve the committed IDL into the scratch workspace. `source` is a URL
  // (fetched as-is) or a repo-relative path (copied).
  const idlPath = path.join(workspace, `${t.name}.json`);
  if (/^https?:/.test(t.idl)) {
    const r = await fetch(t.idl);
    if (!r.ok) {
      return { ...t, status: "idl_source_error", detail: `IDL source HTTP ${r.status}` };
    }
    await fs.writeFile(idlPath, await r.text());
  } else {
    await fs.copyFile(path.join(root, t.idl), idlPath);
  }

  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [entry], {
      cwd: workspace,
      env: (() => {
        // src/index.mjs prefers GITHUB_WORKSPACE over IDL_DRIFT_WORKSPACE; on a
        // runner that would point the child at the repo checkout instead of the
        // scratch dir. Strip it so the scratch workspace wins.
        const childEnv = { ...process.env };
        delete childEnv.GITHUB_WORKSPACE;
        childEnv.IDL_DRIFT_WORKSPACE = workspace;
        childEnv.INPUT_PROGRAM = t.program;
        childEnv.INPUT_IDL = `${t.name}.json`;
        childEnv.INPUT_RPC_URL = "mainnet";
        childEnv.INPUT_FAIL_ON_DRIFT = "false";
        childEnv.INPUT_FAIL_ON_MISSING = "false";
        childEnv.INPUT_FAIL_ON_LEGACY_DRIFT = "false";
        return childEnv;
      })(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", resolve);
    p.on("error", () => resolve(1));
    void err;
  });

  let report = null;
  let parseErr = null;
  try {
    const raw = await fs.readFile(path.join(workspace, reportName), "utf8");
    report = JSON.parse(raw);
  } catch (err) {
    parseErr = err;
  }
  if (!report) {
    return { ...t, status: "no_report", detail: `exit ${code} parse=${parseErr?.message ?? "?"}` };
  }
  const kind = report.rot?.kind ?? "ok";
  const status = report.rot ? kind : "ok";
  const detail = report.rot?.detail ?? (report.unresolvable[0]?.detail ?? "no drift");
  return {
    ...t,
    status,
    detail,
    onChain: report.checks.onChainIdlAccount?.address ?? null,
    onChainSource: report.checks.onChainIdlAccount?.source ?? null,
    legacy: report.checks.legacyAnchorDiff?.status ?? "skipped",
    differences: report.rot?.differences ?? [],
  };
}

const results = [];
for (const t of targets) {
  process.stdout.write(`checking ${t.name} (${t.program})… `);
  const r = await runOne(t);
  console.log(r.status);
  results.push(r);
}

const now = new Date();
const drifted = results.filter((r) => r.status.startsWith("idl_drift") || r.status === "legacy_idl_drift");
const missing = results.filter((r) => r.status === "on_chain_idl_missing");
const errored = results.filter((r) => ["idl_source_error", "no_report"].includes(r.status));
const clean = results.filter((r) => r.status === "ok");

function row(r) {
  const badge =
    r.status === "ok" ? "✅ in sync" :
    r.status === "on_chain_idl_missing" ? "⚪ no on-chain IDL" :
    r.status.startsWith("legacy") ? "🟡 legacy drift" :
    errored.includes(r) ? "⚠️ error" : "🔴 drift";
  const diff = r.differences?.length
    ? r.differences.map((d) => `\`${d.field}\`${d.entry ? `.${d.entry}` : ""}`).join(", ")
    : r.detail;
  return `| [${r.name}](${r.repo ?? r.idl}) | \`${r.program}\` | ${badge} | ${diff} |`;
}

const lines = [
  "# Solana IDL Drift Ledger",
  "",
  "Live check: for each program below, the committed/published Anchor IDL",
  "(npm or GitHub source) is diffed against the program's **on-chain IDL",
  "account** on mainnet, using [auroraxo/idl-drift](../README.md).",
  "This is the raw material: every row here was produced by a real check,",
  "not copied from a report.",
  "",
  "| program | address | status | drift detail |",
  "| --- | --- | --- | --- |",
  ...results.map(row),
  "",
  `_Last run: ${now.toISOString()} — ${clean.length} in sync, ${drifted.length} drifting, ${missing.length} without on-chain IDL, ${errored.length} errors._`,
  "",
  "## Provenance",
  "",
  "- Workflow: [`.github/workflows/ledger.yml`](../blob/master/.github/workflows/ledger.yml)",
  "- Program list: [`ledger/programs.json`](./programs.json)",
  "- Findings corroborated by external review: [MarinadeFinance/marinade-ts-sdk#111](https://github.com/MarinadeFinance/marinade-ts-sdk/issues/111)",
];

await fs.writeFile(path.join(here, "README.md"), lines.join("\n") + "\n");

// Public page: same data, plain HTML, no JS — served straight from GitHub
// Pages at /ledger/.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rows = results.map((r) => {
  const badge =
    r.status === "ok" ? '<span class="ok">in sync</span>' :
    r.status === "on_chain_idl_missing" ? '<span class="miss">no on-chain IDL</span>' :
    r.status.startsWith("legacy") ? '<span class="warn">legacy drift</span>' :
    r.status === "ok" ? "" : '<span class="bad">drift</span>';
  const diff = r.differences?.length
    ? r.differences.map((d) => `<code>${esc(d.field)}${d.entry ? "." + esc(d.entry) : ""}</code>`).join(", ")
    : esc(r.detail);
  const name = r.repo
    ? `<a href="${esc(r.repo)}">${esc(r.name)}</a>`
    : esc(r.name);
  return `<tr><td>${name}</td><td><code>${esc(r.program)}</code></td><td>${badge}</td><td>${diff}</td></tr>`;
});
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Solana IDL Drift Ledger</title>
<style>
body{font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:2rem auto;max-width:70rem;padding:0 1rem;color:#1f2328}
h1{font-size:1.4rem}a{color:#0969da}.ok{color:#1a7f37}.bad{color:#cf222e}.warn{color:#9a6700}.miss{color:#57606a}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-bottom:1px solid #d0d7de;padding:.5rem;text-align:left;vertical-align:top}
th{background:#f6f8fa}code{font-size:12px}footer{color:#57606a;font-size:12px;margin-top:1.5rem}
</style></head><body>
<h1>Solana IDL Drift Ledger</h1>
<p>Each row is a live diff of a published Anchor IDL against the program’s
on-chain IDL account on mainnet, run by
<a href="https://github.com/auroraxo/idl-drift">auroraxo/idl-drift</a>.</p>
<table><thead><tr><th>program</th><th>address</th><th>status</th><th>drift detail</th></tr></thead>
<tbody>${rows.join("\n")}</tbody></table>
<footer>Last run: ${now.toISOString()} — ${clean.length} in sync, ${drifted.length} drifting, ${missing.length} without on-chain IDL, ${errored.length} errors.
Source: <a href="https://github.com/auroraxo/idl-drift/blob/master/ledger/programs.json">programs.json</a></footer>
</body></html>\n`;
await fs.writeFile(path.join(here, "index.html"), html);
console.log(`ledger README + index.html written: ${clean.length} ok / ${drifted.length} drift / ${missing.length} missing / ${errored.length} error`);
