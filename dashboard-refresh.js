/* Reload a complete model before swapping the data used by the visible page. */
window.BrunoRefresh = (function () {
  'use strict';
  let started = false, busy = false, lastAttempt = 0, button;
  function snapshot() {
    return { META, OBJECTS, objById, ZONES, zoneById, ROWS_BY_DATE, ROWS_ROLE_BY_DATE,
      ROWS_HOUR_BY_KEY, ZONE_ROWS_BY_DATE, ROWS_FB_BY_DATE, ROWS_FB_HOUR_BY_KEY, HAS_FB,
      WORK_BY_DATE, EMPLOYEES, ROLE_OF, ROLES, EMP_ROWS_BY_DATE, EMP_OBJ_BY_DATE,
      EMP_TASK_BY_DATE, HAS_EMP_OBJ, HAS_EMP_TASK, ARCHIVE_FROM, ARCHIVE_TO, ALL_DATES,
      V2, CUBES_READY, CUBES_PROMISE, TEAMS, FUNCTION_ROWS_BY_DATE, HAS_FUNCTION_STATS, ACTIVITY_ROWS, ACTIVITY_VIEW_KEY, ACTIVITY_EMPTY_RESTORE };
  }
  function restore(v) {
    ({ META, OBJECTS, objById, ZONES, zoneById, ROWS_BY_DATE, ROWS_ROLE_BY_DATE,
      ROWS_HOUR_BY_KEY, ZONE_ROWS_BY_DATE, ROWS_FB_BY_DATE, ROWS_FB_HOUR_BY_KEY, HAS_FB,
      WORK_BY_DATE, EMPLOYEES, ROLE_OF, ROLES, EMP_ROWS_BY_DATE, EMP_OBJ_BY_DATE,
      EMP_TASK_BY_DATE, HAS_EMP_OBJ, HAS_EMP_TASK, ARCHIVE_FROM, ARCHIVE_TO, ALL_DATES,
      V2, CUBES_READY, CUBES_PROMISE, TEAMS, FUNCTION_ROWS_BY_DATE, HAS_FUNCTION_STATS, ACTIVITY_ROWS, ACTIVITY_VIEW_KEY, ACTIVITY_EMPTY_RESTORE } = v);
  }
  function reset() {
    ACTIVITY_ROWS = null; ACTIVITY_VIEW_KEY = null; ACTIVITY_EMPTY_RESTORE = null;
    META = {}; OBJECTS = []; objById = {}; ZONES = []; zoneById = {};
    ROWS_BY_DATE = new Map(); ROWS_ROLE_BY_DATE = new Map(); ROWS_HOUR_BY_KEY = new Map();
    ZONE_ROWS_BY_DATE = new Map(); ROWS_FB_BY_DATE = new Map(); ROWS_FB_HOUR_BY_KEY = new Map();
    WORK_BY_DATE = new Map(); EMP_ROWS_BY_DATE = new Map(); EMP_OBJ_BY_DATE = new Map(); EMP_TASK_BY_DATE = new Map();
    TEAMS = {}; FUNCTION_ROWS_BY_DATE = new Map(); HAS_FUNCTION_STATS = false;
    EMPLOYEES = {}; ROLE_OF = {}; ROLES = []; HAS_FB = false; HAS_EMP_OBJ = false; HAS_EMP_TASK = false;
    ARCHIVE_FROM = null; ARCHIVE_TO = null; ALL_DATES = []; V2 = null; CUBES_READY = false;
  }
  function label(message) {
    const el = document.getElementById('updated-lbl');
    if (message) { el.textContent = message; el.classList.add('stale'); return; }
    const stamp = META.sourceUpdatedAt;
    const valid = stamp && Number.isFinite(Date.parse(stamp));
    const age = valid ? Math.max(0, (Date.now() - Date.parse(stamp)) / 3600000) : null;
    const format = new Intl.DateTimeFormat('ru-RU', { timeZone:'Europe/Moscow',
      day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    el.textContent = valid ? 'Данные от ' + format.format(new Date(stamp)) + ' МСК'
      : 'Архив по ' + ARCHIVE_TO + ' · время выгрузки не указано';
    const stale = valid ? age >= 2 : ARCHIVE_TO < DP.today();
    el.classList.toggle('stale', stale);
    el.title = 'Проверка модели каждый час. Периоды считаются по Москве.'
      + (META.buildId ? '\nМодель собрана: ' + META.buildId : '')
      + (stale ? '\nИсточник требует актуализации.' : '');
  }
  async function readSnapshot(revision) {
    let core;
    try { core = await loadPart(M2_CORE, null, revision); }
    catch (error) { if (!error.httpStatus || error.httpStatus !== 404) throw error; return { legacy: await fetchData(revision) }; }
    if (!core || core.f !== 2) return { legacy: await fetchData(revision) };
    let cubes = await loadPart(M2_CUBES, null, revision);
    try { DP.assertSameBuild(core, cubes); }
    catch (_) {
      // A publication may have happened between the two requests. Retry both.
      const suffix = (revision ? '&retry=' : '?retry=') + Date.now();
      [core, cubes] = await Promise.all([fetchJson(modelPartUrl(M2_CORE, revision) + suffix), fetchJson(modelPartUrl(M2_CUBES, revision) + suffix)]);
      DP.assertSameBuild(core, cubes);
    }
    return { core, cubes };
  }
  async function refresh(force = false) {
    if (busy || (!force && Date.now() - lastAttempt < DP.REFRESH_MS)) return false;
    busy = true; lastAttempt = Date.now();
    if (button) button.disabled = true;
    try {
      await CUBES_PROMISE;
      const revision = await readModelRevision();
      const incoming = await readSnapshot(revision);
      const nextMeta = incoming.core ? incoming.core.meta : incoming.legacy.meta;
      const changed = !nextMeta.buildId || nextMeta.buildId !== META.buildId;
      if (changed) {
        const previous = snapshot();
        try {
          reset();
          if (incoming.core) { mapCoreV2(incoming.core); mapCubesV2(incoming.cubes.cubes || {}); finishRoles(); }
          else mapLegacy(incoming.legacy);
          if (!OBJECTS.length || !ALL_DATES.length) throw new Error('Получена пустая модель');
          if (!ACTIVITY_ROWS) throw new Error('Модель без фактических дат выполнения');
          CUBES_READY = true; CUBES_PROMISE = Promise.resolve();
        } catch (error) { restore(previous); throw error; }
      }
      if (state.periodMode === 'week') state.period = DP.weekPeriod();
      MODEL_REVISION = revision;
      state.objects = DP.sanitizeObjects(state.objects, OBJECTS);
      if (state.drill.b2aObj && state.drill.b2aObj !== '__other__' && !state.objects.has(state.drill.b2aObj)) state.drill.b2aObj = null;
      _cacheKey = null; _cachePeriod = null; _cacheDay = new Map(); _grpKey = null;
      setupObjectMenu(); setupRoleMenu(); syncControlsFromState(); renderAll();
      if (OPEN_FUNCTION_DETAIL) showRoleDetail(OPEN_FUNCTION_DETAIL);
      document.getElementById('sub-lbl').textContent = `Система Bruno · ${enabledObjects().length} доступных объектов · архив ${ARCHIVE_FROM} — ${ARCHIVE_TO}`;
      label(); return true;
    } catch (error) {
      console.warn('Обновление модели не выполнено:', error);
      label('Не удалось обновить данные · показана последняя загруженная версия');
      return false;
    } finally { busy = false; if (button) button.disabled = false; }
  }
  function start() {
    label();
    if (started) return;
    started = true; lastAttempt = Date.now();
    button = document.createElement('button'); button.type = 'button'; button.className = 'btn-detail';
    button.textContent = 'Обновить данные'; button.title = 'Загрузить последнюю опубликованную модель';
    button.addEventListener('click', () => refresh(true));
    document.getElementById('updated-lbl').insertAdjacentElement('afterend', button);
    setInterval(() => refresh(true), DP.REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  }
  return { start, refresh };
})();
