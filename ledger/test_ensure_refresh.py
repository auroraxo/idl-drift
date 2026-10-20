"""Regression tests for the missed GitHub Actions schedule backstop."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
import pathlib
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).with_name("ensure-refresh.py")
spec = importlib.util.spec_from_file_location("ledger_fallback", SCRIPT)
fallback = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fallback)
SLOT = "2026-10-20T05:17:00Z"


def run(number, event, status="completed", conclusion="success", created=SLOT):
    return {"id": number, "event": event, "status": status, "conclusion": conclusion,
            "created_at": created, "html_url": f"https://github.com/auroraxo/idl-drift/actions/runs/{number}"}


class FixedDateTime(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 20, 7, 2, tzinfo=tz)


class LateDateTime(dt.datetime):
    """Past the measured 8h delivery envelope (slot 05:17 + 8h = 13:17)."""

    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 20, 14, 0, tzinfo=tz)


class EnsureRefreshTests(unittest.TestCase):
    def check(self, records, gh=None):
        with patch.object(fallback.dt, "datetime", FixedDateTime), \
             patch.object(fallback, "runs", return_value=records), \
             patch.object(fallback, "gh", side_effect=gh) as call, \
             contextlib.redirect_stdout(io.StringIO()):
            fallback.main()
        return call

    def test_github_schedule_succeeded_no_dispatch(self):
        call = self.check([run(12, "schedule")])
        call.assert_not_called()

    def test_github_schedule_queued_no_dispatch(self):
        call = self.check([run(12, "schedule", "queued", None)])
        call.assert_not_called()

    def test_manual_success_after_slot_no_dispatch(self):
        call = self.check([run(13, "workflow_dispatch", created="2026-10-20T07:31:00Z")])
        call.assert_not_called()

    def test_manual_failure_does_not_spin_retry(self):
        with self.assertRaisesRegex(RuntimeError, "inspect instead of retrying"):
            self.check([run(13, "workflow_dispatch", conclusion="failure")])

    def test_within_delivery_envelope_not_judged_a_miss(self):
        """No run yet at 07:02 is normal here: schedules arrive +4h46m..+7h10m late."""
        with patch.object(fallback.dt, "datetime", FixedDateTime), \
             patch.object(fallback, "runs", return_value=[]), \
             patch.object(fallback, "gh") as gh_call, \
             contextlib.redirect_stdout(io.StringIO()) as out:
            fallback.main()
        gh_call.assert_not_called()
        self.assertIn("not judged a miss, no dispatch", out.getvalue())

    def test_before_slot_floor_still_raises_too_early(self):
        class EarlyDateTime(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 20, 5, 30, tzinfo=tz)

        with patch.object(fallback.dt, "datetime", EarlyDateTime), \
             patch.object(fallback, "runs", return_value=[]):
            with self.assertRaisesRegex(RuntimeError, "Too early"):
                fallback.main()

    def test_missed_slot_dispatches_and_verifies_success(self):
        new = run(14, "workflow_dispatch", created="2026-10-20T14:00:30Z")
        api_calls = []

        def fake_gh(*args):
            api_calls.append(args)
            if args[:2] == ("workflow", "run"):
                return ""
            if "actions/runs/14" in args[-1]:
                return json.dumps(new)
            raise AssertionError(args)

        with patch.object(fallback.dt, "datetime", LateDateTime), \
             patch.object(fallback, "runs", side_effect=[[], [new]]), \
             patch.object(fallback.time, "sleep"), \
             patch.object(fallback, "gh", side_effect=fake_gh), \
             contextlib.redirect_stdout(io.StringIO()):
            fallback.main()
        self.assertTrue(any(args[:2] == ("workflow", "run") for args in api_calls))

    def test_grace_override_shortens_the_window(self):
        """LEDGER_GRACE_MINUTES / GRACE_MINUTES is the one knob that gates dispatch."""
        new = run(15, "workflow_dispatch", created="2026-10-20T07:02:30Z")
        dispatched = []

        def fake_gh(*args):
            if args[:2] == ("workflow", "run"):
                dispatched.append(args)
                return ""
            raise AssertionError(args)

        with patch.object(fallback, "GRACE_MINUTES", 45), \
             patch.object(fallback.dt, "datetime", FixedDateTime), \
             patch.object(fallback, "runs", side_effect=[[], [new]]), \
             patch.object(fallback.time, "sleep"), \
             patch.object(fallback, "gh", side_effect=fake_gh), \
             contextlib.redirect_stdout(io.StringIO()):
            fallback.main()
        self.assertTrue(dispatched)


if __name__ == "__main__":
    unittest.main()
