#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Модель для презентации-КОПИИ утверждённой колоды (БРУНО_исправленно.pptx).

Вход  — model.json.gz конвейера 2.0 (build_model.py), включая кубы model["report"].
Выход — структура блоков в точности такая же, какую раньше отдавал
        pptx_pipeline/build_model.py из report_data_v3.json, чтобы вёрстка и
        графики утверждённой колоды переносились без переписывания.

Отличия от июльской версии — только согласованные с заказчиком (21.08.2026):
  * горизонт = текущий (неполный) месяц + 3 предыдущих;
  * списки объектов и комендантов в приложениях не фиксированы, а «активные
    в текущем месяце» (хотя бы одна задача);
  * уборщицы (решение заказчика 22.08.2026 по реальным цифрам, режим "split"):
      - ПЛАНОВЫЕ задачи — только системная роль employee, как в утверждённой
        колоде, чтобы цифры оставались сопоставимыми с июльским отчётом;
      - НЕПЛАНОВЫЕ задачи — employee + «Менеджер клининга». Без второй роли
        неплановой уборки в данных практически нет (65 задач за 4 месяца
        против 2 302 у менеджера), и новый график был бы пустым.
    Режимы "base" и "base+mgr" оставлены для сверки — ключ --clean.

Соответствие статусов старой схеме v3:
    completed  = COMPLETED
    missed     = MISSED
    completing = COMPLETING + NEW + WAITING   (всё, что «в работе»)
    due        = completed + missed + completing
