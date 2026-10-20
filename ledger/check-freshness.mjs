#!/usr/bin/env node
// Freshness contract for the published ledger.
//
// Three failures on 2026-10-20 shared one shape: a public artifact stated a
// status that the evidence did not support — a drift row built from another
// program's IDL, a row linked to an org rename that 404s, a README paragraph
// claiming the schedule "never fired" hours after a successful schedule run.
// The table is generated; the prose around it is not, and nothing failed when
// the two disagreed.
//
// This check makes that disagreement a build failure. It compares the
// generated refresh-status block against the generated table footer and the
// generated HTML footer, and it fails when the ledger stops being refreshed at
// all. It reads files only — no network, no GitHub API — so it is as reliable
// as the ledger it guards.
//
// Usage: node ledger/check-freshness.mjs [--max-age <hours>] [--dir <path>]
//                                      [--now <iso>] [--json]
// Exit: 0 = consistent and fresh, 2 = a claim is contradicted or the ledger is
//       stale, 3 = usage error.

import { promises as fs } from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function argValue(flag) {
  const ix = argv.indexOf(flag);
  return ix >= 0 ? argv[ix + 1] : undefined;
}

const maxAgeRaw = argValue("--max-age") ?? "36";
const maxAgeHours = Number(maxAgeRaw);
const dir = argValue("--dir") ? path.resolve(argValue("--dir")) : here;
const nowRaw = argValue("--now");
const asJson = argv.includes("--json");

if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
  console.error("usage: node ledger/check-freshness.mjs [--max-age <hours>] [--dir <path>] [--now <iso>] [--json]");
  process.exit(3);
}
if (nowRaw !== undefined && Number.isNaN(Date.parse(nowRaw))) {
  console.error(`--now is not a date: ${nowRaw}`);
  process.exit(3);
}

const now = nowRaw !== undefined ? Date.parse(nowRaw) : Date.now();
const HOUR = 3_600_000;
const maxAgeMs = maxAgeHours * HOUR;
// A clock a minute or two ahead is normal jitter; an hour is a fabricated or
// badly skewed timestamp, which is the same class of problem this file exists
// to catch.
const futureToleranceMs = HOUR;

const MARK_START = "<!-- refresh-status:start -->";
const MARK_END = "<!-- refresh-status:end -->";
const ISO = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z";

const findings = [];

function fail(where, message) {
  findings.push({ where, message });
}

async function readOr(name) {
  try {
    return await fs.readFile(path.join(dir, name), "utf8");
  } catch (err) {
    fail(name, `not readable: ${err?.code ?? err?.message}`);
    return null;
  }
}

function firstIso(text) {
  const m = text.match(new RegExp(ISO));
  return m ? m[0] : null;
}

function blockOf(text) {
  const start = text.indexOf(MARK_START);
  const end = text.indexOf(MARK_END);
  if (start === -1) return { ok: false, reason: "start marker missing" };
  if (end === -1 || end < start) return { ok: false, reason: "end marker missing" };
  return { ok: true, body: text.slice(start + MARK_START.length, end) };
}

const readme = await readOr("README.md");
const html = await readOr("index.html");
// The repository README states the same refresh status in prose; when run.mjs
// maintains a block there, it is checked with everything else.
const rootReadmePath = path.join(path.dirname(dir), "README.md");
let rootReadme = null;
try {
  rootReadme = await fs.readFile(rootReadmePath, "utf8");
} catch {
  rootReadme = null;
}

let blockTs = null;
let footerTs = null;
let htmlTs = null;

if (readme) {
  // Generated table footer: _Last run: <iso> — …_
  const footer = readme.match(new RegExp(`_Last run: (${ISO})`));
  if (!footer) fail("README.md", "no generated '_Last run:' footer found");
  else footerTs = footer[1];

  const block = blockOf(readme);
  if (!block.ok) {
    fail("README.md", `refresh-status block: ${block.reason} (run.mjs must regenerate it; hand-written status cannot be trusted)`);
  } else {
    blockTs = firstIso(block.body);
    if (!blockTs) fail("README.md", "refresh-status block contains no timestamp to compare against the footer");
    else if (footerTs && blockTs !== footerTs) {
      fail("README.md", `refresh-status block says ${blockTs} but the generated footer says ${footerTs} — prose and data disagree`);
    }
  }
}

if (html) {
  const footer = html.match(new RegExp(`Last run: (${ISO})`));
  if (!footer) fail("index.html", "no generated 'Last run:' footer found");
  else htmlTs = footer[1];

  const block = blockOf(html);
  if (!block.ok) fail("index.html", `refresh-status block: ${block.reason}`);
}

if (htmlTs && footerTs && htmlTs !== footerTs) {
  fail("index.html", `published page says ${htmlTs} but the committed ledger says ${footerTs} — the page is serving a different run`);
}

if (rootReadme && rootReadme.includes(MARK_START)) {
  const block = blockOf(rootReadme);
  if (!block.ok) {
    fail("README.md (root)", `refresh-status block: ${block.reason}`);
  } else {
    const rootTs = firstIso(block.body);
    if (!rootTs) fail("README.md (root)", "refresh-status block contains no timestamp");
    else if (footerTs && rootTs !== footerTs) {
      fail("README.md (root)", `the prose says ${rootTs} but the ledger it describes was last run at ${footerTs} — the status sentence outran its data`);
    }
  }
}

const stamps = [blockTs, footerTs, htmlTs].filter(Boolean);
const newest = stamps.length ? stamps.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
const oldest = stamps.length ? stamps.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
let ageHours = null;
if (newest) {
  const age = now - Date.parse(newest);
  ageHours = Math.round((age / HOUR) * 100) / 100;
  if (age < -futureToleranceMs) {
    fail("freshness", `newest timestamp ${newest} is ${Math.round(-age / HOUR)}h in the future — a timestamp nobody ran`);
  } else if (age > maxAgeMs) {
    fail("freshness", `ledger is ${ageHours}h old (limit ${maxAgeHours}h) — the refresh path stopped, so every claim above is stale`);
  }
}
if (oldest && newest && oldest !== newest) {
  // Already reported per-file above; keep the summary honest rather than
  // silently reporting one number for disagreeing files.
  ageHours = null;
}

const summary = {
  ok: findings.length === 0,
  maxAgeHours,
  now: new Date(now).toISOString(),
  refreshStatusTimestamp: blockTs,
  readmeFooterTimestamp: footerTs,
  htmlFooterTimestamp: htmlTs,
  rootReadmeTimestamp: (() => {
    if (!rootReadme || !rootReadme.includes(MARK_START)) return null;
    const b = blockOf(rootReadme);
    return b.ok ? firstIso(b.body) : null;
  })(),
  ageHours,
  findings,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`ledger freshness: block ${blockTs ?? "-"} / README ${footerTs ?? "-"} / page ${htmlTs ?? "-"}`);
  console.log(`age ${ageHours === null ? "?" : ageHours}h (limit ${maxAgeHours}h)`);
  for (const f of findings) console.log(`FAIL ${f.where}: ${f.message}`);
  if (!findings.length) console.log("ledger freshness: generated status, generated footer and published page agree");
}

process.exit(findings.length ? 2 : 0);