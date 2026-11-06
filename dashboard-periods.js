/* Load only the selected weeks. Keep aggregates, not the downloaded task rows. */
const DashboardPeriods = (() => {
  let manifest, history, currentDataKey, registryLoaded, pending, failed;

  async function read(name, revision, signal) {
    const url = 'model.periods/' + name + '.json';
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort',abort,{once:true});
    const timeout = setTimeout(abort,45000);
    try {
      const response = await fetch(modelPartUrl(url, revision), {
        cache: name === 'index' ? 'no-store' : 'default', signal:controller.signal,
      });
      if (!response.ok) throw new Error('Не удалось загрузить данные периода (HTTP ' + response.status + ').');
      const data = await response.json();
      if ((data.meta?.buildId || data.buildId) !== revision) {
        throw new Error('Публикация данных ещё обновляется. Повторите загрузку.');
      }
      return data;
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw new Error('Сервер не ответил вовремя.');
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort',abort);
    }
  }

  async function readIndex(revision) {
    const index = await read('index', revision);
    if (index.f !== 1 || !Array.isArray(index.weeks) || !index.meta.archiveFrom || !index.meta.archiveTo) {
      throw new Error('Неверный формат модели по периодам.');
    }
    return index;
  }

  function lookup(index) {
    const d = index.dirs;
    return {days:index.days, roles:index.roles.map(normRole), objIds:d.objects.ids,
      zoneIds:d.zones.ids, empIds:d.empIds, teamIds:d.teamIds,
      windowKinds:d.windowKinds, feedbackIds:[]};
  }

  function indexHistory(index) {
    const grouped = new Map();
    for (const row of unpackActivity({stride:27,rows:index.history}, lookup(index))) {
      if (!grouped.has(row.date)) grouped.set(row.date, []);
      grouped.get(row.date).push(row);
    }
    return grouped;
  }

  function installIndex(index) {
    manifest = index;
    history = indexHistory(index);
    MODEL_REVISION = index.meta.buildId;
    objById = {}; zoneById = {}; ROLE_OF = {};
    mapCoreV2(index);
    ROLES = [...new Set(index.activityRoles.map(normRole))].sort((a,b)=>a.localeCompare(b,'ru'));
    ACTIVITY_ROWS = [];
    HAS_FB = HAS_FUNCTION_STATS = CUBES_READY = true;
    CUBES_PROMISE = Promise.resolve();
  }

  function wantsRegister() {
    return state.table?.key === 'fb' && FB_MODE_FB();
  }

  function dataKey(index) {
    return JSON.stringify([index.meta.buildId,state.period.from,state.period.to,state.time.hour,
      state.duration,Boolean(state.noRoles),[...state.roles].sort()]);
  }
  const key = index => dataKey(index) + '|' + wantsRegister();
  const isCurrent = index => currentDataKey === dataKey(index) && (!wantsRegister() || registryLoaded);

  async function load(index, signal, reuseMaps) {
    const from = state.period.from || index.meta.archiveFrom;
    const to = state.period.to || index.meta.archiveTo;
    const hour = state.time.hour;
    const register = wantsRegister();
    const weeks = index.weeks.filter(week => week >= weekMonday(from) && week <= to);
    const dirs = lookup(index);
    const maps = reuseMaps ? null : Object.fromEntries(Object.keys(activityMaps()).map(name=>[name,new Map()]));
    const requests = [];
    const inRange = day => day >= from && day <= to;
    for (const [position,week] of weeks.entries()) {
      if (maps) {
        const data = await read('week-'+week, index.meta.buildId, signal);
        if (signal.aborted) return;
        const packed = hour && index.hours.includes(hour)
          ? await read('hour-'+hour,index.meta.buildId,signal) : data;
        if (signal.aborted) return;
        const rows = unpackActivity({stride:27,rows:packed.rows}, dirs).filter(row=>inRange(row.date));
        const counts = data.requests.filter(row=>inRange(row.registered.slice(0,10)));
        const part = aggregateActivity(rows, counts, Boolean(hour));
        for (const name of Object.keys(part)) {
          for (const [date, values] of part[name]) maps[name].set(date,values);
        }
      }
      if (register && index.registerWeeks.includes(week)) {
        const detail = await read('register-'+week,index.meta.buildId,signal);
        for (const row of detail.requests) if (inRange(row.registered.slice(0,10))) requests.push(row);
      }
      if (!signal.aborted && weeks.length > 1) {
        showStatus('Загружаю выбранный период…',(position + 1) / weeks.length);
      }
    }
    return {maps,requests:register ? requests : null};
  }

  function ensure(index=manifest) {
    const nextDataKey = dataKey(index);
    const nextKey = key(index);
    if (pending?.key === nextKey) return pending.promise;
    pending?.controller.abort();
    pending = null;
    if (isCurrent(index)) { hideStatus(); return Promise.resolve(false); }
    if (failed?.key === nextKey) return Promise.reject(failed.error);
    const controller = new AbortController();
    showStatus('Загружаю выбранный период…');
    const promise = (async () => {
      try {
        const next = await load(index,controller.signal,nextDataKey===currentDataKey);
        if (controller.signal.aborted || nextKey !== key(index)) return false;
        if (manifest !== index) installIndex(index);
        if (next.maps) installActivityMaps(next.maps);
        META.feedbackRegister = next.requests;
        currentDataKey = nextDataKey;
        registryLoaded = next.requests !== null;
        hideStatus();
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        failed = {key:nextKey,error};
        throw error;
      } finally {
        if (pending?.controller === controller) pending = null;
      }
    })();
    pending = {key:nextKey,controller,promise};
    return promise;
  }

  function rowsForHistory(date) {
    if (state.noRoles) return [];
    return (history.get(date) || []).filter(row=>row.duration === state.duration &&
      (!state.roles.size || state.roles.has(row.role)));
  }

  return { readIndex, installIndex, ensure, rowsForHistory, ready:()=>Boolean(manifest),
    resetFailure:()=>{ failed = null; },
    current:()=>manifest && isCurrent(manifest) };
})();
