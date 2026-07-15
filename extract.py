#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bruno API → data.json extractor

Тянет справочники (object, zone, workType, user, team) и события
(feedback, taskPlan, remark, surveyResult) за заданный период и сохраняет
всё в data.json — источник данных для dashboard_live.html.

Использование:
    python extract.py --token <JWT> --from 2025-01-01 --to 2026-07-02
    python extract.py --token <JWT> --from 2025-01-01 --to 2026-07-02 --out data.json

Опционально:
    --project-id <UUID>   явно задать projectID (иначе определится из токена)
    --page-limit 500      размер страницы (по умолчанию 500 — максимум API)
    --pause-ms 100        пауза между запросами в мс, чтобы не упереться в rate limit
    --skip <resource>     пропустить ресурс (можно несколько раз)
    --dry-run             только проверить токен и права, без выгрузки
    --gzip                сжать выходной файл (gzip); либо просто укажите --out data.json.gz

Требуется Python 3.8+ и пакет requests:
    pip install requests
"""

import argparse
import gzip
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

try:
    import requests
except ImportError:
    print("ОШИБКА: не установлен пакет 'requests'.")
    print("Установите: pip install requests")
    sys.exit(1)


API_BASE = "https://api.brunosystem.ru"
DEFAULT_PAGE_LIMIT = 500  # максимум по API

# Ресурсы, которые тянем. date_field указывает поле для фильтра по периоду.
# None значит справочник — тянем целиком без фильтра.
RESOURCES = [
    # Справочники
    ("object",       "/api/v2/object",       None),
    ("zone",         "/api/v2/zone",         None),
    ("workType",     "/api/v2/workType",     None),
    ("user",         "/api/v2/user",         None),
    ("team",         "/api/v2/team",         None),
    # События
    ("feedback",     "/api/v2/feedback",     "date"),
    ("taskPlan",     "/api/v2/taskPlan",     "date"),
    ("remark",       "/api/v2/remark",       "date"),
    ("surveyResult", "/api/v2/surveyResult", "date"),
]


def iso_utc(dt):
    """ISO-строка с миллисекундами и суффиксом Z."""
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def log(msg, level="info"):
    """Простой цветной лог для терминала. В Windows cmd работает без цветов, но не ломается."""
    prefix = {"info": "  ", "ok": "  ✓ ", "warn": "  ! ", "err": "  ✗ ", "step": "\n→ "}[level]
    print(f"{prefix}{msg}")


def get_project_info(session, headers):
    """Определяет projectID и (если API их отдаёт) права по токену.

    Реальный ответ /api/v2/apiToken (проверено на живом API 15.07.2026):
        {"result": "ok", "projectID": "<uuid>"}
    — projectID лежит на ВЕРХНЕМ уровне, а result — это просто строка-статус,
    отдельного объекта apiRule в ответе нет. Поэтому предварительно проверить
    read-права по токену нельзя — полагаемся на живые ответы 403 по каждому ресурсу.
    На всякий случай поддерживаем и старую вложенную форму {"result": {...}}.
    """
    url = f"{API_BASE}/api/v2/apiToken"
    try:
        resp = session.get(url, headers=headers, timeout=15)
    except requests.RequestException as e:
        log(f"сеть недоступна: {e}", "err")
        raise
    if resp.status_code == 401:
        log("401 Unauthorized — токен неверный или истёк", "err")
        raise SystemExit(1)
    resp.raise_for_status()
    try:
        body = resp.json()
    except ValueError:
        log(f"ответ /apiToken не JSON: {resp.text[:300]}", "warn")
        return None, {}

    project_id = body.get("projectID")
    api_rule = {}
    result = body.get("result")
    if isinstance(result, dict):
        # Старая (ожидавшаяся) вложенная форма — projectID и apiRule внутри result.
        project_id = project_id or result.get("projectID")
        api_rule = result.get("apiRule", {}) or {}
    return project_id, api_rule


def fetch_all(session, path, headers, filter_str, resource_name, page_limit, pause_ms):
    """Тянет все страницы ресурса. Возвращает список объектов."""
    items = []
    from_ = 0
    page = 0
    while True:
        params = {"from": from_, "limit": page_limit}
        if filter_str:
            params["filter"] = filter_str
        url = f"{API_BASE}{path}?{urlencode(params)}"
        try:
            resp = session.get(url, headers=headers, timeout=45)
        except requests.RequestException as e:
            log(f"[{resource_name}] сеть: {e}", "err")
            return items

        if resp.status_code == 403:
            log(f"[{resource_name}] 403 Forbidden — у токена нет прав. Пропускаю.", "warn")
            return []
        if resp.status_code == 404:
            log(f"[{resource_name}] 404 Not Found — эндпоинт не существует. Пропускаю.", "warn")
            return []
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", "5"))
            log(f"[{resource_name}] 429 rate limit — жду {wait} сек", "warn")
            time.sleep(wait)
            continue
        if resp.status_code >= 400:
            log(f"[{resource_name}] HTTP {resp.status_code}: {resp.text[:200]}", "err")
            return items

        try:
            body = resp.json()
        except ValueError:
            log(f"[{resource_name}] ответ не JSON: {resp.text[:200]}", "err")
            return items

        chunk = body.get("result", [])
        if not isinstance(chunk, list):
            log(f"[{resource_name}] неожиданный формат ответа (result не массив)", "err")
            return items

        overall = body.get("overall", len(items) + len(chunk))
        items.extend(chunk)
        page += 1
        print(f"\r  [{resource_name}] стр {page}: {len(items)}/{overall}", end="", flush=True)

        if len(chunk) < page_limit:
            break
        from_ += page_limit
        if pause_ms > 0:
            time.sleep(pause_ms / 1000.0)
    print()  # финальный перевод строки
    return items


def main():
    parser = argparse.ArgumentParser(description="Bruno API → data.json extractor", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    parser.add_argument("--token", required=True, help="JWT API-токен Bruno")
    parser.add_argument("--from", dest="date_from", required=True, help="Начало периода YYYY-MM-DD")
    parser.add_argument("--to", dest="date_to", required=True, help="Конец периода YYYY-MM-DD")
    parser.add_argument("--out", default="data.json", help="Выходной файл (default: data.json). Если оканчивается на .gz — файл сжимается.")
    parser.add_argument("--gzip", action="store_true", help="Сжать выходной файл gzip'ом, даже если --out не оканчивается на .gz")
    parser.add_argument("--project-id", help="Явно задать projectID (иначе определится по токену)")
    parser.add_argument("--page-limit", type=int, default=DEFAULT_PAGE_LIMIT, help=f"Размер страницы (default: {DEFAULT_PAGE_LIMIT})")
    parser.add_argument("--pause-ms", type=int, default=100, help="Пауза между запросами в мс (default: 100)")
    parser.add_argument("--skip", action="append", default=[], help="Пропустить ресурс (можно указать несколько раз)")
    parser.add_argument("--dry-run", action="store_true", help="Проверить токен и права, без выгрузки")
    args = parser.parse_args()

    # Парсим даты
    try:
        d_from = datetime.strptime(args.date_from, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        d_to = datetime.strptime(args.date_to, "%Y-%m-%d").replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)
    except ValueError as e:
        log(f"неверный формат даты: {e}", "err")
        sys.exit(1)
    if d_from > d_to:
        log("--from не может быть позже --to", "err")
        sys.exit(1)

    out_path = Path(args.out)
    use_gzip = args.gzip or out_path.suffix == ".gz"

    print("=" * 60)
    print("Bruno API extractor")
    print(f"  Base URL: {API_BASE}")
    print(f"  Период: {args.date_from} — {args.date_to}")
    print(f"  Выход:  {args.out}{'  (gzip)' if use_gzip else ''}")
    print("=" * 60)

    session = requests.Session()
    headers = {
        "token": args.token,
        "Accept": "application/json",
        "User-Agent": "bruno-dashboard-extractor/1.0",
    }

    # 1. projectID и права
    log("Определяю projectID и права токена…", "step")
    project_id = args.project_id
    api_rule = {}
    try:
        detected_pid, api_rule = get_project_info(session, headers)
        if not project_id:
            project_id = detected_pid
        log(f"projectID: {project_id or '<не определён>'}", "ok")
        allowed = sorted([k for k, v in api_rule.items() if isinstance(v, dict) and v.get("read")])
        if allowed:
            log(f"read-права ({len(allowed)}): {', '.join(allowed)}", "ok")
        else:
            log("предупреждение: не вижу явных read-прав; попробую всё равно", "warn")
    except SystemExit:
        raise
    except Exception as e:
        log(f"не удалось получить apiToken: {e}", "warn")
        log("продолжаю без валидации прав…", "warn")

    if project_id:
        headers["projectid"] = project_id

    if args.dry_run:
        log("--dry-run: выгрузка не выполнялась", "ok")
        sys.exit(0)

    # 2. Фильтр по периоду
    filter_events = f"date ge '{iso_utc(d_from)}' AND date le '{iso_utc(d_to)}'"

    # 3. Тянем всё
    result = {
        "meta": {
            "extractedAt": datetime.now(timezone.utc).isoformat(),
            "period": {"from": args.date_from, "to": args.date_to},
            "projectID": project_id,
            "source": "bruno-api",
            "apiBase": API_BASE,
        }
    }
    for name, path, date_field in RESOURCES:
        if name in args.skip:
            log(f"{name} — пропущен по флагу --skip", "step")
            result[name] = []
            continue
        # Проверяем права если есть
        rule = api_rule.get(name, {}) if api_rule else {}
        if isinstance(rule, dict) and rule and not rule.get("read"):
            log(f"{name} — нет read-права, пропускаю", "warn")
            result[name] = []
            continue

        log(f"{name}…", "step")
        f_str = filter_events if date_field else None
        try:
            items = fetch_all(session, path, headers, f_str, name, args.page_limit, args.pause_ms)
            result[name] = items
        except KeyboardInterrupt:
            log("прерывание пользователем — сохраняю то, что успел", "warn")
            result[name] = []
            break
        except Exception as e:
            log(f"[{name}] неожиданная ошибка: {e}", "err")
            result[name] = []

    # 4. Сохраняем
    try:
        if use_gzip:
            with gzip.open(out_path, "wt", encoding="utf-8", compresslevel=6) as f:
                json.dump(result, f, ensure_ascii=False, default=str)
        else:
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, default=str)
    except Exception as e:
        log(f"не удалось записать {out_path}: {e}", "err")
        sys.exit(1)

    size_kb = out_path.stat().st_size / 1024
    print()
    print("=" * 60)
    log(f"Сохранено: {out_path.resolve()} ({size_kb:,.1f} КБ){' (gzip)' if use_gzip else ''}", "ok")
    print()
    print("Итоги:")
    for name, _, _ in RESOURCES:
        cnt = len(result.get(name, []))
        print(f"  {name:15s} {cnt:>7,}")
    print("=" * 60)


if __name__ == "__main__":
    main()
