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

    def test_failed_day_stops_publication_with_nonzero_exit(self):
        with tempfile.TemporaryDirectory(dir=BASE/'tests') as temp:
            api = type('API', (), {'requests_made': 0})()
            with patch.object(fetch, 'fetch_day', side_effect=RuntimeError('API failed')), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as result:
                    fetch.mode_fetch(api, Path(temp), ['2026-11-05'], 'slim', 500, 2, True)
            self.assertEqual(result.exception.code, 1)

    def test_workflow_catches_up_missed_nightly_refresh_once_per_day(self):
        import os
        import textwrap
        workflow = (BASE/'.github/workflows/update-model.yml').read_text(encoding='utf-8')
        code = textwrap.dedent(workflow.split('python - <<\'PY\' >> "$GITHUB_OUTPUT"',1)[1].split('          PY',1)[0])
        real_datetime = datetime
        class Clock(real_datetime):
            hour = 7
            @classmethod
            def now(cls, tz=None):
                return real_datetime(2026, 11, 5, cls.hour, 17, tzinfo=tz)
        with tempfile.TemporaryDirectory(dir=BASE/'tests') as temp:
            marker = Path(temp)/'last-deep-refresh.txt'
            def local_path(value):
                return marker if value == 'archive/last-deep-refresh.txt' else Path(value)
            for hour, previous, expected in [(1,'',False),(2,'',True),(7,'2026-11-04',True),(7,'2026-11-05',False)]:
                Clock.hour = hour
                marker.write_text(previous)
                out = io.StringIO()
                with patch('datetime.datetime',Clock), patch('pathlib.Path',local_path), patch.dict(os.environ,{'EVENT_NAME':'schedule','IN_FROM':'','IN_TO':''}), contextlib.redirect_stdout(out):
                    exec(code, {})
                values = dict(line.split('=',1) for line in out.getvalue().splitlines())
                self.assertEqual(values['deep_date'], '2026-11-05' if expected else '')
                self.assertEqual(values['refresh_last'], '5' if expected else '2')
                self.assertEqual(values['recent_flag'], '' if expected else '--recent-only')


if __name__ == '__main__':
    unittest.main()
