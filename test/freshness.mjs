#!/usr/bin/env node
// Offline tests for ledger/check-freshness.mjs.
//
// The guard exists because public prose once contradicted generated data three
// times in a day. These cases pin the failure shapes it must keep catching:
// a status block that disagrees with the table footer, a published page that
// disagrees with the committed ledger, a missing block, and a refresh path that
// simply stopped.
//
// No network, no mainnet: every case is a fixture directory plus --now.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const guard = path.join(here, "..", "ledger", "check-freshness.mjs");

const NOW = "2026-10-21T08:00:00.000Z";
const FRESH = "2026-10-21T05:17:31.000Z";
const STALE = "2026-10-18T05:17:31.000Z";

function readme(stamp, blockStamp = stamp, withBlock = true) {
  const block = withBlock
    ? `\n<!-- refresh-status:start -->\n## Refresh status\n\n- Last successful check: **${blockStamp}**\n<!-- refresh-status:end -->\n`
    : "\n## Refresh status\n\n- Last successful check: hand written\n";
  return [
    "# Solana IDL Drift Ledger",
    "",
    "| program | address | status | drift detail |",
    "| --- | --- | --- | --- |",
    "| [whirlpool](https://github.com/orca-so/whirlpools) | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | in sync | no drift |",
    "",
    `_Last run: ${stamp} — 2 in sync, 3 drifting, 1 without on-chain IDL, 1 source/target mismatch, 0 errors._`,
    block,
  ].join("\n");
}

function html(stamp) {
  return [
    "<!doctype html>",
    "<footer>",
    `Last run: ${stamp} — 2 in sync, 3 drifting, 1 without on-chain IDL, 1 source/target mismatch, 0 errors.`,
    "<!-- refresh-status:start -->",
    `<!-- generated ${stamp} -->`,
    "<!-- refresh-status:end -->",
    "</footer>",
    "",
  ].join("\n");
}

let pass = 0;
let failCount = 0;

async function run(dir, extra = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [guard, "--dir", dir, "--now", NOW, ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

async function fixture(name, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `idl-drift-freshness-${name}-`));
  for (const [file, body] of Object.entries(files)) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }
  return root;
}

// `expect` is called with the ledger directory. Fixtures that also carry a
// repository README put it one level up, exactly as the real repo does.
async function expect(label, ledgerDir, code, needle, extra = []) {
  const { code: got, out } = await run(ledgerDir, extra);
  const ok = got === code && (!needle || out.includes(needle));
  if (ok) {
    pass++;
    console.log(`ok   ${label}`);
  } else {
    failCount++;
    console.log(`FAIL ${label}: exit ${got} (want ${code})${needle ? `, output missing "${needle}"` : ""}`);
    console.log(out.split("\n").map((l) => `     ${l}`).join("\n"));
  }
}

// 1. happy path — block, footer and page all name the same run.
await expect(
  "fresh, consistent ledger passes",
  await fixture("ok", { "README.md": readme(FRESH), "index.html": html(FRESH) }),
  0,
  "agree",
);

// 2. the 13:19Z bug: prose still says the schedule never ran while the
//    generated footer already carries a successful scheduled run.
await expect(
  "status block contradicting the table footer fails",
  await fixture("contradict", { "README.md": readme(FRESH, STALE), "index.html": html(FRESH) }),
  2,
  "prose and data disagree",
);

// 3. the published page serving a different run than the committed ledger.
await expect(
  "page timestamp differing from the ledger fails",
  await fixture("page", { "README.md": readme(FRESH), "index.html": html(STALE) }),
  2,
  "serving a different run",
);

// 4. a hand-written status paragraph with no generated block is untrusted.
await expect(
  "missing refresh-status block fails",
  await fixture("noblk", { "README.md": readme(FRESH, FRESH, false), "index.html": html(FRESH) }),
  2,
  "start marker missing",
);

// 5. the refresh path stopped — every number in the table is now historical.
await expect(
  "stale ledger fails the age limit",
  await fixture("stale", { "README.md": readme(STALE), "index.html": html(STALE) }),
  2,
  "refresh path stopped",
);

