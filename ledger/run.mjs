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

  let sourceIdl;
  try {
    sourceIdl = JSON.parse(await fs.readFile(idlPath, "utf8"));
  } catch (err) {
    return { ...t, status: "idl_source_error", detail: `source IDL is not JSON: ${err.message}` };
  }
  if (typeof sourceIdl.address === "string" && sourceIdl.address !== t.program) {
    return { ...t, status: "source_program_mismatch",
      detail: `source IDL declares ${sourceIdl.address}; requested program is ${t.program}; no on-chain comparison made` };
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
    scope: report.rot?.scope ?? null,
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
// A rename is a real difference and not a layout break. Counting it as
// "drifting" would overstate the impact in the same way the retracted Drift
// row did, so the two are counted and named separately.
const labelsOnly = drifted.filter((r) => r.scope === "labels-only");
const layoutDrift = drifted.filter((r) => r.scope !== "labels-only");
const missing = results.filter((r) => r.status === "on_chain_idl_missing");
const mismatched = results.filter((r) => r.status === "source_program_mismatch");
const mismatchLabel = `${mismatched.length} source/target mismatch${mismatched.length === 1 ? "" : "es"}`;
const errored = results.filter((r) => ["idl_source_error", "no_report"].includes(r.status));
const clean = results.filter((r) => r.status === "ok");

function row(r) {
  const badge =
    r.status === "ok" ? "✅ in sync" :
    r.status === "on_chain_idl_missing" ? "⚪ no on-chain IDL" :
    r.status.startsWith("legacy") ? "🟡 legacy drift" :
    r.status === "source_program_mismatch" ? "⚠️ source/target mismatch" :
    errored.includes(r) ? "⚠️ error" :
    r.scope === "labels-only" ? "🟣 labels only" : "🔴 drift";
  const diff = r.differences?.length
    ? r.differences.map((d) => `\`${d.field}\`${d.entry ? `.${d.entry}` : ""}`).join(", ")
    : r.detail;
  return `| [${r.name}](${r.repo ?? r.idl}) | \`${r.program}\` | ${badge} | ${diff} |`;
}

const stamp = now.toISOString();
const summaryLine = `${clean.length} in sync, ${layoutDrift.length} drifting, ${labelsOnly.length} labels only, ${missing.length} without on-chain IDL, ${mismatchLabel}, ${errored.length} errors`;
// Marker pair shared with ledger/check-freshness.mjs and the root README.
const MARK_START = "<!-- refresh-status:start -->";
const MARK_END = "<!-- refresh-status:end -->";
// The status block is generated from the same run as the table below it, so
// the prose can never claim a check the data does not contain — the failure
// mode that produced three public corrections on 2026-10-20. Its freshness is
// enforced by ledger/check-freshness.mjs, not by remembering to edit it.
const statusLines = [
  MARK_START,
  "## Refresh status",
  "",
  `Generated by \`ledger/run.mjs\` from this run, not written by hand.`,
  "",
  `- Last successful check: **${stamp}** (live mainnet)`,
  `- Result: ${summaryLine}`,
  `- Refresh cadence: daily \`17 5 * * *\` UTC, with [ledger/ensure-refresh.py](./ensure-refresh.py) as fallback dispatcher.`,
  `- \`ledger/check-freshness.mjs\` fails CI if this block, the table footer below, or the published page disagree, or if the ledger is older than 36h.`,
  "",
  MARK_END,
];

const lines = [
  "# Solana IDL Drift Ledger",
  "",
  "Live check: for each program below, the committed/published Anchor IDL",
  "(npm or GitHub source) is checked against the requested program address.",
  "Matching sources are diffed against that program's **on-chain IDL account**",
  "on mainnet, using [auroraxo/idl-drift](../README.md). Mismatched sources",
  "are flagged without an on-chain comparison. Every row is produced by a",
  "real check, not copied from a report.",
  "",
  "| program | address | status | drift detail |",
  "| --- | --- | --- | --- |",
  ...results.map(row),
  "",
  `_Last run: ${stamp} — ${summaryLine}_`,
  "",
  ...statusLines,
  "",
  "## Correction (2026-10-20)",
  "",
  "The earlier ledger counted **drift** for `dRiftyHA39…` by comparing it with a",
  "moving `@drift-labs/sdk` IDL declaring **another program**, `vELoC1…`.",
  "That comparison did not prove drift for the requested program. It is now",
  "marked as a source/target mismatch, not an upstream finding.",
  "",
  "## Provenance",
  "",
  "- Workflow: [`.github/workflows/ledger.yml`](../blob/master/.github/workflows/ledger.yml)",
  "- Program list: [`ledger/programs.json`](./programs.json)",
  "- Related upstream report: [marinade-finance/marinade-ts-sdk#111](https://github.com/marinade-finance/marinade-ts-sdk/issues/111)",
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
    r.status === "source_program_mismatch" ? '<span class="warn">source/target mismatch</span>' :
    r.scope === "labels-only" ? '<span class="label">labels only</span>' : '<span class="bad">drift</span>';
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
h1{font-size:1.4rem}a{color:#0969da}.ok{color:#1a7f37}.bad{color:#cf222e}.warn{color:#9a6700}.miss{color:#57606a}.label{color:#6639ba}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-bottom:1px solid #d0d7de;padding:.5rem;text-align:left;vertical-align:top}
th{background:#f6f8fa}code{font-size:12px}footer{color:#57606a;font-size:12px;margin-top:1.5rem}
</style></head><body>
<h1>Solana IDL Drift Ledger</h1>
<p>Each row checks a published Anchor IDL against the requested program
address. Matching IDLs are diffed against that program’s on-chain IDL account
on mainnet; sources for another program are flagged without a diff. Run by
<a href="https://github.com/auroraxo/idl-drift">auroraxo/idl-drift</a>.</p>
<table><thead><tr><th>program</th><th>address</th><th>status</th><th>drift detail</th></tr></thead>
<tbody>${rows.join("\n")}</tbody></table>
<p><strong>Correction (2026-10-20):</strong> The earlier ledger counted
<code>dRiftyHA39…</code> as drift by comparing it against a moving SDK IDL
for the different program <code>vELoC1…</code>. That was not a valid drift
finding; the row now identifies the source/target mismatch.</p>
<footer>Last run: ${stamp} — ${summaryLine}.
<!-- refresh-status:start -->
<!-- generated from this run: ${stamp} -->
<!-- refresh-status:end -->
Source: <a href="https://github.com/auroraxo/idl-drift/blob/master/ledger/programs.json">programs.json</a></footer>
</body></html>\n`;
await fs.writeFile(path.join(here, "index.html"), html);
console.log(`ledger README + index.html written: ${clean.length} ok / ${layoutDrift.length} drift / ${labelsOnly.length} labels-only / ${missing.length} missing / ${mismatched.length} source mismatch / ${errored.length} error`);

// The repository README describes the same refresh path in prose. That prose
// went stale three times on 2026-10-20 while the table beside it was accurate,
// so its status sentence is generated here from this run and guarded by
// ledger/check-freshness.mjs instead of being written by hand.
const rootReadmePath = path.join(root, "README.md");
const statusBlock = [
  MARK_START,
  `<!-- generated ${stamp} by ledger/run.mjs — do not edit by hand; -->`,
  `<!-- ${summaryLine} -->`,
  `<!-- ${clean.length} of ${results.length} checked programs are in sync -->`,
  MARK_END,
].join("\n");

try {
  const rootReadme = await fs.readFile(rootReadmePath, "utf8");
  const start = rootReadme.indexOf(MARK_START);
  const end = rootReadme.indexOf(MARK_END);
  if (start !== -1 && end > start) {
    const next = rootReadme.slice(0, start) + statusBlock + rootReadme.slice(end + MARK_END.length);
    if (next !== rootReadme) {
      await fs.writeFile(rootReadmePath, next);
      console.log("root README refresh status block refreshed");
    }
  } else {
    console.log("root README has no refresh-status block; left untouched");
  }
} catch (err) {
  // The ledger is still valid without it; the freshness check reports it.
  console.log(`root README not updated: ${err?.message}`);
}
