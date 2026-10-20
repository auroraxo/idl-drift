#!/usr/bin/env python3
"""Fallback for a missed GitHub Actions schedule in this repository.

Run after the 05:17 UTC ledger.yml GitHub schedule has had time to arrive.
If a scheduled ledger run exists for today's slot, do not create another.
If a successful manual run already refreshed the ledger after that slot,
there is nothing to do either. Otherwise dispatch, wait, and print the
GitHub run ID/URL to the OpenClaw automation run history. Requires `gh`
authenticated as the repository owner; no credentials are stored here.
"""
import datetime as dt
import json
import subprocess
import sys
import time

REPO = "auroraxo/idl-drift"
WORKFLOW = "ledger.yml"
UTC = dt.timezone.utc


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
