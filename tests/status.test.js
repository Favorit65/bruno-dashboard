// Статусы ТЗ §5 + пороги риска v1.1 §A. Каждый кейс прогоняется на обеих копиях
// (shared/status.js и apps-script/Status.gs), результат сверяется с ожидаемым
// и копии — между собой.
const test = require('node:test');
const assert = require('node:assert/strict');
const { copies, plain } = require('./load.js');

const [WEB, GAS] = copies();

// Лист без подзадач. 10-дневная задача 01.11–10.11, 4 пункта чек-листа.
function leaf(o) {
  const done = o.done || 0, n = o.n == null ? 4 : o.n;
  return Object.assign({
    id: 'X-26-001', parent: null, prio: 'P2', start: '2026-11-01', due: '2026-11-10', flag: '', submitted: false, accepted: false,
    checklist: Array.from({ length: n }, (_, i) => ({ done: i < done }))
  }, o);
}
const ctxOf = (tasks, today) => ({ today, kids: (id) => tasks.filter((t) => t.parent === id) });
const one = (t, today) => [t, ctxOf([t], today)];

// [название, задача, все задачи, сегодня, ожидаемый статус]
const CASES = [];
const L = (name, t, today, want) => CASES.push([name, t, [t], today, want]);

// --- строки таблицы §5 ---
L('Запланировано: сегодня < старта, ничего не отмечено', leaf({}), '2026-10-31', 'plan');
L('В работе: наступил старт', leaf({}), '2026-11-01', 'work');
L('В работе: до старта, но отмечен пункт', leaf({ done: 1 }), '2026-10-31', 'work');
L('Риск P2: до дедлайна 3 дня, прогресс 0 < 70% − 20', leaf({}), '2026-11-07', 'risk');
L('Просрочено: сегодня > дедлайна', leaf({ done: 3 }), '2026-11-11', 'overdue');
L('На проверке: нажато «Сдать»', leaf({ submitted: true }), '2026-11-05', 'review');
L('Выполнено: нажато «Принять»', leaf({ accepted: true, submitted: false }), '2026-11-20', 'done');
L('Блокер: флаг поверх авто-статуса', leaf({ flag: 'blocker' }), '2026-11-03', 'blocker');
L('Блокер сильнее просрочки', leaf({ flag: 'blocker' }), '2026-11-30', 'blocker');
L('Отменено', leaf({ flag: 'cancelled' }), '2026-11-30', 'cancelled');
L('Сдано, но просрочено → на проверке (ждёт контролёра)', leaf({ submitted: true }), '2026-11-30', 'review');

// --- граничные даты ---
L('Дедлайн сегодня — ещё не просрочено', leaf({ done: 4 }), '2026-11-10', 'work');
L('Риск P2: до дедлайна 4 дня — ещё не риск', leaf({}), '2026-11-06', 'work');
L('Риск P1: ровно 5 дней', leaf({ prio: 'P1' }), '2026-11-05', 'risk');
L('Риск P1: 6 дней — ещё нет', leaf({ prio: 'P1' }), '2026-11-04', 'work');
L('Риск P3: ровно 2 дня', leaf({ prio: 'P3' }), '2026-11-08', 'risk');
L('Риск P3: 3 дня — ещё нет', leaf({ prio: 'P3' }), '2026-11-07', 'work');
// 01.11–10.11, сегодня 07.11: прошло 6/10 = 60%, порог 40%. 2 из 4 = 50% — не отстаёт.
L('Риск: прогресс ровно не отстаёт (50% ≥ 60% − 20)', leaf({ done: 2 }), '2026-11-07', 'work');
L('Риск: прогресс отстаёт (25% < 60% − 20)', leaf({ done: 1 }), '2026-11-07', 'risk');
L('Однодневная задача в свой день', leaf({ start: '2026-11-05', due: '2026-11-05', prio: 'P3' }), '2026-11-05', 'work');
L('Задача без чек-листа после старта', leaf({ n: 0 }), '2026-11-02', 'work');
L('Задача без чек-листа у дедлайна — риск', leaf({ n: 0 }), '2026-11-09', 'risk');

// --- возврат: «Вернуть» снимает submitted/accepted, статус снова по датам ---
L('Возврат до дедлайна → В работе', leaf({ submitted: false, accepted: false, done: 4 }), '2026-11-05', 'work');
L('Возврат после дедлайна → Просрочено', leaf({ submitted: false, accepted: false, done: 4 }), '2026-11-12', 'overdue');

