#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
model_v2.py — компактный формат модели дашборда (формат 2).

ЗАЧЕМ. В формате 1 модель — один файл model.json.gz, где каждая запись куба
выглядит так:

    "2026-08-21|a3e4db40-41bc-4871-bb20-cc9e682867e4":
        {"planned":{"NEW":0,"WAITING":0,"COMPLETING":0,"COMPLETED":12,"MISSED":1,
                    "completedOnTime":10,"completedLate":2,
                    "delayHoursSum":3.5,"delayHoursN":2},
         "unplanned":{... те же девять имён ...}}

То есть в каждой из сотен тысяч записей повторяются 36-символьный UUID и имена
полей бакета. Gzip такую воду жмёт неплохо, но браузеру всё равно приходится
разбирать несжатый текст целиком — а это и время, и память, и именно оно держит
пустой экран на телефоне.

ЧТО ДЕЛАЕТ ФОРМАТ 2.
  1. Справочники выносятся в списки, а внутри кубов вместо UUID/дат/ролей стоят
     их номера в этих списках.
  2. Каждый куб — один плоский массив чисел с фиксированным шагом (stride).
     Запись выше превращается в 20 чисел без единого имени поля.
  3. Модель режется на две части:
        core  — справочники + кубы для первого экрана (блоки 01 и 03);
        cubes — тяжёлые кубы для блоков 02, 04 и часовой детализации,
                браузер догружает их фоном уже после первой отрисовки.

Данные при этом НЕ теряются и НЕ округляются: decode() восстанавливает ровно ту
же структуру, что была в формате 1 (это проверяется model_v2_selftest).

Модуль используют:
  * build_model.py  — пишет core/cubes рядом с legacy model.json.gz;
  * build_report.py — читает обе части и собирает обратно модель формата 1;
  * dashboard_v2.html — разбирает те же массивы на JS (см. decodeV2 там же).
