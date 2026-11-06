"""Versioned, independently loadable dashboard periods."""

import json
from array import array
from collections import defaultdict
from datetime import date, timedelta

from feedback_register import PUBLIC_OBJECTS


def monday(day):
    day = date.fromisoformat(day)
    return (day - timedelta(days=day.weekday())).isoformat()


def publish(core, target):
    target.mkdir(parents=True, exist_ok=True)
    build = core["meta"]["buildId"]

    def write(name, data):
        (target / (name + ".json")).write_text(
            json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    packed = core["cubes"]["byActivity"]
    stride, rows = packed["stride"], packed["rows"]
    assert stride == 27
    dates = core["days"]
    objects = core["dirs"]["objects"]["ids"]
    offsets = defaultdict(lambda: array("I"))
    for i in range(0, len(rows), stride):
        if objects[rows[i + 2]] in PUBLIC_OBJECTS:
            offsets[dates[rows[i]]].append(i)

    requests = defaultdict(list)
    for request in core.get("feedbackRegister") or []:
        if request["registered"]:
            requests[monday(request["registered"][:10])].append(request)

    weeks = defaultdict(list)
    for day in sorted(offsets):
        weeks[monday(day)].append(day)

    def add(bucket, key, values):
        previous = bucket.get(key)
        if previous is None:
            bucket[key] = values.copy()
        else:
            for i, value in enumerate(values):
                previous[i] += value

    def flatten(bucket):
        return [value for key, counts in bucket.items() for value in (*key, *counts)]

    history = {}
    for week in sorted(weeks.keys() | requests.keys()):
        daily = {}
        for day in weeks.get(week, []):
            hours = {}
            for offset in offsets[day]:
                d, h, obj, role, team, emp, zone, window, _ = rows[offset:offset + 9]
                values = rows[offset + 9:offset + stride]
                add(daily, (d, 0, obj, role, team, emp, zone, window, 0), values)
                add(hours, (d, h, obj, role, team, emp, zone, window, 0), values)
                add(history, (d, 0, obj, role, 0, 0, 0, window, 0), values)
            write("hour-" + day, {"buildId": build, "rows": flatten(hours)})
        register = requests.get(week, [])
        write("week-" + week, {
            "buildId": build, "rows": flatten(daily),
            "requests": [{"registered": r["registered"], "object": r["object"],
                          "tasks": [{k: t[k] for k in ("role", "window", "status")}
                                    for t in r["tasks"]]} for r in register],
        })
        if register:
            write("register-" + week, {"buildId": build, "requests": register})

    write("index", {
        "f": 1, "meta": core["meta"], "days": dates, "roles": core["roles"],
        "dirs": {**core["dirs"], "feedbackIds": []},
        "weeks": sorted(weeks.keys() | requests.keys()), "hours": sorted(offsets),
        "registerWeeks": sorted(requests), "history": flatten(history),
        "activityRoles": [core["roles"][i] for i in sorted({key[3] for key in history})],
    })
