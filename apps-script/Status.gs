// КОПИЯ shared/status.js — не править здесь. Правка: изменить shared/status.js,
// скопировать файл сюда целиком, запустить `node --test` (сверяет обе копии).
/* Планировщик поручений: авто-статус и прогресс задачи (ТЗ §5 + v1.1 §A).
   Эталон — statusOf() в docs/planner_demo.html, перенесён без изменения логики.

   ОДИН И ТОТ ЖЕ код работает в трёх местах:
     - браузер: planner.html подключает <script src="shared/status.js">;
     - сервер:  apps-script/Status.gs — копия этого файла целиком;
     - тесты:   tests/status.test.js сверяет, что обе копии считают одинаково.
   Правите здесь — копируйте файл в Status.gs и запускайте `node --test`.

   Задача — объект в форме фронта: {id, parent, prio, start, due, flag,
   submitted, accepted, checklist:[{done}]}. Даты — строки 'ГГГГ-ММ-ДД'.
   ctx = {today:'ГГГГ-ММ-ДД', kids:function(id){ return [подзадачи] }}. */
var PlannerStatus = (function () {
  'use strict';
  var RISK = { P1: 5, P2: 3, P3: 2 };
  var RANK = { overdue: 6, blocker: 5, risk: 4, work: 3, review: 2, plan: 1, done: 0, cancelled: -1 };
  var LABEL = { plan: 'Запланировано', work: 'В работе', risk: 'Риск', overdue: 'Просрочено', blocker: 'Блокер', review: 'На проверке', done: 'Выполнено', cancelled: 'Отменено' };

  function pD(s) { var p = String(s).slice(0, 10).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function diff(a, b) { return Math.round((pD(b) - pD(a)) / 864e5); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function addDays(s, n) { var d = new Date(pD(s) + n * 864e5); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }

  function liveKids(t, ctx) { return (ctx.kids(t.id) || []).filter(function (c) { return c.flag !== 'cancelled'; }); }
  function own(t) { var cl = t.checklist || [], n = cl.length; return n ? cl.filter(function (c) { return c.done; }).length / n : 0; }

  function statusOf(t, ctx) {
    if (t.flag === 'cancelled') return 'cancelled';
    var td = ctx.today;
    var ch = liveKids(t, ctx);
    if (ch.length) {
      var sts = ch.map(function (c) { return statusOf(c, ctx); });
      if (sts.every(function (s) { return s === 'done'; })) return t.accepted ? 'done' : 'review';
      if (t.flag === 'blocker') return 'blocker';
      if (td > t.due) return 'overdue';
      var open = sts.filter(function (s) { return s !== 'done'; });
      var w = open.reduce(function (a, s) { return RANK[s] > RANK[a] ? s : a; }, 'plan');
      if (w === 'plan' && sts.some(function (s) { return s !== 'plan'; })) w = 'work';
      return w;
    }
    if (t.accepted) return 'done';
    if (t.submitted) return 'review';
    if (t.flag === 'blocker') return 'blocker';
    if (td > t.due) return 'overdue';
    var p = own(t), dur = diff(t.start, t.due) + 1;
    var el = Math.max(0, Math.min(1, diff(t.start, td) / dur)), left = diff(td, t.due);
    if (td >= t.start && left <= (RISK[t.prio] || RISK.P3) && p < el - 0.2) return 'risk';
    if (td < t.start && p === 0) return 'plan';
    return 'work';
  }

  // Прогресс родителя — среднее по подзадачам, взвешенное по их длительности.
  function progress(t, ctx) {
    var ch = liveKids(t, ctx);
    if (!ch.length) return t.accepted ? 1 : own(t);
    var w = 0, s = 0;
    ch.forEach(function (c) { var d = diff(c.start, c.due) + 1; w += d; s += d * (statusOf(c, ctx) === 'done' ? 1 : progress(c, ctx)); });
    return w ? s / w : 0;
  }

  return { RISK: RISK, RANK: RANK, LABEL: LABEL, statusOf: statusOf, progress: progress, own: own, diff: diff, addDays: addDays };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = PlannerStatus;
