"""Task activity: actual completion dates, original statuses, availability windows.

completionDate is a planned timestamp in Bruno, never an actual completion.
Non-completed tasks retain their scheduler date; this is not status history.
"""
from collections import Counter
from datetime import datetime, timedelta, timezone

MSK = timezone(timedelta(hours=3))
FIELDS = ('NEW', 'WAITING', 'COMPLETING', 'COMPLETED', 'MISSED',
          'completedOnTime', 'completedLate', 'delayHoursSum', 'delayHoursN')


def instant(value):
    try:
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return dt if dt.tzinfo is not None else None
    except (ValueError, TypeError):
        return None


def window_kind(rec):
    start, end = instant(rec.get('date')), instant(rec.get('deactivationDate'))
    if start is None or end is None or end < start:
        return 'unknown'
    return 'daily' if (end-start).total_seconds() <= 86400 else 'prolonged'


def event_time(rec, planned_day):
    if rec.get('status') == 'COMPLETED':
        done = instant(rec.get('date_complete'))
        if done is None:
            return None
        local = done.astimezone(MSK)
        return local.date().isoformat(), local.strftime('%H')
    dl = str(rec.get('dateLocal') or '')
    hour = dl[8:10] if len(dl) >= 10 and dl[8:10].isdigit() and int(dl[8:10]) < 24 else '24'
    return planned_day, hour


class ActivityStats:
    def __init__(self, attribution):
        self.attribution = attribution
        self.rows = {}
        self.qa = Counter()

    def add(self, rec, planned_day):
        status = str(rec.get('status') or '').upper()
        if rec.get('deleted') or status not in FIELDS[:5] or not planned_day:
            return
        self.qa['sourceTasks'] += 1
        if status == 'COMPLETED' and not str(rec.get('employeeID') or '').strip():
            self.qa['missingExecutor'] += 1
            return
        event = event_time(rec, planned_day)
        if event is None:
            self.qa['missingActualCompletionDate'] += 1
            return
        day, hour = event
        kind = window_kind(rec)
        self.qa[kind] += 1
        if status == 'COMPLETED' and day != planned_day:
            self.qa['movedCompletions'] += 1
        func, team, employee = self.attribution(rec)
        key = '|'.join((day, hour, str(rec.get('objectID') or ''), func, team, employee,
                        str(rec.get('zoneID') or ''), kind, str(rec.get('feedbackID') or '')))
        if key not in self.rows:
            self.rows[key] = {side: dict.fromkeys(FIELDS, 0) for side in ('planned', 'unplanned')}
        bucket = self.rows[key]['planned' if rec.get('taskID') else 'unplanned']
        bucket[status] += 1
        if status == 'COMPLETED':
            done, deadline = instant(rec.get('date_complete')), instant(rec.get('completionDeadlineDate'))
            if deadline is not None:
                delay = (done-deadline).total_seconds() / 3600
                bucket['completedLate' if delay > 0 else 'completedOnTime'] += 1
                if delay > 0:
                    bucket['delayHoursSum'] += delay
                    bucket['delayHoursN'] += 1
            else:
                self.qa['missingDeadline'] += 1
