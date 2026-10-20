#!/usr/bin/env python3
"""Fallback for a missed GitHub Actions schedule in this repository.

Run after the 05:17 UTC ledger.yml GitHub schedule has had time to arrive.
If a scheduled ledger run exists for today's slot, do not create another.
If a successful manual run already refreshed the ledger after that slot,
there is nothing to do either. Otherwise dispatch, wait, and print the
GitHub run ID/URL to the OpenClaw automation run history. Requires `gh`
authenticated as the repository owner; no credentials are stored here.

DELAY REALITY (measured on this account 2026-10-20; do not shrink the
window without re-measuring): scheduled runs here do not arrive at their
cron minute, they arrive hours late -
  ledger.yml    05:17Z slot -> run 10:02:54Z (+4h46m) on 20.10
  examples.yml  Mon 03:37Z   -> run 09:15:37Z (+5h38m) on 19.10
  docrot-check  Mon 06:17Z   -> run 13:27:30Z (+7h10m) on 19.10,
                               run 11:36:54Z (+5h20m) on 15.10
Reference repos on the same days started within seconds to minutes
(rust-lang/rust daily cron +29s; microsoft/vscode '17 5 * * *' +10m), so
this is account-side queueing, not a GitHub-wide outage.

Consequence: a guard that declares "missed" after a few dozen minutes
asserts more than it proves - it reads as "the schedule did not fire" while
GitHub's run is still queued, which is the exact failure class this project
keeps correcting in its public artifacts. Dispatch is therefore gated on
GRACE_MINUTES (default 8h, above the observed +7h10m maximum; override via
LEDGER_GRACE_MINUTES). Before the window the script reports "not yet due" and
exits 0, because the OpenClaw automation runs it once a day at 06:07Z and a
non-zero exit would raise a Telegram alert for an expected state.

Backstop for a genuinely dead schedule: this script is invoked once a day,
and the daily 14:04Z producer pulse re-runs it after the window and
dispatches if nothing arrived; freshness.yml turns a ledger older than 36h
red either way.
"""
import datetime as dt
import json
import os
import subprocess
import sys
import time

REPO = "auroraxo/idl-drift"
WORKFLOW = "ledger.yml"
UTC = dt.timezone.utc
# Measured envelope: worst observed delivery delay was +7h10m (docrot-check
# weekly cron, 19.10). 8h leaves ~50 minutes of margin above that.
GRACE_MINUTES = int(os.environ.get("LEDGER_GRACE_MINUTES", "480"))


def gh(*args):
    result = subprocess.run(["gh", *args], text=True, capture_output=True, timeout=40)
    if result.returncode:
        raise RuntimeError(f"gh {' '.join(args[:3])} failed: {result.stderr.strip()[-600:]}")
    return result.stdout


def runs():
    response = gh("api", "-X", "GET",
                  f"repos/{REPO}/actions/workflows/{WORKFLOW}/runs?per_page=40")
    return json.loads(response)["workflow_runs"]


def run_key(run):
    return dt.datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))


def main():
    now = dt.datetime.now(UTC)
    slot = now.replace(hour=5, minute=17, second=0, microsecond=0)
    window_end = slot + dt.timedelta(minutes=GRACE_MINUTES)
    if now < slot + dt.timedelta(minutes=45):
        raise RuntimeError("Too early for a missing-schedule fallback (allow GitHub 45 minutes)")
    today = sorted((r for r in runs() if run_key(r) >= slot), key=run_key, reverse=True)
    scheduled = [r for r in today if r["event"] == "schedule"]
    if scheduled:
        last = scheduled[0]
        print(f"GitHub schedule exists: {last['id']} {last['status']} {last['conclusion']} {last['html_url']}")
        if last["status"] != "completed" or last["conclusion"] == "success":
            return
        print("GitHub's scheduled run failed; checking for a fallback dispatch.")
    dispatched = [r for r in today if r["event"] == "workflow_dispatch"]
    if dispatched:
        last = dispatched[0]
        print(f"Workflow dispatch already exists since this slot: {last['id']} {last['html_url']}")
        if last["status"] != "completed" or last["conclusion"] == "success":
            return
        raise RuntimeError(f"Existing dispatch run {last['id']} failed: {last['conclusion']}; inspect instead of retrying blindly")
    before = {r["id"] for r in today}
    if now < window_end:
        print(f"GitHub schedule for {slot:%Y-%m-%dT%H:%MZ} has not arrived yet; the measured "
              f"delivery envelope allows it until {window_end:%H:%MZ} (+4h46m..+7h10m observed "
              f"on this account); not judged a miss, no dispatch.")
        return
    gh("workflow", "run", WORKFLOW, "-R", REPO, "--ref", "master")
    print("Missed schedule; dispatched the ledger workflow.", flush=True)
    run = None
    for attempt in range(12):
        time.sleep(5)
        matching = [r for r in runs() if r["id"] not in before and r["event"] == "workflow_dispatch"]
        if matching:
            run = sorted(matching, key=run_key, reverse=True)[0]
            break
    if run is None:
        raise RuntimeError("Dispatch accepted but no workflow run appeared within 60 seconds")
    print(f"Fallback run {run['id']} {run['html_url']}", flush=True)
    for attempt in range(45):
        if run["status"] == "completed":
            if run["conclusion"] != "success":
                raise RuntimeError(f"Fallback run {run['id']} finished: {run['conclusion']}")
            print(f"Refresh verified: run {run['id']} success {run['html_url']}")
            return
        time.sleep(8)
        response = gh("api", "-X", "GET", f"repos/{REPO}/actions/runs/{run['id']}")
        run = json.loads(response)
    raise RuntimeError(f"Fallback run {run['id']} did not finish within 6 minutes")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ledger fallback FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
