"""Task counts by team function, preserving Bruno's original statuses.

One task contributes once. A pool assignment without a known executor stays
on a team row; it is never copied to every member of the pool.
"""
from collections import defaultdict
from datetime import datetime, timezone, timedelta
import re

UNRESOLVED = "Функция/смена не определена"
STATUSES = ("NEW", "WAITING", "COMPLETING", "COMPLETED", "MISSED")
SHIFTED = {"Клининг", "Админы клининга"}


def team_function(team):
    text = " ".join((team.get("name") or "", team.get("description") or "")).lower()
    text = text.replace("c", "с").replace("\\", "/")
    rules = (
        (("ммс",), "ММС"), (("такелаж",), "Такелажники"),
        (("флорист", "эво", "фешн", "цвет"), "Флористы"),
        (("комендант", "комендатн"), "Коменданты"),
        (("админы",), "Админы клининга"),
        (("администратор",), "Администраторы банка"),
        (("клининг", "уборщ", "клинер", "уборк"), "Клининг"),
        (("диспетчер",), "Диспетчеры"),
        (("вб-сервис", "эксплуатац", "инженер", "техник"), "Эксплуатация"),
    )
    for markers, func in rules:
        if any(m in text for m in markers):
            shift = None
            if func in SHIFTED:
                if "в/с" in text or "вечер" in text:
                    shift = "В/С"
                elif "д/с" in text or "днев" in text:
                    shift = "Д/С"
            return func, shift
    return None


def task_shift(rec):
    """dateLocal can be YYYYMMDDHH or YYYYMMDDHHMM; take positions 8:10."""
    dl = str(rec.get("dateLocal") or "")
    if re.fullmatch(r"\d{10,12}", dl):
        hour = int(dl[8:10])
        if hour < 24:
            return "Д/С" if hour < 18 else "В/С"
    try:
        dt = datetime.fromisoformat(str(rec.get("date") or "").replace("Z", "+00:00"))
        if dt.tzinfo is None:
            return None
        hour = dt.astimezone(timezone(timedelta(hours=3))).hour
        return "Д/С" if hour < 18 else "В/С"
    except (ValueError, TypeError):
        return None


def member_id(value):
    if isinstance(value, dict):
        return str(value.get("id") or value.get("_id") or "")
    return str(value or "")


class FunctionStats:
    def __init__(self, teams):
        self.teams = teams
        self.team_functions = {tid: team_function(team) for tid, team in teams.items()}
        self.memberships = defaultdict(set)
        for tid, team in teams.items():
            if not team.get("active", True):
                continue
            tf = self.team_functions[tid]
            if tf:
                for eid in team.get("memberIDs", []):
                    self.memberships[eid].add(tf)
        self.rows = {}
        self.count = 0
        self.completion_anomalies = defaultdict(int)

    def attribution(self, rec):
        tid = str(rec.get("teamID") or "")
        eid = str(rec.get("employeeID") or "")
        assigned = {member_id(e) for e in (rec.get("employees") or []) if member_id(e)}
        if not eid and len(assigned) == 1:
            eid = next(iter(assigned))
        tf = self.team_functions.get(tid)
        if tf is None:
            # For a personal task use memberships, never the user's Bruno role.
            people = {eid} if eid else assigned
            candidates = set()
            known = bool(people)
            for person in people:
                options = self.memberships.get(person, set())
                if not options:
                    known = False
                candidates.update(options)
            if known and len(candidates) == 1:
                tf = next(iter(candidates))
            elif known and candidates:
                shift = task_shift(rec)
                matching = {x for x in candidates if x[0] in SHIFTED and x[1] == shift}
                # Time resolves day/evening only within one base function.
                if len({x[0] for x in candidates}) == 1 and len(matching) == 1:
                    tf = next(iter(matching))
        if tf is None:
            return UNRESOLVED, tid, eid
        func, shift = tf
        if func in SHIFTED:
            shift = shift or task_shift(rec)
            if not shift:
                return UNRESOLVED, tid, eid
            func += " " + shift
        return func, tid, eid

    def add(self, rec, day):
        status = str(rec.get("status") or "").upper()
        if status not in STATUSES or rec.get("deleted") or not day:
            return
        func, tid, eid = self.attribution(rec)
        side = "planned" if rec.get("taskID") else "unplanned"
        self.count += 1
        # Assignment or taking a task in progress is insufficient for closure.
        # A confirmed completion needs both the final marker and an actual ID.
        if status == "COMPLETED" and not str(rec.get("employeeID") or "").strip():
            self.completion_anomalies["|".join((day, str(rec.get("objectID") or ""), side, func))] += 1
            return
        key = "|".join((day, str(rec.get("objectID") or ""), func, tid, eid))
        if key not in self.rows:
            self.rows[key] = {s: {**dict.fromkeys(STATUSES, 0), "completedOnTime": 0,
                                 "completedLate": 0} for s in ("planned", "unplanned")}
        self.rows[key][side][status] += 1
        if status == "COMPLETED":
            late = False
            try:
                done = datetime.fromisoformat(str(rec.get("date_complete") or rec.get("completionDate") or "").replace("Z", "+00:00"))
                deadline = datetime.fromisoformat(str(rec.get("completionDeadlineDate") or "").replace("Z", "+00:00"))
                late = done > deadline
            except (TypeError, ValueError):
                pass
            self.rows[key][side]["completedLate" if late else "completedOnTime"] += 1
