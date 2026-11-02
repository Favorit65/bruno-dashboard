import contextlib
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import fetch_bruno as fetch


class RefreshTest(unittest.TestCase):
    def test_hourly_refresh_finds_early_completion_in_old_monthly_window(self):
        now = datetime.now(timezone.utc)
        old = (now - timedelta(days=14)).date().isoformat()
        closed = (now - timedelta(days=15)).date().isoformat()
        today = now.date().isoformat()
        with tempfile.TemporaryDirectory(dir=BASE/'tests') as temp:
            archive = Path(temp)
            manifest = fetch.Manifest(archive/'manifest.json')
            manifest.data['days'] = {
                old: {'complete': True, 'fetchedAt': (now-timedelta(days=13)).isoformat(),
                      'openDeadlines': [(now+timedelta(days=14)).isoformat()]},
                closed: {'complete': True, 'fetchedAt': now.isoformat(), 'openDeadlines': None},
            }
            manifest.save()
            api = type('API', (), {'requests_made': 0})()
            counts = {'taskPlan': 1, 'statByZone': 0, 'statByEmployee': 0, 'statByTeam': 0, 'openDeadlines': None}
            with patch.object(fetch, 'fetch_day', side_effect=lambda *args: (dict(counts), {}, None)) as call, contextlib.redirect_stdout(io.StringIO()):
                fetch.mode_fetch(api, archive, [today], 'slim', 500, 2, False, recent_only=True)
            self.assertEqual([c.args[2] for c in call.call_args_list], [old, today])
            # The now-completed old day no longer needs to be fetched next hour.
            with patch.object(fetch, 'fetch_day', side_effect=lambda *args: (dict(counts), {}, None)) as call, contextlib.redirect_stdout(io.StringIO()):
                fetch.mode_fetch(api, archive, [today], 'slim', 500, 2, False, recent_only=True)
            self.assertEqual([c.args[2] for c in call.call_args_list], [today])

    def test_expired_window_remains_in_nightly_deadline_reconciliation(self):
        now = datetime.now(timezone.utc)
        m = fetch.Manifest(BASE/'tests'/'nonexistent-manifest.json')
        m.data['days']['2026-01-01'] = {
            'openDeadlines': [(now-timedelta(days=3)).isoformat()],
            'fetchedAt': (now-timedelta(days=4)).isoformat(),
        }
        self.assertFalse(m.has_active_window('2026-01-01', now))
        self.assertTrue(m.needs_refresh('2026-01-01', now))


if __name__ == '__main__':
    unittest.main()
