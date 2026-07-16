#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bruno API -> data.json (АГРЕГАТНАЯ схема, ~230 КБ) — робот для GitHub Actions.

Отличие от старого extract.py: НЕ тянет 1.58 млн сырых задач (~13 МБ), а собирает
компактные агрегаты, которые ждёт dashboard_vtb_live.html (см. ТЗ §3):

  meta / directories(object,zone,user,team,workType)
  daily      — суточные итоги за всю историю (statBy*/byDays): {дата:{all,completed,missed}}
  window     — суммы за окно 30 дней по объект/зона/сотрудник/команда {c,m,w}
               + feedbackTasks (taskPlan c feedbackID ne null за окно)
  categories — обращения vs плановые за окно

Токен — ТОЛЬКО из окружения BRUNO_TOKEN (в код не писать).

Запуск:
  python build-data.py --token "$BRUNO_TOKEN" --from 2025-01-01 --to 2026-07-16 --out data.json

⚠️  Точные имена полей ответов statBy*/byDays в песочнице могут отличаться.
    Скрипт логирует ПЕРВУЮ запись каждого ответа (--debug-sample) и мапит поля по
    списку кандидатов (FIELD_CANDIDATES). Если поле не распозналось — увидите это в
    логе и поправите один список. Недоступные ресурсы (403/404) → пустой раздел
    (дашборд покажет честную заглушку, а не сломается).