"""

import datetime as dt
import gzip
import json
from collections import defaultdict
from pathlib import Path

MONTHS_RU = ["", "январь", "февраль", "март", "апрель", "май", "июнь", "июль",
             "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]

# Три «башни» для слайда скорости уборки (block6) — тот же список, что в
# утверждённой колоде. Если объект переименуют, имя подтянется из справочника.
TOWER_IDS = [
    "a037facd-77d3-4fd6-b2b9-a33b90ab0eb0",  # Башня ВТБ
    "a5fc4390-5a9f-4521-8443-9364e0065603",  # Башня "Запад" (Федерация)
    "da25b805-5315-484b-8159-82a9c8eeb5af",  # Башня "Восток" (Федерация)
]
TOWER_FALLBACK_NAMES = {
    TOWER_IDS[0]: "Башня ВТБ",
    TOWER_IDS[1]: 'Башня "Запад" (Федерация)',
    TOWER_IDS[2]: 'Башня "Восток" (Федерация)',
}

KOMENDANT_ROLE_MARK = "комендант"

# Границы бакетов гистограммы фактической длительности (минуты) — должны
# совпадать с FACT_BUCKETS в build_model.py, иначе медиана поедет.
FACT_BUCKETS = [0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 30, 45, 60, 120, 240, 1440]

# Режимы трактовки «уборщиц» -> (группы для ПЛАНОВЫХ, группы для НЕПЛАНОВЫХ).
# Группы приходят из куба byCleanObjectDay: base = системная роль employee,
# mgr = «Менеджер клининга».
CLEAN_MODES = {
    "base": (("base",), ("base",)),
    "base+mgr": (("base", "mgr"), ("base", "mgr")),
    "split": (("base",), ("base", "mgr")),
}
CLEAN_MODE_NOTE = {
    "base": "уборщицы — только основная роль",
    "base+mgr": "уборщицы — основная роль и «Менеджер клининга»",
    "split": "плановые — основная роль уборщиц; неплановые — вместе с «Менеджером клининга»",
}


# --------------------------------------------------------------- утилиты дат
def parse_d(s):
    return dt.date.fromisoformat(s)


def daterange(d0, d1):
    d = d0
    while d <= d1:
        yield d
        d += dt.timedelta(days=1)


def week_start(d):
    return d - dt.timedelta(days=d.weekday())


def month_first(d):
    return d.replace(day=1)


def months_back(d, n):
    """Первое число месяца, отстоящего от d на n месяцев назад."""
    y, m = d.year, d.month - n
    while m <= 0:
        m += 12
        y -= 1
    return dt.date(y, m, 1)


def build_weeks(d0, d1):
    weeks = []
    ws = week_start(d0)
    while ws <= d1:
        we = min(ws + dt.timedelta(days=6), d1)
        weeks.append({"start": max(ws, d0), "end": we, "iso_start": ws})
        ws += dt.timedelta(days=7)
    return weeks


def month_label(y, m):
    return MONTHS_RU[m].capitalize()


# --------------------------------------------------------------- чтение модели
def read_model(path):
    op = gzip.open if str(path).endswith(".gz") else open
    with op(path, "rt", encoding="utf-8") as f:
        model = json.load(f)
    if not isinstance(model, dict) or "daily" not in model:
        raise SystemExit("ОШИБКА: %s не похож на model.json.gz формата 1" % path)
    if "report" not in model:
        raise SystemExit(
            "ОШИБКА: в модели нет блока 'report' — она собрана старой версией "
            "build_model.py. Пересоберите модель (build_model.py от 21.08.2026 "
            "и новее), иначе слайды по обращениям, комендантам, уборке и "
            "скорости считать не из чего.")
    return model


# --------------------------------------------------------------- агрегация
def zero3():
    return {"completed": 0, "missed": 0, "completing": 0, "due": 0}


def from_status_bucket(b):
    """Бакет из 5 статусов -> тройка v3 (completed / missed / completing)."""
    c = b.get("COMPLETED", 0)
    m = b.get("MISSED", 0)
    w = b.get("COMPLETING", 0) + b.get("NEW", 0) + b.get("WAITING", 0)
    return {"completed": c, "missed": m, "completing": w, "due": c + m + w}


def add3(dst, src):
    for k in ("completed", "missed", "completing", "due"):
        dst[k] += src[k]


def eff_pct(c, m):
    return round(c / (c + m) * 100, 1) if (c + m) else 0


def empty_wk(n):
    return {"completed": [0] * n, "missed": [0] * n, "completing": [0] * n, "due": [0] * n}


class Aggregator:
    """Копит {сущность: {дата: тройка}} и раскладывает по неделям/месяцам."""

    def __init__(self, weeks, months):
        self.weeks = weeks
        self.n = len(weeks)
        self.week_idx = {w["iso_start"]: i for i, w in enumerate(weeks)}
        self.month_keys = [m["key"] for m in months]
        self.ent_week = defaultdict(lambda: empty_wk(self.n))
        self.ent_month = defaultdict(lambda: defaultdict(zero3))
        self.ent_total = defaultdict(zero3)
        self.total_week = empty_wk(self.n)

    def add(self, eid, day, tri):
        wi = self.week_idx.get(week_start(day))
        if wi is None:
            return
        mk = "%d-%02d" % (day.year, day.month)
        ew, em, et = self.ent_week[eid], self.ent_month[eid][mk], self.ent_total[eid]
        for k in ("completed", "missed", "completing", "due"):
            v = tri[k]
            if not v:
                continue
            ew[k][wi] += v
            self.total_week[k][wi] += v
            em[k] += v
            et[k] += v

    def finish(self, kind):
        """kind: 'object' -> objects_sorted/obj_*/n_objects,
                 'komendant' -> komendanty_sorted/kom_*/n_komendanty.
        Имена ключей ровно те же, что были в pptx_pipeline/build_model.py, —
        иначе вёрстку утверждённой колоды пришлось бы переписывать."""
        for t in self.ent_total.values():
            t["efficiency"] = eff_pct(t["completed"], t["missed"])
        total = zero3()
        for t in self.ent_total.values():
            add3(total, t)
        total["efficiency"] = eff_pct(total["completed"], total["missed"])
        eff_week = [eff_pct(c, m) if (c + m) else None
                    for c, m in zip(self.total_week["completed"], self.total_week["missed"])]
        sorted_ids = sorted(self.ent_total, key=lambda k: -self.ent_total[k]["due"])
        is_obj = (kind == "object")
        return {
            ("objects_sorted" if is_obj else "komendanty_sorted"): sorted_ids,
            ("obj_total" if is_obj else "kom_total"): dict(self.ent_total),
            ("obj_week" if is_obj else "kom_week"): dict(self.ent_week),
            ("obj_month" if is_obj else "kom_month"):
                {k: {mk: dict(mv) for mk, mv in v.items()} for k, v in self.ent_month.items()},
            "total_week": self.total_week,
            "total_efficiency_week": eff_week,
            "total": total,
            ("n_objects" if is_obj else "n_komendanty"): len(self.ent_total),
        }


# --------------------------------------------------------------- сборка модели
def build(model, d_from=None, d_to=None, clean_mode="split", months_back_n=3):
    meta = model.get("meta", {})
    daily = model["daily"]
    rep = model["report"]
    objects_dir = model["directories"]["objects"]
    employees_dir = model["directories"].get("employees", {})

    if clean_mode not in CLEAN_MODES:
        raise SystemExit("ОШИБКА: неизвестный режим --clean: %s" % clean_mode)
    clean_planned, clean_unplanned = CLEAN_MODES[clean_mode]

    a_from = parse_d(meta.get("archiveFrom") or "2026-01-01")
    a_to = parse_d(meta.get("archiveTo") or dt.date.today().isoformat())

    # --- горизонт: текущий (неполный) месяц + N предыдущих ---
    d_to = min(d_to or a_to, a_to)
    d_from = max(d_from or months_back(d_to, months_back_n), a_from)
    if d_from > d_to:
        raise SystemExit("ОШИБКА: пустой период %s..%s" % (d_from, d_to))

    in_range = {d.isoformat() for d in daterange(d_from, d_to)}
    cur_month = (d_to.year, d_to.month)
    cur_month_days = {d.isoformat() for d in daterange(month_first(d_to), d_to)}

    weeks = build_weeks(d_from, d_to)
    months = [{"key": "%d-%02d" % (y, m), "label": month_label(y, m), "year": y, "month": m}
              for (y, m) in sorted({(d.year, d.month) for d in daterange(d_from, d_to)})]

    out = {
        "meta": {
            "period_from": d_from.isoformat(),
            "period_to": d_to.isoformat(),
            "archive_from": a_from.isoformat(),
            "archive_to": a_to.isoformat(),
            "snapshot": meta.get("generatedFromSnapshot"),
            "n_weeks": len(weeks),
            "months": months,
            "current_month": "%d-%02d" % cur_month,
            "clean_mode": clean_mode,
            "clean_note": CLEAN_MODE_NOTE[clean_mode],
            "clean_groups_planned": list(clean_planned),
            "clean_groups_unplanned": list(clean_unplanned),
        },
        "objects": objects_dir,
        "weeks": [{"start": w["start"].isoformat(), "end": w["end"].isoformat(),
                   "label": w["start"].strftime("%d.%m"),
                   "month": w["start"].month, "year": w["start"].year} for w in weeks],
    }

    # =================================================== активность и «текущий месяц»
    # ВАЖНО (проход 17). Раньше здесь считался ОДИН список «активных в текущем
    # месяце» — по любой задаче объекта/коменданта, — и он же применялся во всех
    # приложениях. Из-за этого в приложение по НЕПЛАНОВЫМ задачам попадали
    # объекты и люди, у которых неплановых задач в текущем месяце не было вовсе
    # (напр. ГО Трубная: неплановая уборка только в мае), и слайд показывал
    # пустой график и строку из нулей. Теперь каждый блок держит СВОЙ список.
    cur_active = defaultdict(set)

    active_now_objects = set()
    first_activity = {}
    for key, val in daily["byObjectDay"].items():
        ds, oid = key.split("|", 1)
        tri = zero3()
        add3(tri, from_status_bucket(val["planned"]))
        add3(tri, from_status_bucket(val["unplanned"]))
        if tri["due"] <= 0:
            continue
        prev = first_activity.get(oid)
        if prev is None or ds < prev:
            first_activity[oid] = ds
        if ds in cur_month_days:
            active_now_objects.add(oid)
    out["object_first_activity"] = first_activity
    out["active_objects_current_month"] = sorted(active_now_objects)

    # =================================================== BLOCK 3 — все задачи по объектам
    agg3 = Aggregator(weeks, months)
    agg3p = Aggregator(weeks, months)   # только плановые  (приложение, проход 17)
    agg3u = Aggregator(weeks, months)   # только неплановые
    for key, val in daily["byObjectDay"].items():
        ds, oid = key.split("|", 1)
        if ds not in in_range:
            continue
        day = parse_d(ds)
        p = from_status_bucket(val["planned"])
        u = from_status_bucket(val["unplanned"])
        tri = zero3()
        add3(tri, p)
        add3(tri, u)
        agg3.add(oid, day, tri)
        if p["due"]:
            agg3p.add(oid, day, p)
        if u["due"]:
            agg3u.add(oid, day, u)
        if ds in cur_month_days:
            if tri["due"]:
                cur_active["b3"].add(oid)
            if p["due"]:
                cur_active["b3p"].add(oid)
            if u["due"]:
                cur_active["b3u"].add(oid)
    out["block3"] = agg3.finish("object")
    out["block3p"] = agg3p.finish("object")
    out["block3u"] = agg3u.finish("object")

    # плановые/неплановые отдельно — нужны дереву (block «Плановые и неплановые»)
    tree_pl, tree_un = zero3(), zero3()
    month_pl = defaultdict(zero3)
    month_un = defaultdict(zero3)
    for key, val in daily["byObjectDay"].items():
        ds, oid = key.split("|", 1)
        if ds not in in_range:
            continue
        mk = ds[:7]
        p = from_status_bucket(val["planned"])
        u = from_status_bucket(val["unplanned"])
        add3(tree_pl, p)
        add3(tree_un, u)
        add3(month_pl[mk], p)
        add3(month_un[mk], u)

    # =================================================== BLOCK 2 — обращения
    fb_week = defaultdict(lambda: [0] * len(weeks))
    fb_month = defaultdict(lambda: defaultdict(int))
    fb_total = defaultdict(int)
    week_idx = {w["iso_start"]: i for i, w in enumerate(weeks)}
    for key, cnt in rep["feedbackByObjectDay"].items():
        ds, oid = key.split("|", 1)
        if ds not in in_range or not cnt:
            continue
        day = parse_d(ds)
        wi = week_idx.get(week_start(day))
        if wi is None:
            continue
        fb_week[oid][wi] += cnt
        fb_month[oid]["%d-%02d" % (day.year, day.month)] += cnt
        fb_total[oid] += cnt
        if ds in cur_month_days:
            cur_active["b2"].add(oid)
    week_total_b2 = [0] * len(weeks)
    for arr in fb_week.values():
        for i, v in enumerate(arr):
            week_total_b2[i] += v
    out["block2"] = {
        "objects_sorted": sorted(fb_total, key=lambda k: -fb_total[k]),
        "obj_total": dict(fb_total),
        "obj_week": {k: list(v) for k, v in fb_week.items()},
        "obj_month": {k: dict(v) for k, v in fb_month.items()},
        "week_total": week_total_b2,
        "total": sum(fb_total.values()),
        "max_week": max(week_total_b2) if week_total_b2 else 0,
        "n_objects": len(fb_total),
    }

    # =================================================== BLOCK 4 / 4b — коменданты
    agg4 = Aggregator(weeks, months)     # неплановые
    agg4b = Aggregator(weeks, months)    # плановые
    active_now_koms = set()
    for key, val in rep["byKomendantDay"].items():
        ds, eid = key.split("|", 1)
        if ds not in in_range:
            continue
        day = parse_d(ds)
        un = from_status_bucket(val["unplanned"])
        pl = from_status_bucket(val["planned"])
        if un["due"]:
            agg4.add(eid, day, un)
        if pl["due"]:
            agg4b.add(eid, day, pl)
        if ds in cur_month_days:
            if un["due"] or pl["due"]:
                active_now_koms.add(eid)
            if un["due"]:
                cur_active["b4"].add(eid)
            if pl["due"]:
                cur_active["b4b"].add(eid)
    out["block4"] = agg4.finish("komendant")
    out["block4b"] = agg4b.finish("komendant")
    out["active_komendanty_current_month"] = sorted(active_now_koms)

    kom_ids = set(out["block4"]["komendanty_sorted"]) | set(out["block4b"]["komendanty_sorted"])
    out["komendanty"] = {
        eid: {"name": (employees_dir.get(eid, {}) or {}).get("name") or eid,
              "roleName": (employees_dir.get(eid, {}) or {}).get("roleName") or ""}
        for eid in kom_ids
    }

    # =================================================== BLOCK 5 / 5b — уборка
    agg5 = Aggregator(weeks, months)     # плановые
    agg5b = Aggregator(weeks, months)    # неплановые
    set_pl, set_un = set(clean_planned), set(clean_unplanned)
    for key, val in rep["byCleanObjectDay"].items():
        parts = key.split("|")
        if len(parts) != 3:
            continue
        ds, oid, grp = parts
        if ds not in in_range:
            continue
        day = parse_d(ds)
        if grp in set_pl:
            pl = from_status_bucket(val["planned"])
            if pl["due"]:
                agg5.add(oid, day, pl)
                if ds in cur_month_days:
                    cur_active["b5"].add(oid)
        if grp in set_un:
            un = from_status_bucket(val["unplanned"])
            if un["due"]:
                agg5b.add(oid, day, un)
                if ds in cur_month_days:
                    cur_active["b5b"].add(oid)
    out["block5"] = agg5.finish("object")
    out["block5b"] = agg5b.finish("object")

    # =================================================== BLOCK 6 — скорость уборки
    # Считается отдельно по плановым (kind "p") и неплановым (kind "u") задачам.
    # «Мин./задачу» — ФАКТ (date_complete − date_begin). Норматив
    # (durationMinutes) держим рядом справочно: он систематически больше факта,
    # и подменять им факт нельзя.
    speed_new = True
    if "cleanSpeedDay" in rep:
        sample_key = next(iter(rep["cleanSpeedDay"]), "")
        if sample_key and len(sample_key.split("|")) != 5:
            raise SystemExit(
                "ОШИБКА: куб cleanSpeedDay старого формата (без разреза "
                "плановые/неплановые и без фактического времени). Пересоберите "
                "model.json.gz свежим build_model.py.")
        if sample_key and "all" not in rep["cleanSpeedDay"][sample_key]:
            # Модель собрана build_model.py до прохода 17: нет ни числа
            # НАЗНАЧЕННЫХ задач, ни гистограммы длительностей. Отчёт собираем,
            # но колонки «Назначено/чел.» и «Медиана» будут прочерками.
            speed_new = False

    def hist_median(hist):
        """Медиана по гистограмме FACT_BUCKETS: линейная интерполяция внутри
        бакета. Нужна потому, что среднее по факту вытягивают единичные
        «висящие» задачи в несколько часов (медиана 0,3 мин против среднего 68)."""
        total = sum(hist)
        if not total:
            return None
        half = total / 2.0
        lo = 0.0
        acc = 0
        for i, cnt in enumerate(hist):
            hi = FACT_BUCKETS[i]
            if acc + cnt >= half and cnt:
                return round(lo + (half - acc) / cnt * (hi - lo), 2)
            acc += cnt
            lo = hi
        return round(FACT_BUCKETS[-1], 2)

    def speed_slot(tid, kind, shift, groups):
        assigned = tasks = emps = fact_n = norm_n = 0
        fact_sum = norm_sum = 0.0
        n_days = 0
        hist = [0] * len(FACT_BUCKETS)
        for grp in groups:
            for ds in in_range:
                v = rep["cleanSpeedDay"].get("|".join((ds, tid, grp, kind, shift)))
                if not v:
                    continue
                n_days += 1
                assigned += v.get("all", 0)
                tasks += v["tasks"]
                emps += v["employees"]
                fact_sum += v["factSum"]
                fact_n += v["factN"]
                norm_sum += v["normSum"]
                norm_n += v["normN"]
                for i, c in enumerate(v.get("factHist") or ()):
                    hist[i] += c
        return {
            "has_data": (tasks > 0 or assigned > 0),
            "n_days": n_days,
            # НАЗНАЧЕНО — все задачи смены, любой статус (проход 17)
            "assigned": assigned,
            # ВЫПОЛНЕНО — только COMPLETED (как было)
            "tasks": tasks,
            # «на человека» — делим на сумму человеко-смен (как в утверждённой
            # колоде: employees там тоже копился по суткам, а не уникальными
            # людьми за период). Знаменатель один и тот же у обеих колонок,
            # поэтому их отношение = эффективность смены.
            "assigned_per_employee": (round(assigned / emps, 1)
                                      if (emps and speed_new) else None),
            "avg_tasks_per_employee": round(tasks / emps, 2) if emps else None,
            "avg_duration_min": round(fact_sum / fact_n, 1) if fact_n else None,
            "median_duration_min": hist_median(hist) if speed_new else None,
            "avg_norm_min": round(norm_sum / norm_n, 1) if norm_n else None,
            "n_measured": fact_n,
            # сырые суммы — для ВЗВЕШЕННОГО среднего по башням (см. tower_avg)
            "employees": emps, "fact_sum": round(fact_sum, 1), "fact_n": fact_n,
            "norm_sum": round(norm_sum, 1), "norm_n": norm_n, "fact_hist": hist,
        }

    kinds = {"planned": ("p", set_pl), "unplanned": ("u", set_un)}
    towers = {}
    for tid in TOWER_IDS:
        towers[tid] = {
            "name": objects_dir.get(tid) or TOWER_FALLBACK_NAMES.get(tid, tid),
            "kinds": {name: {sh: speed_slot(tid, code, sh, groups) for sh in ("day", "evening")}
                      for name, (code, groups) in kinds.items()},
        }

    def tower_avg(kind_name, shift):
        """Среднее по башням, ВЗВЕШЕННОЕ по объёму (решение заказчика
        22.08.2026). В утверждённой колоде среднее было простым — каждая башня
        весила одинаково; на неплановых задачах это ломало цифру: башня с двумя
        задачами тянула среднее с 64 минут до 25. Теперь одинаково весит не
        башня, а задача."""
        slots = [t["kinds"][kind_name][shift] for t in towers.values()
                 if t["kinds"][kind_name][shift]["has_data"]]
        assigned = sum(s["assigned"] for s in slots)
        tasks = sum(s["tasks"] for s in slots)
        emps = sum(s["employees"] for s in slots)
        fact_sum = sum(s["fact_sum"] for s in slots)
        fact_n = sum(s["fact_n"] for s in slots)
        norm_sum = sum(s["norm_sum"] for s in slots)
        norm_n = sum(s["norm_n"] for s in slots)
        hist = [0] * len(FACT_BUCKETS)
        for s in slots:
            for i, c in enumerate(s["fact_hist"]):
                hist[i] += c
        return {"assigned": assigned,
                "assigned_per_employee": (round(assigned / emps, 1)
                                          if (emps and speed_new) else None),
                "avg_tasks_per_employee": round(tasks / emps, 2) if emps else None,
                "avg_duration_min": round(fact_sum / fact_n, 1) if fact_n else None,
                "median_duration_min": hist_median(hist) if speed_new else None,
                "avg_norm_min": round(norm_sum / norm_n, 1) if norm_n else None,
                "n_towers_with_data": len(slots),
                "n_measured": fact_n,
                "tasks": tasks}

    out["block6"] = {
        "towers": towers,
        "tower_names": {tid: towers[tid]["name"] for tid in TOWER_IDS},
        "average": {k: {sh: tower_avg(k, sh) for sh in ("day", "evening")} for k in kinds},
        "n_towers_total": len(TOWER_IDS),
        "n_towers_with_any_data": {
            k: sum(1 for t in towers.values()
                   if t["kinds"][k]["day"]["has_data"] or t["kinds"][k]["evening"]["has_data"])
            for k in kinds},
    }

    # =================================================== ДЕРЕВО план / неплан
    total_all = out["block3"]["total"]
    tree_pl["efficiency"] = eff_pct(tree_pl["completed"], tree_pl["missed"])
    tree_un["efficiency"] = eff_pct(tree_un["completed"], tree_un["missed"])
    tree_un["extrapolated"] = False
    raw_feedback = out["block2"]["total"]
    unplanned_instances = tree_un["due"]
    out["tree"] = {
        "total_due": total_all["due"],
        "planned": tree_pl,
        "unplanned": tree_un,
        "raw_feedback": raw_feedback,
        "feedback_task_instances": unplanned_instances,
        "conversion_pct": round(unplanned_instances / raw_feedback * 100, 1) if raw_feedback else 0,
        "months_fold": [{"key": m["key"], "label": m["label"]} for m in months],
        "planned_month_eff": [eff_pct(month_pl[m["key"]]["completed"], month_pl[m["key"]]["missed"])
                              if month_pl[m["key"]]["due"] else None for m in months],
        "unplanned_month_eff": [eff_pct(month_un[m["key"]]["completed"], month_un[m["key"]]["missed"])
                                if month_un[m["key"]]["due"] else None for m in months],
        "planned_month_due": [month_pl[m["key"]]["due"] for m in months],
        "unplanned_month_due": [month_un[m["key"]]["due"] for m in months],
    }

    # Поблочные списки «активных в текущем месяце» (проход 17). Ключи —
    # b2 / b3 / b3p / b3u / b4 / b4b / b5 / b5b, ровно как имена блоков.
    out["active_current_month"] = {k: sorted(v) for k, v in cur_active.items()}

    return out


def clean_group_totals(model, d_from=None, d_to=None):
    """Диагностика: сколько задач по уборке даёт каждая группа ролей за период.
    Нужна, чтобы показать заказчику цену вопроса «учитывать ли Менеджера клининга»."""
    meta = model.get("meta", {})
    a_to = parse_d(meta.get("archiveTo") or dt.date.today().isoformat())
    d_to = min(d_to or a_to, a_to)
    d_from = d_from or months_back(d_to, 3)
    in_range = {d.isoformat() for d in daterange(d_from, d_to)}
    out = {}
    for key, val in model["report"]["byCleanObjectDay"].items():
        parts = key.split("|")
        if len(parts) != 3 or parts[0] not in in_range:
            continue
        grp = parts[2]
        slot = out.setdefault(grp, {"planned": zero3(), "unplanned": zero3()})
        add3(slot["planned"], from_status_bucket(val["planned"]))
        add3(slot["unplanned"], from_status_bucket(val["unplanned"]))
    for grp, slot in out.items():
        for side in ("planned", "unplanned"):
            slot[side]["efficiency"] = eff_pct(slot[side]["completed"], slot[side]["missed"])
    return {"from": d_from.isoformat(), "to": d_to.isoformat(), "groups": out}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", default="model.json.gz")
    ap.add_argument("--clean", choices=list(CLEAN_MODES), default="split")
    ap.add_argument("--diff-clean", action="store_true",
                    help="Показать разницу между вариантами определения «уборщиц» и выйти")
    args = ap.parse_args()

    m = read_model(args.model)
    if args.diff_clean:
        print(json.dumps(clean_group_totals(m), ensure_ascii=False, indent=1))
        raise SystemExit(0)
    mm = build(m, clean_mode=args.clean)
    print("режим уборщиц:", args.clean, "—", CLEAN_MODE_NOTE[args.clean])
    print("период:", mm["meta"]["period_from"], "..", mm["meta"]["period_to"],
          "| недель:", mm["meta"]["n_weeks"], "| месяцев:", len(mm["meta"]["months"]))
    print("объектов активных в текущем месяце:", len(mm["active_objects_current_month"]))
    print("комендантов активных в текущем месяце:", len(mm["active_komendanty_current_month"]))
    for b in ("block2", "block3", "block4", "block4b", "block5", "block5b"):
        t = mm[b].get("total")
        if isinstance(t, dict):
            print("  %-8s задач=%s эфф=%s%%" % (b, t["due"], t["efficiency"]))
        else:
            print("  %-8s обращений=%s" % (b, mm[b]["total"]))

    print("\nblock6 — скорость уборки по башням (факт vs норматив):")
    b6 = mm["block6"]
    for kind, label in (("planned", "плановые"), ("unplanned", "неплановые")):
        print("  -- %s, башен с данными: %d из %d" % (
            label, b6["n_towers_with_any_data"][kind], b6["n_towers_total"]))
        for tid, name in b6["tower_names"].items():
            for sh in ("day", "evening"):
                s = b6["towers"][tid]["kinds"][kind][sh]
                if not s["has_data"]:
                    continue
                print("     %-30s %-7s назн=%-7s вып=%-6s назн/чел=%-6s вып/чел=%-6s "
                      "факт=%-6s медиана=%-6s норматив=%s" % (
                          name[:30], "день" if sh == "day" else "вечер", s["assigned"],
                          s["tasks"], s["assigned_per_employee"], s["avg_tasks_per_employee"],
                          s["avg_duration_min"], s["median_duration_min"], s["avg_norm_min"]))
        for sh in ("day", "evening"):
            a = b6["average"][kind][sh]
            print("     СРЕДНЕЕ (взвеш.) %-7s назн=%-7s вып=%-6s назн/чел=%-6s вып/чел=%-6s "
                  "факт=%-6s медиана=%-6s норматив=%-6s башен=%d, замеров=%s" % (
                      "день" if sh == "day" else "вечер", a["assigned"], a["tasks"],
                      a["assigned_per_employee"], a["avg_tasks_per_employee"],
                      a["avg_duration_min"], a["median_duration_min"], a["avg_norm_min"],
                      a["n_towers_with_data"], a["n_measured"]))

    print("\nТоп-5 объектов приложения (block3):")
    for oid in mm["block3"]["objects_sorted"][:5]:
        if oid not in set(mm["active_objects_current_month"]):
            continue
        t = mm["block3"]["obj_total"][oid]
        print("  %-40s задач=%-8s эфф=%s%%" % (mm["objects"].get(oid, oid)[:40], t["due"], t["efficiency"]))
    print("\nКоменданты приложения (block4, неплановые):")
    for kid in mm["block4"]["komendanty_sorted"]:
        if kid not in set(mm["active_komendanty_current_month"]):
            continue
        t = mm["block4"]["kom_total"][kid]
        k = mm["komendanty"].get(kid, {})
        print("  %-34s задач=%-6s эфф=%s%%" % (
            ("%s (%s)" % (k.get("name", kid), k.get("roleName", "")))[:34], t["due"], t["efficiency"]))
