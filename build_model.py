#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сборка единого агрегата model.json.gz из сырого архива fetch_bruno.py (дашборд 2.0,
этап 3). Читает archive/{dirs,raw}/*, ничего не запрашивает у Bruno API.

Запуск:
    python build_model.py --archive archive --out model.json.gz

Ключевые решения (см. claude/ТЕХПЛАН_дашборд2.0_конвейер.md и обсуждение в чате
20.08.2026):

  * "Плановая" задача — по taskID (НЕ по taskTemplateID: подтверждённый баг в
    старом коде, поле taskTemplateID 100% пустое даже у настоящих плановых задач).
    "Неплановая" (обращение) — по feedbackID.
  * Атрибуция по сотрудникам/командам — из statByEmployee/statByTeam (источник
    правды Bruno), НЕ из taskPlan.employeeID/employees[0] (тот фолбэк массово
    приписывает весь объём команды одному "первому" человеку в списке — см.
    ШАГ2b, находка №3).
  * День группировки записи — по dateLocal самой записи, а не по имени папки
    архива (UTC-сутки выгрузки и локальные сутки события могут отличаться).
  * Сотрудник в нескольких командах одновременно (45 из 431 по факту разбора) —
    его командная доля суммируется по ВСЕМ командам, где он состоит (решение
    пользователя 20.08.2026).
  * Роль-дубль (два разных id с одинаковым именем, напр. «Наблюдатель») —
    схлопывается по имени: группировка везде идёт по строке имени роли, не по id
    (решение пользователя 20.08.2026).
  * objectID/zoneID для агрегатов по объектам берутся НЕПОСРЕДСТВЕННО из записей
    statBy*/taskPlan, а не через team.objects — это поле пустое у всех команд в
    реальных данных (структурной связи команда↔объект в Bruno сейчас нет).