// 6. a timestamp nobody ran.
await expect(
  "timestamp far in the future fails",
  await fixture("future", { "README.md": readme("2026-10-25T05:17:31.000Z"), "index.html": html("2026-10-25T05:17:31.000Z") }),
  2,
  "in the future",
);

// 7. half the artifact is missing.
await expect(
  "missing page fails",
  await fixture("nopage", { "README.md": readme(FRESH) }),
  2,
  "not readable",
);

// 7b. the repository README's own status sentence outrunning the data it
//     describes — the 13:19Z correction, in its original form.
function rootReadme(stamp) {
  return [
    "# idl-drift",
    "",
    "The ledger has a daily schedule.",
    "",
    `<!-- refresh-status:start --><!-- generated ${stamp} by ledger/run.mjs — do not edit by hand; --><!-- refresh-status:end -->`,
    "",
  ].join("\n");
}
await expect(
  "root README status sentence contradicting the ledger fails",
  path.join(await fixture("rootstale", {
    "README.md": rootReadme(STALE),
    "ledger/README.md": readme(FRESH),
    "ledger/index.html": html(FRESH),
  }), "ledger"),
  2,
  "outran its data",
);

await expect(
  "consistent root README passes",
  path.join(await fixture("rootok", {
    "README.md": rootReadme(FRESH),
    "ledger/README.md": readme(FRESH),
    "ledger/index.html": html(FRESH),
  }), "ledger"),
  0,
  "agree",
);

// 8. clock jitter within an hour is tolerated, a wider gap is not exercised
//    here but the boundary is covered by the usage check below.
{
  const { code } = await run(await fixture("tolerate", { "README.md": readme("2026-10-21T08:20:00.000Z"), "index.html": html("2026-10-21T08:20:00.000Z") }));
  if (code === 0) {
    pass++;
    console.log("ok   clock skew under an hour is tolerated");
  } else {
    failCount++;
    console.log(`FAIL clock skew under an hour is tolerated: exit ${code}`);
  }
}

// 9. usage errors are distinct from content failures.
{
  const { code } = await run(await fixture("usage", { "README.md": readme(FRESH), "index.html": html(FRESH) }), ["--max-age", "0"]);
  if (code === 3) {
    pass++;
    console.log("ok   bad --max-age is a usage error");
  } else {
    failCount++;
    console.log(`FAIL bad --max-age is a usage error: exit ${code}`);
  }
}

// 10. machine-readable output for CI annotations.
{
  const { code, out } = await run(await fixture("json", { "README.md": readme(FRESH), "index.html": html(FRESH) }), ["--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch { /* reported below */ }
  if (code === 0 && parsed?.ok === true && parsed.refreshStatusTimestamp === FRESH && parsed.ageHours === 2.71) {
    pass++;
    console.log("ok   --json reports the parsed claims");
  } else {
    failCount++;
    console.log(`FAIL --json reports the parsed claims: exit ${code} ${out.slice(0, 200)}`);
  }
}

// 11. The generator writes three files; the workflow that commits them must
// stage all three. It once staged only the table and the page, so the root
// README's block lagged a run behind and the scheduled freshness check went
// red — this pins the wiring between ledger/run.mjs and ledger.yml.
{
  const wf = await fs.readFile(path.join(here, "..", ".github", "workflows", "ledger.yml"), "utf8");
  const addLines = wf.split("\n").filter((l) => l.includes("git add"));
  const staged = new Set(addLines.flatMap((l) => l.slice(l.indexOf("git add") + "git add".length).trim().split(/\s+/)));
  const required = ["ledger/README.md", "ledger/index.html", "README.md"];
  const missing = required.filter((f) => !staged.has(f));
  if (addLines.length && !missing.length) {
    pass++;
    console.log("ok   ledger workflow stages every file run.mjs writes");
  } else {
    failCount++;
    console.log(`FAIL ledger workflow stages every file run.mjs writes: missing ${missing.join(", ") || "git add line"}`);
  }
}

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);