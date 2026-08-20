#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Bruno API -> посуточный сырой архив (дашборд 2.0, этап 1).

Складывает данные по одному каталогу на КАЖДЫЕ СУТКИ, чтобы:
  * не перезапрашивать уже выгруженное (инкрементальность),
  * переживать обрыв связи и продолжать с места остановки,
  * пересобирать модель отчёта из архива, не ходя в API заново.

Структура архива:
    archive/
      manifest.json                       - что уже выгружено, сколько записей, размеры
      dirs/<дата>/<ресурс>.json.gz        - справочники (снимок на дату выгрузки)
      raw/<дата>/taskPlan.jsonl.gz        - сырые задачи за сутки (по одной на строку)
      raw/<дата>/statByZone.json.gz       - нативные агрегаты Bruno за сутки
      raw/<дата>/statByEmployee.json.gz
      raw/<дата>/statByTeam.json.gz

Сутки нарезаются по полю `date` в UTC. Локальные сутки (`dateLocal`) отличаются на
часовой пояс — это учитывается на этапе сборки модели, а не здесь: архив должен быть
дословным срезом того, что отдал API, без интерпретаций.

РЕЖИМЫ ЗАПУСКА
--------------
1) Оценка объёма, без скачивания (быстро, ~1 запрос на день):
       python fetch_bruno.py --token XXX --from 2026-01-01 --to 2026-08-19 --estimate

2) Один день + замер форматов хранения (этап 1, решаем как хранить архив):
       python fetch_bruno.py --token XXX --date 2026-08-18 --measure

3) Инкрементальный проход по диапазону (бэкфилл и ежедневное обновление):
       python fetch_bruno.py --token XXX --from 2026-01-01 --to 2026-08-19

   Дни, уже помеченные в манифесте как выгруженные, пропускаются. Последние
   --refresh-last суток (по умолчанию 5) перевыгружаются всегда: статусы задач
   доезжают задним числом.