// --- родитель = худший из подзадач ---
function family(parent, kids) {
  const p = leaf(Object.assign({ id: 'P-26-001', n: 0, start: '2026-11-01', due: '2026-11-30' }, parent));
  const ks = kids.map((k, i) => leaf(Object.assign({ id: 'P-26-001.' + (i + 1), parent: 'P-26-001' }, k)));
  return [p, [p].concat(ks)];
}
const F = (name, parent, kids, today, want) => { const [p, all] = family(parent, kids); CASES.push([name, p, all, today, want]); };
F('Родитель: все подзадачи до старта → Запланировано', {}, [{}, {}], '2026-10-30', 'plan');
F('Родитель: план + в работе → В работе', {}, [{}, { start: '2026-11-20', due: '2026-11-25' }], '2026-11-02', 'work');
F('Родитель: одна выполнена, другая до старта → В работе', {}, [{ accepted: true }, { start: '2026-11-20', due: '2026-11-25' }], '2026-11-02', 'work');
F('Родитель: худший — риск', {}, [{ start: '2026-11-20', due: '2026-11-25' }, { prio: 'P2' }], '2026-11-08', 'risk');
F('Родитель: худший — просрочка подзадачи', {}, [{ start: '2026-11-20', due: '2026-11-25' }, {}], '2026-11-12', 'overdue');
F('Родитель: блокер у подзадачи → Блокер', {}, [{ flag: 'blocker' }, {}], '2026-11-02', 'blocker');
F('Родитель: подзадача на проверке, другая в работе → В работе', {}, [{ submitted: true }, {}], '2026-11-02', 'work');
F('Родитель: все приняты, сам не принят → На проверке', {}, [{ accepted: true }, { accepted: true }], '2026-11-12', 'review');
F('Родитель: все приняты и сам принят → Выполнено', { accepted: true }, [{ accepted: true }, { accepted: true }], '2026-11-12', 'done');
F('Родитель: свой блокер', { flag: 'blocker' }, [{}, {}], '2026-11-02', 'blocker');
F('Родитель: свой дедлайн прошёл', { due: '2026-11-10' }, [{ start: '2026-11-20', due: '2026-11-25' }], '2026-11-11', 'overdue');
F('Родитель: отменённая подзадача не учитывается', {}, [{ flag: 'cancelled' }, { accepted: true }], '2026-11-12', 'review');
F('Родитель: все подзадачи отменены → как лист', { n: 2, done: 0 }, [{ flag: 'cancelled' }], '2026-10-20', 'plan');

for (const [name, t, all, today, want] of CASES) {
  test(name, () => {
    const a = WEB.Status.statusOf(t, ctxOf(all, today));
    const b = GAS.Status.statusOf(t, ctxOf(all, today));
    assert.equal(a, want, WEB.name);
    assert.equal(b, want, GAS.name);
  });
}

test('Прогресс родителя взвешен по длительности подзадач', () => {
  // 10-дневная выполнена наполовину, 30-дневная — принята: (10·0.5 + 30·1) / 40 = 0.875
  const [p, all] = family({}, [{ start: '2026-11-01', due: '2026-11-10', done: 2 }, { start: '2026-11-01', due: '2026-11-30', accepted: true }]);
  for (const C of [WEB, GAS]) assert.equal(C.Status.progress(p, ctxOf(all, '2026-11-05')), 0.875, C.name);
});

test('Пороги риска по приоритету', () => {
  for (const C of [WEB, GAS]) assert.deepEqual(plain(C.Status.RISK), { P1: 5, P2: 3, P3: 2 }, C.name);
});

test('Две копии совпадают на всех демо-задачах на каждый день до конца года', () => {
  const demo = require('../docs/demo_tasks.json');
  let day = '2026-10-15', n = 0;
  while (day <= '2027-01-05') {
    const ctx = ctxOf(demo.tasks, day);
    for (const t of demo.tasks) {
      assert.equal(WEB.Status.statusOf(t, ctx), GAS.Status.statusOf(t, ctx), t.id + ' @ ' + day);
      assert.equal(WEB.Status.progress(t, ctx), GAS.Status.progress(t, ctx), t.id + ' @ ' + day);
      n++;
    }
    day = WEB.Status.addDays(day, 1);
  }
  assert.ok(n > 2000);
});

test('Демо на 27.10 считается как в прототипе', () => {
  // Сверено с docs/planner_demo.html на дату демо 27.10.2026.
  const demo = require('../docs/demo_tasks.json');
  const ctx = ctxOf(demo.tasks, '2026-10-27');
  const st = (id) => WEB.Status.statusOf(demo.tasks.find((t) => t.id === id), ctx);
  assert.equal(st('ПДР-26-001.1'), 'blocker');
  assert.equal(st('ПДР-26-001'), 'blocker');
  assert.equal(st('ОТЧ-26-001'), 'plan');
  assert.equal(st('РМТ-26-001.1'), 'work');
});