Модель НЕ хранит готовые суммы за период — только посуточные срезы. Пересчёт под
выбранный на дашборде диапазон дат делает браузер (см. dashboard_v2.html, этап 4).
"""

import argparse
import gzip
import json
import sys
from collections import defaultdict
from pathlib import Path


def log(msg, level="info"):
    prefix = {"info": "   ", "ok": "  + ", "warn": "  ! ", "err": "  x ", "step": "\n-> "}[level]
    print(prefix + msg, flush=True)


def human(nbytes):
    for unit in ("Б", "КБ", "МБ", "ГБ"):
        if nbytes < 1024 or unit == "ГБ":
            return "%.1f %s" % (nbytes, unit)
        nbytes /= 1024.0


def read_json_gz(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def iter_jsonl_gz(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def uid(x):
    return str(x.get("id") or x.get("uuid") or x.get("_id") or "")


def day_of(rec):
    """Локальные сутки записи: dateLocal (формат YYYYMMDD, ИЛИ YYYYMMDDHH — на
    реальных данных Bruno отдаёт 10 цифр С ЧАСОМ, не только 8 цифр даты, —
    подтверждённый баг прежней версии: 10-значная строка использовалась как есть,
    из-за чего "днём" считался час, а не календарная дата) -> 'YYYY-MM-DD';
    фолбэк на первые 10 символов date (ISO, UTC), если dateLocal нет."""
    dl = rec.get("dateLocal")
    if dl:
        s = str(dl)
        if s.isdigit() and len(s) >= 8:
            return "%s-%s-%s" % (s[0:4], s[4:6], s[6:8])
        if len(s) >= 10:
            return s[:10]
    d = rec.get("date")
    return d[:10] if d else None


def extract_feedback_text(feedback_field):
    """taskPlan.feedback на практике оказался не строкой, а объектом (вложенная
    структура обращения) — подстраховываемся под оба варианта, чтобы не падать
    на неизвестных полях реального API."""
    if isinstance(feedback_field, str):
        return feedback_field.strip()
    if isinstance(feedback_field, dict):
        for key in ("text", "comment", "description", "message", "body", "value"):
            v = feedback_field.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
        return ""
    return ""


def parse_dt(s):
    """ISO8601 'YYYY-MM-DDTHH:MM:SS(.mmm)Z' -> секунды с эпохи, без внешних либ."""
    if not s or not isinstance(s, str) or len(s) < 19:
        return None
    try:
        from datetime import datetime, timezone
        s2 = s.replace("Z", "+00:00")
        return datetime.fromisoformat(s2).timestamp()
    except Exception:
        return None


STATUSES = ("NEW", "WAITING", "COMPLETING", "COMPLETED", "MISSED")


def empty_bucket():
    return {"NEW": 0, "WAITING": 0, "COMPLETING": 0, "COMPLETED": 0, "MISSED": 0,
            "completedOnTime": 0, "completedLate": 0,
            "delayHoursSum": 0.0, "delayHoursN": 0}


# --------------------------------------------------------------- справочники

def load_directories(archive):
    """Берёт самый свежий снимок справочников (dirs/<последняя дата>/*)."""
    dirs_root = archive / "dirs"
    if not dirs_root.exists():
        raise SystemExit("ОШИБКА: %s не найден — нечего собирать" % dirs_root)
    dates = sorted(p.name for p in dirs_root.iterdir() if p.is_dir())
    if not dates:
        raise SystemExit("ОШИБКА: в %s нет ни одного снимка справочников" % dirs_root)
    latest = dates[-1]
    log("Справочники: снимок за %s (самый свежий из %d)" % (latest, len(dates)), "step")
    d = dirs_root / latest

    def load(name):
        p = d / (name + ".json.gz")
        if not p.exists():
            log("%s.json.gz отсутствует в снимке — пропускаю" % name, "warn")
            return []
        rows = read_json_gz(p)
        log("%-10s %6d записей" % (name, len(rows)), "ok")
        return rows

    objects = load("object")
    zones = load("zone")
    users = load("user")
    teams = load("team")
    roles = load("role")
    return latest, objects, zones, users, teams, roles


def build_role_lookup(roles):
    """roleID -> имя роли. Схлопывание дублей по имени происходит естественно:
    группировка везде идёт по СТРОКЕ имени, а не по id, так что два разных id с
    одинаковым именем сами сойдутся при агрегации ниже."""
    out = {}
    for r in roles:
        if r.get("deleted"):
            continue
        out[uid(r)] = r.get("name") or "Без роли"
    return out


def build_team_membership(teams):
    """teamID -> {name, size, memberIDs}. Поле team.objects игнорируем — оно
    пустое у всех команд в реальных данных (нет структурной связи с объектом)."""
    out = {}
    for t in teams:
        if t.get("deleted"):
            continue
        members = t.get("employees") or t.get("members") or []
        member_ids = [str(m.get("id") if isinstance(m, dict) else m) for m in members]
        member_ids = [m for m in member_ids if m]
        out[uid(t)] = {
            "name": t.get("name") or "",
            "size": len(member_ids),
            "memberIDs": member_ids,
        }
    return out


def resolve_employee_role(user, role_lookup, project_id_hint, stats):
    """roleID сотрудника из user.projects[], отфильтрованного по нужному
    projectID (НЕ projects[0] — пользователь теоретически может состоять в
    нескольких проектах с разными ролями, см. СХЕМА_API_по_спеке.md)."""
    projects = user.get("projects") or []
    candidates = [p.get("roleID") for p in projects if isinstance(p, dict) and p.get("roleID")]
    if not candidates:
        return None
    if project_id_hint:
        for p in projects:
            if isinstance(p, dict) and str(p.get("projectID")) == str(project_id_hint) and p.get("roleID"):
                return p["roleID"]
    distinct = set(candidates)
    if len(distinct) > 1:
        stats["ambiguousRole"] += 1
    return candidates[0]


def build_employee_directory(users, role_lookup, team_membership, project_id_hint):
    """employeeID -> {name, roleName, teamIDs}. teamIDs — все команды, где
    человек числится участником (может быть 0, 1 или несколько)."""
    member_of = defaultdict(list)
    for team_id, t in team_membership.items():
        for m in t["memberIDs"]:
            member_of[m].append(team_id)

    stats = {"ambiguousRole": 0, "noRole": 0, "noTeam": 0, "multiTeam": 0}
    out = {}
    for u in users:
        if u.get("deleted"):
            continue
        eid = uid(u)
        if not eid:
            continue
        role_id = resolve_employee_role(u, role_lookup, project_id_hint, stats)
        role_name = role_lookup.get(role_id, "Без роли") if role_id else "Без роли"
        if role_name == "Без роли":
            stats["noRole"] += 1
        team_ids = member_of.get(eid, [])
        if not team_ids:
            stats["noTeam"] += 1
        elif len(team_ids) > 1:
            stats["multiTeam"] += 1
        out[eid] = {
            "name": u.get("name") or u.get("login") or eid,
            "roleName": role_name,
            "teamIDs": team_ids,
        }
    return out, stats


# --------------------------------------------------------------- посуточный проход

def process_archive(archive, manifest, employee_dir, team_membership, feedback_cap, days_override=None):
    by_object_day = defaultdict(empty_bucket)          # "date|objectID" -> bucket (planned/unplanned внутри)
    by_object_day_unplanned = defaultdict(empty_bucket)
    by_zone_day = defaultdict(lambda: {"objectID": "", "completed": 0, "missed": 0})
    by_employee_day = defaultdict(lambda: {"ai": 0, "ci": 0, "at": 0.0, "ct": 0.0})
    feedback_examples = []  # (date, objectID, zoneID, text) — храним последние feedback_cap

    if days_override is not None:
        days = days_override  # ручная пересборка порциями (см. rebuild_chunked.py, не часть штатного конвейера)
    else:
        days = sorted(d for d, rec in manifest.get("days", {}).items() if rec.get("complete"))
    if not days:
        raise SystemExit("ОШИБКА: манифест пуст или ни один день не помечен complete")

    qa = {"taskPlanCompleted": 0, "taskPlanMissed": 0, "statCompleted": 0, "statMissed": 0,
          "recordsTaskPlan": 0, "recordsStatEmployee": 0, "recordsStatTeam": 0, "recordsStatZone": 0}

    log("Обхожу %d дней архива…" % len(days), "step")
    for i, day in enumerate(days, 1):
        day_dir = archive / "raw" / day
        # --- taskPlan: план/факт, плановые/неплановые, просрочка ---
        tp_path = day_dir / "taskPlan.jsonl.gz"
        if tp_path.exists():
            for rec in iter_jsonl_gz(tp_path):
                if rec.get("deleted"):
                    continue
                d = day_of(rec)
                if not d:
                    continue
                obj = str(rec.get("objectID") or "")
                status = (rec.get("status") or "").upper()
                is_planned = bool(rec.get("taskID"))
                is_feedback = bool(rec.get("feedbackID"))
                qa["recordsTaskPlan"] += 1
                if status == "COMPLETED":
                    qa["taskPlanCompleted"] += 1
                elif status == "MISSED":
                    qa["taskPlanMissed"] += 1

                bucket_key = d + "|" + obj
                bucket = by_object_day[bucket_key] if is_planned else by_object_day_unplanned[bucket_key]
                if status in STATUSES:
                    bucket[status] += 1
                if status == "COMPLETED":
                    dl_deadline = parse_dt(rec.get("completionDeadlineDate"))
                    dl_complete = parse_dt(rec.get("date_complete") or rec.get("completionDate"))
                    if dl_deadline is not None and dl_complete is not None:
                        delay_h = (dl_complete - dl_deadline) / 3600.0
                        if delay_h > 0:
                            bucket["completedLate"] += 1
                            bucket["delayHoursSum"] += delay_h
                            bucket["delayHoursN"] += 1
                        else:
                            bucket["completedOnTime"] += 1
                    else:
                        bucket["completedOnTime"] += 1

                if is_feedback:
                    text = extract_feedback_text(rec.get("feedback"))
                    if text:
                        feedback_examples.append({
                            "date": d, "objectID": obj,
                            "zoneID": str(rec.get("zoneID") or ""),
                            "text": text[:300],
                        })

        # --- statByZone: объём по зонам (для treemap) ---
        sz_path = day_dir / "statByZone.json.gz"
        if sz_path.exists():
            for rec in read_json_gz(sz_path):
                d = day_of(rec)
                if not d:
                    continue
                z = str(rec.get("zoneID") or "")
                if not z:
                    continue
                key = d + "|" + z
                qa["recordsStatZone"] += 1
                c = rec.get("completedTasksCount", 0) or 0
                m = rec.get("missedTasksCount", 0) or 0
                qa["statCompleted"] += c
                qa["statMissed"] += m
                slot = by_zone_day[key]
                slot["objectID"] = str(rec.get("objectID") or slot["objectID"])
                slot["completed"] += c
                slot["missed"] += m

        # --- statByEmployee: индивидуальная часть эффективности ---
        se_path = day_dir / "statByEmployee.json.gz"
        se_rows = list(read_json_gz(se_path)) if se_path.exists() else []
        for rec in se_rows:
            d = day_of(rec)
            eid = str(rec.get("employeeID") or "")
            if not d or not eid:
                continue
            qa["recordsStatEmployee"] += 1
            c = rec.get("completedTasksCount", 0) or 0
            m = rec.get("missedTasksCount", 0) or 0
            slot = by_employee_day[d + "|" + eid]
            slot["ai"] += c + m
            slot["ci"] += c

        # --- statByTeam: командная часть, распределяется поровну на всех участников ---
        st_path = day_dir / "statByTeam.json.gz"
        st_rows = list(read_json_gz(st_path)) if st_path.exists() else []
        for rec in st_rows:
            d = day_of(rec)
            tid = str(rec.get("teamID") or "")
            if not d or not tid:
                continue
            qa["recordsStatTeam"] += 1
            team = team_membership.get(tid)
            if not team or team["size"] == 0:
                continue  # команда не найдена в справочнике или пуста — доля никому не начисляется
            c = rec.get("completedTasksCount", 0) or 0
            m = rec.get("missedTasksCount", 0) or 0
            share_assigned = (c + m) / team["size"]
            share_completed = c / team["size"]
            for member_id in team["memberIDs"]:
                slot = by_employee_day[d + "|" + member_id]
                slot["at"] += share_assigned
                slot["ct"] += share_completed

        if i % 30 == 0 or i == len(days):
            print("\r     %d/%d дней обработано" % (i, len(days)), end="", flush=True)
    print()

    # ужимаем bucket-словари: planned/unplanned сводим в одну запись на "date|objectID"
    by_object_day_combined = {}
    keys = set(by_object_day) | set(by_object_day_unplanned)
    for k in keys:
        by_object_day_combined[k] = {
            "planned": by_object_day.get(k, empty_bucket()),
            "unplanned": by_object_day_unplanned.get(k, empty_bucket()),
        }

    feedback_examples = feedback_examples[-feedback_cap:] if feedback_cap else feedback_examples

    return by_object_day_combined, dict(by_zone_day), dict(by_employee_day), feedback_examples, qa


# --------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", default="archive", help="Путь к архиву fetch_bruno.py (по умолчанию ./archive)")
    ap.add_argument("--out", default="model.json.gz", help="Куда сохранить агрегат (по умолчанию ./model.json.gz)")
    ap.add_argument("--project-id", default=None,
                    help="projectID для фильтрации user.projects[] (если не указан — берётся первая заполненная роль)")
    ap.add_argument("--feedback-cap", type=int, default=1000,
                    help="Сколько последних текстов обращений сохранить в модели (по умолчанию 1000, 0 = не хранить)")
    args = ap.parse_args()

    archive = Path(args.archive)
    if not archive.exists():
        raise SystemExit("ОШИБКА: архив не найден: %s" % archive.resolve())

    manifest_path = archive / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit("ОШИБКА: manifest.json не найден в %s" % archive.resolve())
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    print("=" * 66)
    print("build_model.py -> model.json.gz")
    print("  Архив:  %s" % archive.resolve())
    print("  Выход:  %s" % Path(args.out).resolve())
    print("=" * 66)

    snap_date, objects, zones, users, teams, roles = load_directories(archive)
    role_lookup = build_role_lookup(roles)
    team_membership = build_team_membership(teams)
    employee_dir, emp_stats = build_employee_directory(users, role_lookup, team_membership, args.project_id)

    log("Сотрудников без роли: %d, с неоднозначной ролью (>1 проект): %d, без команды: %d, в 2+ командах: %d"
        % (emp_stats["noRole"], emp_stats["ambiguousRole"], emp_stats["noTeam"], emp_stats["multiTeam"]), "ok")

    by_object_day, by_zone_day, by_employee_day, feedback_examples, qa = process_archive(
        archive, manifest, employee_dir, team_membership, args.feedback_cap)

    obj_dict = {uid(o): o.get("name") or "" for o in objects if not o.get("deleted")}
    zone_dict = {uid(z): {"name": z.get("name") or "", "objectID": str(z.get("objectID") or "")}
                 for z in zones if not z.get("deleted")}
    team_dict = {tid: {"name": t["name"], "size": t["size"]} for tid, t in team_membership.items()}

    days_sorted = sorted(manifest.get("days", {}).keys())
    model = {
        "meta": {
            "generatedFromSnapshot": snap_date,
            "archiveDays": len(days_sorted),
            "archiveFrom": days_sorted[0] if days_sorted else None,
            "archiveTo": days_sorted[-1] if days_sorted else None,
            "objectsCount": len(obj_dict), "zonesCount": len(zone_dict),
            "employeesCount": len(employee_dir), "teamsCount": len(team_dict),
        },
        "directories": {
            "objects": obj_dict,
            "zones": zone_dict,
            "employees": employee_dir,
            "teams": team_dict,
        },
        "daily": {
            "byObjectDay": by_object_day,
            "byZoneDay": by_zone_day,
            "byEmployeeDay": by_employee_day,
        },
        "feedbackExamples": feedback_examples,
    }

    tmp = Path(args.out + ".part")
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as f:
        json.dump(model, f, ensure_ascii=False, separators=(",", ":"), default=str)
    tmp.replace(args.out)
    size = Path(args.out).stat().st_size

    print("\n" + "=" * 66)
    print("ГОТОВО: %s (%s)" % (args.out, human(size)))
    print("  byObjectDay: %d записей ('дата|объект')" % len(by_object_day))
    print("  byZoneDay:   %d записей ('дата|зона')" % len(by_zone_day))
    print("  byEmployeeDay: %d записей ('дата|сотрудник')" % len(by_employee_day))
    print("  feedbackExamples: %d текстов сохранено" % len(feedback_examples))
    print("-" * 66)
    print("QA сверка (Bruno statByZone vs сырой taskPlan, должны быть близки):")
    print("  taskPlan:  completed=%s missed=%s" % (
        "{:,}".format(qa["taskPlanCompleted"]).replace(",", " "),
        "{:,}".format(qa["taskPlanMissed"]).replace(",", " ")))
    print("  statByZone: completed=%s missed=%s" % (
        "{:,}".format(qa["statCompleted"]).replace(",", " "),
        "{:,}".format(qa["statMissed"]).replace(",", " ")))
    print("  Записей обработано: taskPlan=%s statByEmployee=%s statByTeam=%s statByZone=%s" % (
        "{:,}".format(qa["recordsTaskPlan"]).replace(",", " "),
        "{:,}".format(qa["recordsStatEmployee"]).replace(",", " "),
        "{:,}".format(qa["recordsStatTeam"]).replace(",", " "),
        "{:,}".format(qa["recordsStatZone"]).replace(",", " ")))
    print("=" * 66)


if __name__ == "__main__":
    main()
