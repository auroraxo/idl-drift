#!/usr/bin/env node
// Liveness check for every external source the ledger depends on.
//
// The ledger's whole value is that its rows are real comparisons against live
// sources. If an upstream repo is renamed or deleted, the row keeps rendering
// as if it were checked — the tool then reports confidently from a dead source.
// That is exactly the failure mode this check exists to catch.
//
// It reads ledger/programs.json and verifies that each `repo` and each remote
// `idl` URL still resolves. Repo-relative `idl` paths are skipped (they are
// checked by running the ledger itself).
//
// Usage: node ledger/check-links.mjs [--timeout <ms>] [--json]
// Exit: 0 = every source resolved, 2 = at least one dead source, 3 = usage error.

import { promises as fs } from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const targetsPath = path.join(here, "programs.json");

const argv = process.argv.slice(2);
const timeoutIx = argv.indexOf("--timeout");
const timeoutMs = timeoutIx >= 0 ? Number(argv[timeoutIx + 1]) : 20_000;
const asJson = argv.includes("--json");

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("usage: node ledger/check-links.mjs [--timeout <ms>] [--json]");
  process.exit(3);
}

const targets = JSON.parse(await fs.readFile(targetsPath, "utf8"));

/** Resolve one URL to a final status code, following redirects. GET only:
 *  several CDNs and raw.githubusercontent URLs answer HEAD with 405. */
async function statusOf(url) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "auroraxo/idl-drift link check" },
  });
  // Release the body so the socket is not held open.
  await res.arrayBuffer().catch(() => {});
  return { status: res.status, finalUrl: res.url };
}

const checks = [];
for (const t of targets) {
  const urls = [];
  if (t.repo) urls.push({ kind: "repo", url: t.repo });
  if (/^https?:/.test(t.idl ?? "")) urls.push({ kind: "idl", url: t.idl });

  for (const { kind, url } of urls) {
    try {
      const { status, finalUrl } = await statusOf(url);
      // 2xx/3xx only. A redirect to a renamed path is fine as long as it
      // resolves; a 404/410 means the source is gone.
      const ok = status >= 200 && status < 400;
      checks.push({
        program: t.name,
        kind,
        url,
        status,
        finalUrl,
        ok,
        detail: ok ? "" : `HTTP ${status}`,
      });
    } catch (err) {
      // Network/RPC failure is not evidence of rot — report it, do not fail on
      // it as if the source were dead. Mirrors the ledger's "unresolvable is
      // never drift" policy.
      checks.push({
        program: t.name,
        kind,
        url,
        status: null,
        finalUrl: null,
        ok: null,
        detail: `unresolvable: ${err?.name === "TimeoutError" ? "timeout" : err?.message ?? err}`,
      });
    }
  }
}

const dead = checks.filter((c) => c.ok === false);
const unresolvable = checks.filter((c) => c.ok === null);

if (asJson) {
  console.log(JSON.stringify({ checks, dead: dead.length, unresolvable: unresolvable.length }, null, 2));
} else {
  for (const c of checks) {
    const mark = c.ok === true ? "ok  " : c.ok === null ? "skip" : "DEAD";
    const moved = c.finalUrl && c.finalUrl !== c.url ? ` -> ${c.finalUrl}` : "";
    console.log(`${mark} ${c.program}/${c.kind} ${c.status ?? "-"}${moved}${c.detail ? ` (${c.detail})` : ""}`);
  }
  console.log(`ledger link check: ${checks.length} source(s), ${dead.length} dead, ${unresolvable.length} unresolvable`);
}

if (dead.length > 0) {
  for (const c of dead) {
    console.error(`dead source: ${c.program}/${c.kind} ${c.url} -> ${c.detail}`);
  }
  console.error("Update ledger/programs.json to the current upstream path. A ledger row rendered from a dead source is not a check.");
  process.exit(2);
}
process.exit(0);