Зависимости: requests (обязательно), pyarrow (необязательно, только для --measure).
"""

import argparse
import gzip
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

try:
    import requests
except ImportError:
    print("ОШИБКА: не установлен пакет 'requests'. Выполните: pip install requests")
    sys.exit(1)

API_BASE = "https://api.brunosystem.ru"

# Ресурсы нативной статистики Bruno, выгружаемые посуточно.
STAT_RESOURCES = [
    ("statByZone", "/api/v2/statByZone"),
    ("statByEmployee", "/api/v2/statByEmployee"),
    ("statByTeam", "/api/v2/statByTeam"),
]

# Справочники (не привязаны к суткам, снимок на дату выгрузки).
DIRECTORIES = [
    ("object", "/api/v2/object"),
    ("zone", "/api/v2/zone"),
    ("user", "/api/v2/user"),
    ("team", "/api/v2/team"),
    ("role", "/api/v2/role"),
    ("workType", "/api/v2/workType"),
]

# Поля taskPlan, которые реально используются отчётом. Всё остальное при режиме
# --fields slim отбрасывается. Состав подтверждён по СХЕМА_API_по_спеке.md и
# согласованному техплану; если понадобится новое поле — архив придётся перевыгрузить,
# поэтому набор намеренно избыточен.
SLIM_FIELDS = [
    "id", "name",
    "objectID", "zoneID", "teamID", "teamName", "employeeID", "employees",
    "status", "missedStatus",
    "date", "dateLocal", "activationDate", "deactivationDate",
    "completionDate", "completionDeadlineDate", "date_begin", "date_complete",
    "endedDateLocal", "durationMinutes",
    "feedbackID", "taskTemplateID", "taskRequestID", "taskID", "workTypeID",
    "statByZoneID", "statByEmployeeID", "statByTeamID", "shiftID",
    "actionsCount", "actionsDoneCount",
    "recreated", "deleted", "isPrivate",
    "timestamp",  # похоже на updatedAt — пригодится для инкрементальной догрузки
    "basedOnTaskPlanID",  # ссылка переделки на исходную задачу (блок 5b)
    "feedback",  # текст обращения через QR (примеры в отчёте/презентации)
    "results", "surveys",  # чек-листы/опросы — задел под будущий блок 05 "Качество"
]


# --------------------------------------------------------------------------- вывод

def log(msg, level="info"):
    prefix = {
        "info": "   ", "ok": "  + ", "warn": "  ! ", "err": "  x ", "step": "\n-> ",
    }[level]
    print(prefix + msg, flush=True)


def human(nbytes):
    for unit in ("Б", "КБ", "МБ", "ГБ"):
        if nbytes < 1024 or unit == "ГБ":
            return "%.1f %s" % (nbytes, unit)
        nbytes /= 1024.0


# ------------------------------------------------------------------------- сеть

def make_session():
    s = requests.Session()
    s.headers.update({"Accept": "application/json", "User-Agent": "bruno-archive/1.0"})
    return s


class Api:
    """Обёртка над API: пауза между запросами, ретраи, переоткрытие сессии."""

    def __init__(self, token, pause_ms=200, max_attempts=8, timeout=90):
        self.session = make_session()
        self.headers = {"token": token}
        self.pause = pause_ms / 1000.0
        self.max_attempts = max_attempts
        self.timeout = timeout
        self._last = 0.0
        self.requests_made = 0

    def _throttle(self):
        dt = time.monotonic() - self._last
        if dt < self.pause:
            time.sleep(self.pause - dt)
        self._last = time.monotonic()

    def get(self, path, params=None):
        url = API_BASE + path + (("?" + urlencode(params)) if params else "")
        wait = 2
        for attempt in range(1, self.max_attempts + 1):
            self._throttle()
            try:
                r = self.session.get(url, headers=self.headers, timeout=self.timeout)
                self.requests_made += 1
            except requests.RequestException as e:
                log("сеть (попытка %d/%d): %s" % (attempt, self.max_attempts, e), "warn")
                try:
                    self.session.close()
                except Exception:
                    pass
                self.session = make_session()
                time.sleep(wait)
                wait = min(wait * 2, 60)
                continue
            if r.status_code == 429:
                pause = int(r.headers.get("Retry-After", "5"))
                log("429 rate limit, пауза %d сек" % pause, "warn")
                time.sleep(pause)
                continue
            if r.status_code >= 500:
                log("HTTP %d, повтор через %d сек" % (r.status_code, wait), "warn")
                time.sleep(wait)
                wait = min(wait * 2, 60)
                continue
            return r
        return None

    def resolve_project(self):
        r = self.get("/api/v2/apiToken")
        if r is None or r.status_code != 200:
            return None
        body = r.json()
        pid = body.get("projectID")
        if not pid and isinstance(body.get("result"), dict):
            pid = body["result"].get("projectID")
        if pid:
            self.headers["projectid"] = pid
        return pid

    def count(self, path, flt):
        """Сколько всего записей подходит под фильтр (поле overall), без выгрузки."""
        r = self.get(path, {"from": 0, "limit": 1, "filter": flt})
        if r is None or r.status_code != 200:
            return None
        return r.json().get("overall")

    def pages(self, path, flt, page_limit=500):
        """Генератор страниц. Бросает RuntimeError, если страница не отдалась."""
        frm = 0
        while True:
            params = {"from": frm, "limit": page_limit}
            if flt:
                params["filter"] = flt
            r = self.get(path, params)
            if r is None:
                raise RuntimeError("%s: сеть недоступна после всех попыток" % path)
            if r.status_code != 200:
                raise RuntimeError("%s: HTTP %d %s" % (path, r.status_code, r.text[:200]))
            chunk = r.json().get("result")
            if not isinstance(chunk, list):
                raise RuntimeError("%s: неожиданный формат ответа" % path)
            yield chunk
            if len(chunk) < page_limit:
                return
            frm += page_limit


# ------------------------------------------------------------------- манифест

class Manifest:
    def __init__(self, path):
        self.path = Path(path)
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))
        else:
            self.data = {"version": 1, "days": {}, "dirs": {}}

    def save(self):
        self.data["updatedAt"] = datetime.now(timezone.utc).isoformat()
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.path)

    def is_done(self, day):
        rec = self.data["days"].get(day)
        return bool(rec and rec.get("complete"))

    def mark(self, day, counts, sizes, fields_mode):
        self.data["days"][day] = {
            "complete": True,
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
            "fields": fields_mode,
            "counts": counts,
            "bytes": sizes,
        }
        self.save()


# ------------------------------------------------------------------- утилиты

def day_filter(day):
    """Фильтр 'сутки по UTC' для поля date."""
    return "date ge '%sT00:00:00.000Z' AND date le '%sT23:59:59.999Z'" % (day, day)


def daterange(dfrom, dto):
    a = datetime.strptime(dfrom, "%Y-%m-%d").date()
    b = datetime.strptime(dto, "%Y-%m-%d").date()
    if b < a:
        raise SystemExit("ОШИБКА: --to раньше, чем --from")
    out, cur = [], a
    while cur <= b:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def slim(rec):
    return {k: rec[k] for k in SLIM_FIELDS if k in rec}


def write_json_gz(path, obj):
    tmp = Path(str(path) + ".part")
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as f:
        json.dump(obj, f, ensure_ascii=False, default=str)
    tmp.replace(path)
    return path.stat().st_size


# ------------------------------------------------------------------- выгрузка

def fetch_directories(api, archive, today):
    out_dir = archive / "dirs" / today
    out_dir.mkdir(parents=True, exist_ok=True)
    counts = {}
    log("Справочники (снимок на %s)" % today, "step")
    for name, path in DIRECTORIES:
        rows = []
        try:
            for chunk in api.pages(path, None):
                rows.extend(chunk)
        except RuntimeError as e:
            log("%s: %s -- пропускаю" % (name, e), "warn")
            counts[name] = None
            continue
        size = write_json_gz(out_dir / (name + ".json.gz"), rows)
        counts[name] = len(rows)
        log("%-10s %6d записей  (%s)" % (name, len(rows), human(size)), "ok")
    return counts


def fetch_day(api, archive, day, fields_mode, page_limit, collect_field_stats=False):
    """Выгружает сутки. Возвращает (counts, sizes, field_stats).

    Файлы пишутся через .part и переименовываются только при успехе, поэтому
    оборванная выгрузка не оставит правдоподобный, но неполный файл.
    """
    out_dir = archive / "raw" / day
    out_dir.mkdir(parents=True, exist_ok=True)
    flt = day_filter(day)
    counts, sizes = {}, {}
    field_stats = {}

    # --- taskPlan: пишем потоком, страница за страницей ---
    target = out_dir / "taskPlan.jsonl.gz"
    tmp = Path(str(target) + ".part")
    total = api.count("/api/v2/taskPlan", flt)
    n = 0
    with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=6) as f:
        for chunk in api.pages("/api/v2/taskPlan", flt, page_limit):
            for rec in chunk:
                if collect_field_stats:
                    for k, v in rec.items():
                        if v not in (None, "", [], {}):
                            field_stats[k] = field_stats.get(k, 0) + 1
                f.write(json.dumps(slim(rec) if fields_mode == "slim" else rec,
                                   ensure_ascii=False, default=str))
                f.write("\n")
            n += len(chunk)
            print("\r     taskPlan: %d%s" % (n, ("/%s" % total) if total else ""),
                  end="", flush=True)
    print()
    tmp.replace(target)
    counts["taskPlan"] = n
    sizes["taskPlan"] = target.stat().st_size

    # --- нативные агрегаты: объёмы небольшие, собираем целиком ---
    for name, path in STAT_RESOURCES:
        rows = []
        for chunk in api.pages(path, flt, page_limit):
            rows.extend(chunk)
        size = write_json_gz(out_dir / (name + ".json.gz"), rows)
        counts[name] = len(rows)
        sizes[name] = size

    return counts, sizes, field_stats


# --------------------------------------------------------------------- режимы

def mode_estimate(api, days):
    """Считает объём будущей выгрузки, ничего не скачивая."""
    print("\nОЦЕНКА ОБЪЁМА (запрашивается только счётчик, данные не качаются)")
    print("-" * 66)
    total, failed, per_day = 0, [], []
    t0 = time.time()
    for i, day in enumerate(days, 1):
        c = api.count("/api/v2/taskPlan", day_filter(day))
        if c is None:
            failed.append(day)
            c = 0
        per_day.append((day, c))
        total += c
        print("\r  %d/%d дней просмотрено, суммарно %s записей" % (i, len(days), "{:,}".format(total).replace(",", " ")),
              end="", flush=True)
    print("\n" + "-" * 66)
    nonzero = [c for _, c in per_day if c]
    print("Дней в диапазоне:        %d" % len(days))
    print("Дней с данными:          %d" % len(nonzero))
    print("Записей taskPlan всего:  %s" % "{:,}".format(total).replace(",", " "))
    if nonzero:
        print("В среднем за сутки:      %s" % "{:,}".format(int(sum(nonzero) / len(nonzero))).replace(",", " "))
        print("Максимум за сутки:       %s" % "{:,}".format(max(nonzero)).replace(",", " "))
        pages = sum((c + 499) // 500 for _, c in per_day)
        print("Страниц по 500:          %s (примерно столько запросов к API)" % "{:,}".format(pages).replace(",", " "))
        print("Оценка времени выгрузки: ~%.1f ч при паузе %.2f с между запросами"
              % (pages * (api.pause + 0.35) / 3600.0, api.pause))
    if failed:
        print("Не удалось опросить дней: %d (первый: %s)" % (len(failed), failed[0]))
    print("Опрос занял %.0f с\n" % (time.time() - t0))
    return per_day


def mode_measure(api, archive, day, page_limit):
    """Выгружает один день во ВСЕХ вариантах хранения и сравнивает размеры."""
    print("\nЗАМЕР ФОРМАТОВ ХРАНЕНИЯ на дне %s" % day)
    print("-" * 66)

    results = {}
    log("Вариант A: все поля (fields=full)", "step")
    counts_full, sizes_full, field_stats = fetch_day(
        api, archive / "_measure_full", day, "full", page_limit, collect_field_stats=True)
    results["full"] = sizes_full

    log("Вариант B: только используемые поля (fields=slim)", "step")
    counts_slim, sizes_slim, _ = fetch_day(
        api, archive / "_measure_slim", day, "slim", page_limit)
    results["slim"] = sizes_slim

    # Вариант C: parquet из slim-версии (если установлен pyarrow)
    parquet_size = None
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
        src = archive / "_measure_slim" / "raw" / day / "taskPlan.jsonl.gz"
        rows = []
        with gzip.open(src, "rt", encoding="utf-8") as f:
            for line in f:
                rows.append(json.loads(line))
        # employees[] — список; в parquet кладём как строку, чтобы не плодить схему
        for r in rows:
            if isinstance(r.get("employees"), list):
                r["employees"] = ",".join(str(x) for x in r["employees"])
        table = pa.Table.from_pylist(rows)
        dst = archive / "_measure_slim" / "raw" / day / "taskPlan.parquet"
        pq.write_table(table, dst, compression="zstd")
        parquet_size = dst.stat().st_size
    except ImportError:
        log("pyarrow не установлен -- вариант parquet пропущен "
            "(поставить: pip install pyarrow)", "warn")
    except Exception as e:
        log("parquet не собрался: %s" % e, "warn")

    # ---- отчёт ----
    tp_full = sizes_full["taskPlan"]
    tp_slim = sizes_slim["taskPlan"]
    stat_full = sum(v for k, v in sizes_full.items() if k != "taskPlan")

    print("\n" + "=" * 66)
    print("РЕЗУЛЬТАТ ЗАМЕРА  (день %s, записей taskPlan: %s)"
          % (day, "{:,}".format(counts_full["taskPlan"]).replace(",", " ")))
    print("=" * 66)
    print("  taskPlan, все поля      %12s" % human(tp_full))
    print("  taskPlan, только нужные %12s   (%.0f%% от полного)"
          % (human(tp_slim), 100.0 * tp_slim / tp_full if tp_full else 0))
    if parquet_size:
        print("  taskPlan, parquet+zstd  %12s   (%.0f%% от полного)"
              % (human(parquet_size), 100.0 * parquet_size / tp_full if tp_full else 0))
    print("  statBy* (три ресурса)   %12s" % human(stat_full))
    print("-" * 66)
    for label, tp in (("все поля", tp_full), ("только нужные", tp_slim),
                      ("parquet", parquet_size)):
        if not tp:
            continue
        per_day_total = tp + stat_full
        print("  Прогноз архива за 231 день (%s): %s"
              % (label, human(per_day_total * 231)))
    print("=" * 66)
    print("Ориентиры GitHub: файл >100 МБ не принимается, репозиторий желательно <5 ГБ.")

    # заполненность полей — чтобы решать состав slim по фактам, а не на глаз
    report = {
        "day": day,
        "taskPlanRecords": counts_full["taskPlan"],
        "sizes": {"full": sizes_full, "slim": sizes_slim, "parquet": parquet_size},
        "fieldNonEmptyCounts": dict(sorted(field_stats.items(), key=lambda kv: -kv[1])),
        "droppedBySlim": sorted(set(field_stats) - set(SLIM_FIELDS)),
    }
    out = archive / "measure_report.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    dropped_nonempty = [(k, field_stats[k]) for k in report["droppedBySlim"] if field_stats[k]]
    if dropped_nonempty:
        print("\nПоля, которые slim выбрасывает, хотя они заполнены (проверьте, не нужны ли):")
        for k, v in sorted(dropped_nonempty, key=lambda kv: -kv[1])[:15]:
            print("   %-28s заполнено в %s записях" % (k, "{:,}".format(v).replace(",", " ")))
    print("\nПодробный отчёт: %s" % out)
    return results


def mode_fetch(api, archive, days, fields_mode, page_limit, refresh_last, force):
    manifest = Manifest(archive / "manifest.json")
    today = datetime.now(timezone.utc).date()
    # refresh_last=5 -> перевыгружаем сегодня и четыре предыдущих дня; 0 -> ничего.
    fresh_edge = today - timedelta(days=refresh_last - 1) if refresh_last > 0 else None

    todo = []
    for day in days:
        d = datetime.strptime(day, "%Y-%m-%d").date()
        stale = fresh_edge is not None and d >= fresh_edge
        if force or not manifest.is_done(day) or stale:
            todo.append(day)
    skipped = len(days) - len(todo)

    print("\nВЫГРУЗКА: %d дней в работу, %d пропущено (уже в архиве)" % (len(todo), skipped))
    if refresh_last:
        print("Последние %d суток перевыгружаются всегда (статусы доезжают задним числом)."
              % refresh_last)
    print("-" * 66)

    t0 = time.time()
    done, failed = 0, []
    for i, day in enumerate(todo, 1):
        elapsed = time.time() - t0
        eta = ""
        if done:
            eta = "  осталось ~%.0f мин" % ((elapsed / done) * (len(todo) - i + 1) / 60.0)
        log("[%d/%d] %s%s" % (i, len(todo), day, eta), "step")
        try:
            counts, sizes, _ = fetch_day(api, archive, day, fields_mode, page_limit)
        except RuntimeError as e:
            log(str(e), "err")
            failed.append(day)
            continue
        except KeyboardInterrupt:
            print("\n\nПрервано пользователем. Выгруженные дни сохранены в манифесте,")
            print("повторный запуск той же командой продолжит с этого места.")
            return
        manifest.mark(day, counts, sizes, fields_mode)
        done += 1
        log("taskPlan %s | statByZone %s | statByEmployee %s | statByTeam %s | %s" % (
            counts["taskPlan"], counts["statByZone"], counts["statByEmployee"],
            counts["statByTeam"], human(sum(sizes.values()))), "ok")

    total_bytes = sum(sum(d.get("bytes", {}).values()) for d in manifest.data["days"].values())
    total_recs = sum(d.get("counts", {}).get("taskPlan", 0) for d in manifest.data["days"].values())
    print("\n" + "=" * 66)
    print("ГОТОВО. Выгружено дней за этот запуск: %d, ошибок: %d" % (done, len(failed)))
    if failed:
        print("Не получилось: %s" % ", ".join(failed[:10]))
        print("Запустите ту же команду ещё раз -- она добьёт только эти дни.")
    print("Всего в архиве: %d дней, %s записей taskPlan, %s на диске"
          % (len(manifest.data["days"]), "{:,}".format(total_recs).replace(",", " "),
             human(total_bytes)))
    print("Время работы: %.0f мин, запросов к API: %s"
          % ((time.time() - t0) / 60.0, "{:,}".format(api.requests_made).replace(",", " ")))
    print("=" * 66)


# ----------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--token", required=True, help="JWT API-токен Bruno")
    ap.add_argument("--date", help="Один день, YYYY-MM-DD (вместо --from/--to)")
    ap.add_argument("--from", dest="date_from", help="Начало диапазона, YYYY-MM-DD")
    ap.add_argument("--to", dest="date_to", help="Конец диапазона, YYYY-MM-DD")
    ap.add_argument("--archive", default="archive", help="Каталог архива (по умолчанию ./archive)")
    ap.add_argument("--fields", choices=["slim", "full"], default="slim",
                    help="slim -- только используемые поля taskPlan (по умолчанию), full -- всё")
    ap.add_argument("--page-limit", type=int, default=500, help="Размер страницы (по умолчанию 500)")
    ap.add_argument("--pause-ms", type=int, default=200, help="Пауза между запросами, мс")
    ap.add_argument("--refresh-last", type=int, default=5,
                    help="Сколько последних суток перевыгружать всегда (по умолчанию 5)")
    ap.add_argument("--force", action="store_true", help="Перевыгрузить всё заново, игнорируя манифест")
    ap.add_argument("--estimate", action="store_true", help="Только оценить объём, не качать")
    ap.add_argument("--measure", action="store_true", help="Замер форматов хранения на одном дне")
    ap.add_argument("--skip-dirs", action="store_true", help="Не обновлять справочники")
    args = ap.parse_args()

    if args.date:
        days = [args.date]
    elif args.date_from and args.date_to:
        days = daterange(args.date_from, args.date_to)
    else:
        raise SystemExit("ОШИБКА: укажите либо --date, либо пару --from/--to")

    if args.measure and len(days) != 1:
        raise SystemExit("ОШИБКА: --measure работает только с одним днём (--date)")

    archive = Path(args.archive)
    archive.mkdir(parents=True, exist_ok=True)

    api = Api(args.token, pause_ms=args.pause_ms)

    print("=" * 66)
    print("Bruno -> посуточный архив")
    print("  Период:  %s .. %s  (%d дней)" % (days[0], days[-1], len(days)))
    print("  Архив:   %s" % archive.resolve())
    print("  Поля:    %s" % args.fields)
    print("=" * 66)

    pid = api.resolve_project()
    if not pid:
        log("projectID определить не удалось -- проверьте токен (возможен 401/403)", "warn")
    else:
        log("projectID: %s" % pid, "ok")

    if args.estimate:
        mode_estimate(api, days)
        return

    if args.measure:
        mode_measure(api, archive, days[0], args.page_limit)
        return

    if not args.skip_dirs:
        fetch_directories(api, archive, datetime.now(timezone.utc).date().isoformat())

    mode_fetch(api, archive, days, args.fields, args.page_limit,
               args.refresh_last, args.force)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nПрервано.")
        sys.exit(130)