"""
import argparse, json, sys, time, gzip
from datetime import datetime, timezone, timedelta
from urllib.parse import urlencode

try:
    import requests
except ImportError:
    print("ОШИБКА: pip install requests"); sys.exit(1)

API_BASE = "https://api.brunosystem.ru"
PAGE_LIMIT = 500
PAUSE_MS = 1100  # держим rate limit 60/60с с запасом

# Кандидаты имён полей (мапинг по живому ответу; порядок = приоритет)
FC = {
    "id":        ["id", "uuid", "_id"],
    "objectID":  ["objectID", "object_id", "objectId"],
    "zoneID":    ["zoneID", "zone_id", "zoneId"],
    "userID":    ["userID", "employeeID", "user_id", "id"],
    "teamID":    ["teamID", "team_id", "id"],
    "date":      ["date", "day", "statDate", "reportDate"],
    "all":       ["allTasksCount", "all", "total", "totalCount", "count"],
    "completed": ["completedTasksCount", "completed", "completedCount", "done"],
    "missed":    ["missedTasksCount", "missed", "missedCount", "overdue"],
    "warnings":  ["warningsCount", "warnings", "warning", "warn"],
    "name":      ["name", "title", "fullName"],
    "address":   ["address", "addr"],
    "firstName": ["firstName", "first_name"],
    "lastName":  ["lastName", "last_name"],
    "status":    ["status", "state"],
    "feedbackID":["feedbackID", "feedback_id", "feedbackId"],
}

def pick(o, key, default=None):
    for k in FC.get(key, [key]):
        if isinstance(o, dict) and o.get(k) not in (None, ""):
            return o[k]
    return default

def _as_rows(res):
    """Приводит result к списку записей. Понимает: список; {ключ-дата: {...}} → добавляет date;
    {'rows'/'days'/'items'/'data': [...]} → берёт вложенный список. Иначе None (не распознали)."""
    if isinstance(res, list):
        return res
    if isinstance(res, dict):
        # вложенный список под каким-либо ключом
        for v in res.values():
            if isinstance(v, list):
                return v
        # словарь, ключи которого — даты, значения — {all/completed/missed}
        rows, ok = [], False
        for k, v in res.items():
            if isinstance(v, dict):
                d = parse_day(k) or parse_day(pick(v, "date"))
                if d:
                    ok = True
                    rows.append({**v, "date": d})
        if ok:
            return rows
    return None

def iso_utc(dt): return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
def log(m, lvl="info"):
    print({"info": "  ", "ok": "  ✓ ", "warn": "  ! ", "err": "  ✗ ", "step": "\n→ "}[lvl] + str(m))

def parse_day(v):
    if not v: return None
    s = str(v)[:10]
    try: datetime.strptime(s, "%Y-%m-%d"); return s
    except ValueError: return None

def get_json(session, path, headers, params=None):
    url = f"{API_BASE}{path}" + (("?" + urlencode(params)) if params else "")
    r = session.get(url, headers=headers, timeout=45)
    return r

def project_info(session, headers):
    r = get_json(session, "/api/v2/apiToken", headers)
    if r.status_code == 401:
        log("401 — токен неверный/истёк", "err"); raise SystemExit(1)
    r.raise_for_status()
    body = r.json()
    res = body.get("result", body) if isinstance(body, dict) else {}
    if not isinstance(res, dict): res = {}
    rule = res.get("apiRule", {})
    return res.get("projectID"), (rule if isinstance(rule, dict) else {})

def fetch_all(session, path, headers, filt, name, debug=False):
    """Пагинация from+limit. Возвращает список result[]. 403/404 -> []."""
    items, frm, page = [], 0, 0
    while True:
        params = {"from": frm, "limit": PAGE_LIMIT}
        if filt: params["filter"] = filt
        r = get_json(session, path, headers, params)
        if r.status_code in (403, 404):
            log(f"[{name}] HTTP {r.status_code} — пропускаю (дашборд покажет заглушку)", "warn"); return []
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", "5")); log(f"[{name}] 429 — жду {wait}с", "warn"); time.sleep(wait); continue
        if r.status_code >= 400:
            log(f"[{name}] HTTP {r.status_code}: {r.text[:160]}", "err"); return items
        try: body = r.json()
        except ValueError:
            log(f"[{name}] не JSON: {r.text[:160]}", "err"); return items
        res = body.get("result", body) if isinstance(body, dict) else body
        chunk = _as_rows(res)
        if chunk is None:
            # не распознали форму — логируем реальную структуру, чтобы поправить парсер
            keys = list(res.keys()) if isinstance(res, dict) else type(res).__name__
            log(f"[{name}] result не массив; ключи/тип: {keys}", "warn")
            log(f"[{name}] сырой ответ (обрезан): {json.dumps(res, ensure_ascii=False, default=str)[:400]}", "info")
            return items
        if (debug or page == 0) and chunk:
            log(f"[{name}] пример записи: {json.dumps(chunk[0], ensure_ascii=False, default=str)[:300]}", "info")
        items += chunk; page += 1
        overall = body.get("overall", len(items))
        print(f"\r  [{name}] стр {page}: {len(items)}/{overall}", end="", flush=True)
        if len(chunk) < PAGE_LIMIT: break
        frm += PAGE_LIMIT; time.sleep(PAUSE_MS / 1000.0)
    print(); return items

def cmw(o):
    c = int(pick(o, "completed", 0) or 0)
    m = int(pick(o, "missed", 0) or 0)
    w = int(pick(o, "warnings", 0) or 0)
    return c, m, w

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", required=True)
    ap.add_argument("--from", dest="date_from", required=True)
    ap.add_argument("--to", dest="date_to", required=True)
    ap.add_argument("--out", default="data.json")
    ap.add_argument("--window-days", type=int, default=30)
    ap.add_argument("--project-id")
    ap.add_argument("--gz", action="store_true")
    ap.add_argument("--debug-sample", action="store_true", help="печатать первую запись каждого ответа")
    args = ap.parse_args()

    d_from = datetime.strptime(args.date_from, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    d_to = datetime.strptime(args.date_to, "%Y-%m-%d").replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
    win_from = (d_to - timedelta(days=args.window_days - 1)).replace(hour=0, minute=0, second=0)

    session = requests.Session()
    headers = {"token": args.token, "Accept": "application/json", "User-Agent": "bruno-agg/1.0"}

    log("projectID и права…", "step")
    pid = args.project_id
    api_rule = {}
    try:
        det, api_rule = project_info(session, headers)
        pid = pid or det
        allowed = sorted(k for k, v in api_rule.items() if isinstance(v, dict) and v.get("read"))
        log(f"projectID: {pid}", "ok")
        if allowed: log(f"read-права: {', '.join(allowed)}", "ok")
    except SystemExit: raise
    except Exception as e:
        log(f"apiToken не прочитан ({e}); продолжаю", "warn")
    if pid: headers["projectid"] = pid

    dbg = args.debug_sample

    # --- справочники ---
    log("Справочники…", "step")
    raw_obj  = fetch_all(session, "/api/v2/object",   headers, None, "object", dbg)
    raw_zone = fetch_all(session, "/api/v2/zone",     headers, None, "zone", dbg)
    raw_user = fetch_all(session, "/api/v2/user",     headers, None, "user", dbg)
    raw_team = fetch_all(session, "/api/v2/team",     headers, None, "team", dbg)
    raw_wt   = fetch_all(session, "/api/v2/workType", headers, None, "workType", dbg)

    objects = [{"id": str(pick(o, "id")), "name": pick(o, "name", "(без имени)"), "address": pick(o, "address")}
               for o in raw_obj if not o.get("deleted")]
    zones = [{"id": str(pick(z, "id")), "objectID": str(pick(z, "objectID", "")), "name": pick(z, "name", "(без имени)")}
             for z in raw_zone if not z.get("deleted")]
    def uname(u):
        return pick(u, "name") or " ".join(x for x in [pick(u, "lastName"), pick(u, "firstName")] if x) or "(без имени)"
    users = [{"id": str(pick(u, "id")), "name": uname(u)} for u in raw_user if not u.get("deleted")]
    teams = [{"id": str(pick(t, "id")), "name": pick(t, "name", "(без имени)")} for t in raw_team if not t.get("deleted")]
    work_types = [{"id": str(pick(w, "id")), "name": pick(w, "name", "(без имени)")} for w in raw_wt if not w.get("deleted")]

    filt_hist = f"date ge '{iso_utc(d_from)}' AND date le '{iso_utc(d_to)}'"
    filt_win  = f"date ge '{iso_utc(win_from)}' AND date le '{iso_utc(d_to)}'"

    # --- daily: суточные итоги за всю историю (statBy*/byDays) ---
    log("Суточные итоги (statBy*/byDays)…", "step")
    def daily_from(path, name):
        rows = fetch_all(session, path, headers, filt_hist, name, dbg)
        out = {}
        for r in rows:
            ds = parse_day(pick(r, "date"))
            if not ds: continue
            acc = out.setdefault(ds, {"allTasksCount": 0, "completedTasksCount": 0, "missedTasksCount": 0})
            acc["allTasksCount"]       += int(pick(r, "all", 0) or 0)
            acc["completedTasksCount"] += int(pick(r, "completed", 0) or 0)
            acc["missedTasksCount"]    += int(pick(r, "missed", 0) or 0)
        return out
    daily = {
        "zone":     daily_from("/api/v2/statByZone/byDays",     "statByZone/byDays"),
        "employee": daily_from("/api/v2/statByEmployee/byDays", "statByEmployee/byDays"),
        "team":     daily_from("/api/v2/statByTeam/byDays",     "statByTeam/byDays"),
    }

    # --- window: суммы за 30 дней по сущностям ---
    log("Окно 30 дней (statBy* суммы)…", "step")
    def win_sums(path, name, id_key):
        rows = fetch_all(session, path, headers, filt_win, name, dbg)
        agg = {}
        for r in rows:
            eid = str(pick(r, id_key, ""))
            if not eid: continue
            c, m, w = cmw(r)
            a = agg.setdefault(eid, {"c": 0, "m": 0, "w": 0})
            a["c"] += c; a["m"] += m; a["w"] += w
        return agg
    byZone     = win_sums("/api/v2/statByZone",     "statByZone",     "zoneID")
    byEmployee = win_sums("/api/v2/statByEmployee", "statByEmployee", "userID")
    byTeam     = win_sums("/api/v2/statByTeam",     "statByTeam",     "teamID")
    # statByObject в песочнице отдаёт 404 → объектные суммы собираем из зон (zone→object по справочнику)
    zone_obj = {z["id"]: z["objectID"] for z in zones}
    byObject = {}
    for zid, v in byZone.items():
        oid = zone_obj.get(zid)
        if not oid: continue
        a = byObject.setdefault(oid, {"c": 0, "m": 0, "w": 0})
        a["c"] += v["c"]; a["m"] += v["m"]; a["w"] += v["w"]
    window = {"byObject": byObject, "byZone": byZone, "byEmployee": byEmployee, "byTeam": byTeam}

    # --- feedbackTasks: обращения (taskPlan c feedbackID ne null) за окно ---
    log("Обращения окна (taskPlan feedbackID ne null)…", "step")
    filt_fb = filt_win + " AND feedbackID ne null"
    raw_fb = fetch_all(session, "/api/v2/taskPlan", headers, filt_fb, "taskPlan(feedback)", dbg)
    feedback_tasks = []
    for t in raw_fb:
        if t.get("deleted"): continue
        feedback_tasks.append({
            "d": parse_day(pick(t, "date")) or "",
            "o": str(pick(t, "objectID", "")),
            "z": str(pick(t, "zoneID", "")),
            "s": str(pick(t, "status", "NEW")).upper(),
            "e": str(t.get("employeeID") or t.get("userID") or ""),
            "t": str(t.get("teamID") or ""),
        })
    window["feedbackTasks"] = feedback_tasks

    # --- categories: обращения vs плановые за окно ---
    def cat(tasks):
        return {"all": len(tasks),
                "completed": sum(1 for x in tasks if x["s"] == "COMPLETED"),
                "missed": sum(1 for x in tasks if x["s"] == "MISSED")}
    fb_cat = cat(feedback_tasks)
    tot_all = sum(v["c"] + v["m"] + v["w"] for v in window["byObject"].values())
    tot_comp = sum(v["c"] for v in window["byObject"].values())
    tot_miss = sum(v["m"] for v in window["byObject"].values())
    categories = {
        "total": {"all": tot_all, "completed": tot_comp, "missed": tot_miss},
        "feedback": fb_cat,
        "planned": {"all": max(0, tot_all - fb_cat["all"]),
                    "completed": max(0, tot_comp - fb_cat["completed"]),
                    "missed": max(0, tot_miss - fb_cat["missed"])},
    }

    data = {
        "meta": {
            "extractedAt": datetime.now(timezone.utc).isoformat(),
            "projectID": pid, "source": "bruno-api",
            "historyFrom": args.date_from, "historyTo": args.date_to,
            "windowDays": args.window_days,
            "windowFrom": win_from.date().isoformat(), "windowTo": d_to.date().isoformat(),
            "workTypeAvailable": bool(work_types),
        },
        "directories": {"object": objects, "zone": zones, "user": users, "team": teams, "workType": work_types},
        "daily": daily, "window": window, "categories": categories,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"), default=str)
    if args.gz:
        with gzip.open(args.out + ".gz", "wb", compresslevel=9) as f:
            f.write(json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))

    size = len(json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))
    print("=" * 56)
    log(f"Готово: {args.out}  raw={size/1024:.1f} КБ", "ok")
    log(f"object={len(objects)} zone={len(zones)} user={len(users)} team={len(teams)} workType={len(work_types)}", "ok")
    log(f"daily.zone дней={len(daily['zone'])} · окно fbTasks={len(feedback_tasks)}", "ok")
    log(f"categories={categories}", "ok")
    if not daily["zone"] and not daily["employee"] and not daily["team"]:
        log("ВНИМАНИЕ: daily пуст — проверьте имена полей ответа statBy*/byDays (FIELD_CANDIDATES) через --debug-sample", "warn")
    print("=" * 56)

if __name__ == "__main__":
    main()
