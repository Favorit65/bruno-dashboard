/* Shared, dependency-free dashboard policy, also exercised by node --test. */
(function (root) {
  'use strict';
  const enabledIds = Object.freeze([
    '2b4ca6a5-47c5-4aab-b66a-e84dc026f22c', // Воронцовская А
    '7cbbf23b-a270-4ff0-bdb3-24d79456a0b1', // Воронцовская Б
    'a037facd-77d3-4fd6-b2b9-a33b90ab0eb0', // Башня ВТБ
    'a5fc4390-5a9f-4521-8443-9364e0065603', // Федерация Запад
    'da25b805-5315-484b-8159-82a9c8eeb5af', // Федерация Восток
  ]);
  const enabledSet = new Set(enabledIds);
  const statuses = ['NEW', 'WAITING', 'COMPLETING', 'COMPLETED', 'MISSED'];
  const REFRESH_MS = 60 * 60 * 1000;
  function today(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const get = k => parts.find(p => p.type === k).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  function weekPeriod(now = new Date()) {
    const to = today(now), d = new Date(to + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    return { from: d.toISOString().slice(0, 10), to };
  }
  function enabled(id) { return enabledSet.has(id); }
  function sanitizeObjects(ids, available) {
    const known = new Set(available.map(o => o.id));
    return new Set([...ids].filter(id => enabled(id) && known.has(id)));
  }
  function selected(id, ids) { return enabled(id) && ids.has(id); }
  function totals(row, scope) {
    const out = Object.fromEntries(statuses.map(s => [s, 0]));
    for (const side of ['planned', 'unplanned']) {
      if (scope !== 'all' && scope !== side) continue;
      for (const status of statuses) out[status] += Number((row[side] || {})[status] || 0);
    }
    return out;
  }
  function efficiency(completed, missed, waiting = 0, duration = 'daily') {
    const den = completed + missed + (duration === 'prolonged' ? waiting : 0);
    return den > 0 ? completed / den : null;
  }
  function summary(rows, { objects, roles = new Set(), scope = 'all', duration = 'daily' }) {
    const grouped = new Map();
    for (const row of rows) {
      if (!selected(row.objId, objects) || (roles.size && !roles.has(row.role))) continue;
      const b = totals(row, scope);
      let v = grouped.get(row.role);
      if (!v) grouped.set(row.role, v = { role: row.role, completed: 0, missed: 0, waiting: 0, open: 0, all: 0 });
      v.completed += b.COMPLETED; v.missed += b.MISSED;
      v.waiting += b.WAITING;
      v.open += b.NEW + b.WAITING + b.COMPLETING;
      v.all += statuses.reduce((n, s) => n + b[s], 0);
    }
    return [...grouped.values()].map(v => ({ ...v, assigned: v.completed + v.missed,
      eff: efficiency(v.completed, v.missed, v.waiting, duration),
    })).filter(v => v.all > 0).sort((a, b) => b.completed - a.completed || a.role.localeCompare(b.role, 'ru'));
  }
  function details(rows, opts) {
    const grouped = new Map();
    for (const row of rows) {
      if (!selected(row.objId, opts.objects) || (opts.roles.size && !opts.roles.has(row.role))) continue;
      const b = totals(row, opts.scope), key = JSON.stringify([row.empId, row.teamId]);
      let v = grouped.get(key);
      if (!v) grouped.set(key, v = { empId: row.empId, teamId: row.teamId, completed: 0, missed: 0 });
      v.completed += b.COMPLETED; v.missed += b.MISSED;
    }
    return [...grouped.values()].filter(v => v.completed + v.missed > 0);
  }
  function assertSameBuild(core, cubes) {
    const a = (core.meta || {}).buildId, b = cubes.buildId;
    if (a && a !== b) throw new Error('Части модели относятся к разным сборкам. Повторите обновление.');
  }
  const api = { enabledIds, enabled, sanitizeObjects, selected, today, weekPeriod,
    summary, details, totals, efficiency, assertSameBuild, REFRESH_MS };
  root.BrunoDashboard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