"""

FORMAT_VERSION = 2

# Порядок полей бакета — общий контракт с JS-декодером в dashboard_v2.html.
# Менять только вместе с ним и с подъёмом FORMAT_VERSION.
BUCKET_FULL = ["NEW", "WAITING", "COMPLETING", "COMPLETED", "MISSED",
               "completedOnTime", "completedLate", "delayHoursSum", "delayHoursN"]
BUCKET_LIGHT = ["NEW", "WAITING", "COMPLETING", "COMPLETED", "MISSED",
                "completedOnTime", "completedLate"]

# Раскладка кубов: имя -> (из скольких частей ключ, список полей значения).
# "d" — день, "o" — объект, "z" — зона, "e" — сотрудник, "r" — роль, "h" — час.
CUBES = {
    # ключ "дата|объект", значение {planned: бакет, unplanned: бакет}
    "byObjectDay":         {"key": ["d", "o"],      "val": ("pu", BUCKET_FULL)},
    # ключ "дата|объект|роль", бакеты урезанные (без delayHours)
    "byObjectRoleDay":     {"key": ["d", "o", "r"], "val": ("pu", BUCKET_LIGHT)},
    # ключ "дата|час|объект"
    "byObjectHour":        {"key": ["d", "h", "o"], "val": ("pu", BUCKET_FULL)},
    # ключ "дата|зона", значение {objectID, completed, missed}
    "byZoneDay":           {"key": ["d", "z"],      "val": ("zone", ["completed", "missed"])},
    # ключ "дата|сотрудник"
    "byEmployeeDay":       {"key": ["d", "e"],      "val": ("flat", ["ai", "ci", "at", "ct"])},
    # ключ "дата|объект|сотрудник"
    "byEmployeeObjectDay": {"key": ["d", "o", "e"], "val": ("flat", ["ai", "ci", "at", "ct"])},
    "byEmployeeTaskDay":   {"key": ["d", "o", "e"], "val": ("flat", ["pa", "pc", "ua", "uc"])},
    # НОВОЕ (проход 14): обращения ОТДЕЛЬНО от неплановых задач.
    # fb — уникальные feedbackID за сутки по объекту (единица «обращение»),
    # tasks — записи taskPlan с feedbackID (единица «задача по обращению»),
    # далее статусы этих задач (у самого обращения статуса нет).
    "fbByObjectDay":       {"key": ["d", "o"],      "val": ("flat", ["fb", "tasks", "NEW", "WAITING",
                                                                     "COMPLETING", "COMPLETED", "MISSED"])},
    "fbByObjectHour":      {"key": ["d", "h", "o"], "val": ("flat", ["fb", "tasks"])},
}

# Что уезжает в первый (лёгкий) файл, что — во второй.
# В core — всё, что видно сразу при открытии: блоки 01, 03 и 04 плюс плашки
# ролей. В отдельный файл вынесено только то, что нужно ПО КЛИКУ: зоны объекта
# (панель треймапа) и часовой разрез дня. Их браузер догружает фоном, и к
# моменту первого клика они, как правило, уже на месте.
# fbByObjectDay — в core: блок «Обращения по объектам» на первом экране, и он
# крошечный (сотни записей против сотен тысяч у byObjectDay). fbByObjectHour —
# в lazy, рядом с byObjectHour: нужен только по клику на столбик дня.
CORE_CUBES = ["byObjectDay", "byObjectRoleDay", "byEmployeeDay",
              "byEmployeeObjectDay", "byEmployeeTaskDay", "fbByObjectDay"]
LAZY_CUBES = ["byZoneDay", "byObjectHour", "fbByObjectHour"]


def _stride(spec):
    kind, fields = spec["val"]
    n = len(spec["key"])
    if kind == "pu":
        return n + 2 * len(fields)
    if kind == "zone":
        return n + 1 + len(fields)      # + индекс объекта зоны
    return n + len(fields)


class _Index:
    """Список уникальных значений + обратный словарь «значение -> номер»."""

    def __init__(self, values=()):
        self.items = list(values)
        self.pos = {v: i for i, v in enumerate(self.items)}

    def idx(self, value):
        i = self.pos.get(value)
        if i is None:
            i = self.pos[value] = len(self.items)
            self.items.append(value)
        return i


def encode(model):
    """Модель формата 1 -> (core_dict, cubes_dict) формата 2."""
    daily = model.get("daily", {})
    dirs = model.get("directories", {})

    objects = dirs.get("objects", {})       # {id: name}
    zones = dirs.get("zones", {})           # {id: {name, objectID}}

    obj_ix = _Index(objects.keys())
    zone_ix = _Index(zones.keys())
    emp_ix = _Index(dirs.get("employees", {}).keys())
    day_ix = _Index()
    role_ix = _Index()

    part_ix = {"d": day_ix, "o": obj_ix, "z": zone_ix, "e": emp_ix, "r": role_ix}

    def encode_cube(name):
        spec = CUBES[name]
        kind, fields = spec["val"]
        rows = []
        add = rows.append
        for key, val in (daily.get(name) or {}).items():
            parts = key.split("|")
            if len(parts) != len(spec["key"]):
                continue
            for slot, raw in zip(spec["key"], parts):
                if slot == "h":
                    add(int(raw))
                else:
                    add(part_ix[slot].idx(raw))
            if kind == "pu":
                for side in ("planned", "unplanned"):
                    b = val.get(side) or {}
                    for f in fields:
                        add(b.get(f, 0))
            elif kind == "zone":
                add(obj_ix.idx(str(val.get("objectID") or "")))
                for f in fields:
                    add(val.get(f, 0))
            else:
                for f in fields:
                    add(val.get(f, 0))
        return {"stride": _stride(spec), "rows": rows}

    # Кубы кодируем ДО справочников: по дороге наполняются индексы дней и ролей,
    # а объектов зон может не оказаться в справочнике объектов (удалённые) —
    # тогда они добавятся в конец списка и всё равно расшифруются.
    encoded = {name: encode_cube(name) for name in CUBES}

    zones_ids = zone_ix.items
    core = {
        "f": FORMAT_VERSION,
        "part": "core",
        "meta": model.get("meta", {}),
        "days": day_ix.items,
        "roles": role_ix.items,
        "dirs": {
            "objects": {"ids": obj_ix.items,
                        "names": [objects.get(i, "") for i in obj_ix.items]},
            "zones": {"ids": zones_ids,
                      "names": [(zones.get(i) or {}).get("name", "") for i in zones_ids],
                      "obj": [obj_ix.idx(str((zones.get(i) or {}).get("objectID") or ""))
                              for i in zones_ids]},
            "employees": dirs.get("employees", {}),
            # Явный список id сотрудников в порядке индексации: в кубах могут
            # встретиться сотрудники, которых уже нет в справочнике (уволенные),
            # и тогда порядок ключей справочника индексу не соответствует.
            "empIds": emp_ix.items,
            "teams": dirs.get("teams", {}),
        },
        "feedbackExamples": model.get("feedbackExamples", []),
        "cubes": {n: encoded[n] for n in CORE_CUBES},
    }
    cubes = {
        "f": FORMAT_VERSION,
        "part": "cubes",
        "cubes": {n: encoded[n] for n in LAZY_CUBES},
    }
    # Индекс объектов мог подрасти на шаге зон — пересобираем имена под финальный список.
    core["dirs"]["objects"]["ids"] = obj_ix.items
    core["dirs"]["objects"]["names"] = [objects.get(i, "") for i in obj_ix.items]
    return core, cubes


def decode(core, cubes=None):
    """(core, cubes) формата 2 -> модель формата 1 (как её ждёт build_report.py)."""
    days = core.get("days", [])
    roles = core.get("roles", [])
    d = core.get("dirs", {})
    obj_ids = d.get("objects", {}).get("ids", [])
    obj_names = d.get("objects", {}).get("names", [])
    zone_ids = d.get("zones", {}).get("ids", [])
    zone_names = d.get("zones", {}).get("names", [])
    zone_obj = d.get("zones", {}).get("obj", [])
    emp_ids = d.get("empIds") or list((d.get("employees") or {}).keys())

    part_items = {"d": days, "o": obj_ids, "z": zone_ids, "e": emp_ids, "r": roles}

    def decode_cube(name, packed):
        spec = CUBES[name]
        kind, fields = spec["val"]
        stride = packed.get("stride") or _stride(spec)
        rows = packed.get("rows") or []
        nk = len(spec["key"])
        out = {}
        for off in range(0, len(rows), stride):
            key_parts = []
            for j, slot in enumerate(spec["key"]):
                v = rows[off + j]
                # час хранится числом, а в ключе он всегда двузначный ("07"),
                # иначе ROWS_HOUR_BY_KEY/by_hour не найдут запись
                key_parts.append(str(v).zfill(2) if slot == "h" else part_items[slot][v])
            p = off + nk
            if kind == "pu":
                planned = {f: rows[p + i] for i, f in enumerate(fields)}
                p += len(fields)
                unplanned = {f: rows[p + i] for i, f in enumerate(fields)}
                val = {"planned": planned, "unplanned": unplanned}
            elif kind == "zone":
                val = {"objectID": obj_ids[rows[p]]}
                val.update({f: rows[p + 1 + i] for i, f in enumerate(fields)})
            else:
                val = {f: rows[p + i] for i, f in enumerate(fields)}
            out["|".join(key_parts)] = val
        return out

    daily = {}
    for src in (core, cubes or {}):
        for name, packed in (src.get("cubes") or {}).items():
            daily[name] = decode_cube(name, packed)

    return {
        "meta": core.get("meta", {}),
        "directories": {
            "objects": {i: n for i, n in zip(obj_ids, obj_names)},
            "zones": {i: {"name": n, "objectID": obj_ids[o] if o < len(obj_ids) else ""}
                      for i, n, o in zip(zone_ids, zone_names, zone_obj)},
            "employees": d.get("employees", {}),
            "teams": d.get("teams", {}),
        },
        "daily": daily,
        "feedbackExamples": core.get("feedbackExamples", []),
    }
