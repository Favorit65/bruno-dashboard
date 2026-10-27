// Прогон apps-script/*.gs в node на имитации сервисов Apps Script (таблица в
// памяти, Utilities, LockService, MailApp…). Настоящий Apps Script так не
// проверить, но весь путь «doPost → ключ → листы → ответ» выполняется целиком:
// setup, seedDemo, issueKey/revokeKey, чтение и запись строк, version, письма.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeGas } = require('./gas_fake.js');

test('Apps Script: setup → seedDemo → ключи → действия через doPost', () => {
  const G = fakeGas();
  G.ctx.setup();
  assert.deepEqual(G.ss.getSheets().map((s) => s.name), ['Tasks', 'Checklist', 'Activity', 'Users', 'Folders', 'Settings']);
  assert.equal(G.rows('Folders').length, 6);
  G.ctx.setup(); // повторный запуск ничего не ломает
  assert.equal(G.rows('Folders').length, 6);

  G.ctx.seedDemo();
  assert.equal(G.rows('Tasks').length, 29);
  assert.equal(G.rows('Activity').length, 20);
  assert.throws(() => G.ctx.seedDemo(), /уже есть задачи/);
  const t1 = G.rows('Tasks').find((r) => r.id === 'ПДР-26-001.1');
  assert.equal(t1.status, 'blocker'); assert.equal(t1.manual_flag, 'blocker'); assert.equal(t1.priority, 'P1');

  // без ключа и с чужим ключом — отказ
  assert.equal(G.post({ action: 'bootstrap' }).error, 'auth');
  assert.equal(G.post({ action: 'bootstrap', key: 'abc' }).error, 'auth');

  const keyOf = (link) => link.split('#k=')[1];
  const head = keyOf(G.ctx.issueKey('head')), kom = keyOf(G.ctx.issueKey('kom'));
  assert.match(head, /^[0-9a-f]{64}$/);
  const users = G.rows('Users');
  assert.ok(users.every((u) => !u.key_hash || /^[0-9a-f]{64}$/.test(u.key_hash)));
  assert.ok(!JSON.stringify(G.ss.getSheets().map((s) => s.cells)).includes(head), 'сам ключ в таблице не хранится');

  const b = G.post({ action: 'bootstrap', key: head });
  assert.equal(b.ok, true); assert.equal(b.me, 'head');
  assert.equal(b.tasks.length, 29); assert.equal(b.activity.length, 20);
  assert.ok(b.users.every((u) => !('keyHash' in u) && !('email' in u)));
  const t = b.tasks.find((x) => x.id === 'ОБК-26-001');
  assert.deepEqual(t.objects.length, 2); assert.equal(t.version, 1);
  assert.equal(b.tasks.find((x) => x.id === 'РМТ-26-001.1').checklist[0].by, 'mod');

  // почта у ответственного по подрядчикам → письмо о назначении
  const urow = G.ss.getSheetByName('Users').cells.findIndex((r) => r && r[0] === 'pdr');
  const emailCol = G.ss.getSheetByName('Users').cells[0].indexOf('email');
  G.ss.getSheetByName('Users').cells[urow][emailCol] = 'pdr@example.com';

  const yy = G.ctx.env_().year;
  const c = G.post({ action: 'createTask', key: head, params: { folder: 'ПДР', title: '=HYPERLINK("x") ввод охраны #бф', prio: 'P1', objects: ['ALL'], owner: 'pdr', controller: 'head',
    start: '2026-11-01', due: '2026-11-20', checklist: ['Договор', 'Пропуска'] } });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.result.id, 'ПДР-' + yy + '-' + (yy === '26' ? '003' : '001'));
  const row = G.rows('Tasks').find((r) => r.id === c.result.id);
  assert.equal(row.title, '=HYPERLINK("x") ввод охраны', 'формула не исполняется, текст сохранён как есть');
  assert.equal(row.tags, 'БФ'); assert.equal(row.version, '1');
  assert.equal(G.rows('Checklist').filter((r) => r.task_id === c.result.id).length, 2);
  assert.equal(G.mails.length, 1); assert.equal(G.mails[0].to, 'pdr@example.com');
  assert.match(G.mails[0].subject, /назначена/);

  // ответственный не может создать поручение — проверка на сервере
  assert.equal(G.post({ action: 'createTask', key: kom, params: { folder: 'ОБК', title: 'Х', owner: 'kom', controller: 'head', start: '2026-11-01', due: '2026-11-02' } }).error, 'forbidden');
  // версионные действия без version не принимаются
  assert.equal(G.post({ action: 'submit', key: kom, params: { id: 'ОБК-26-001.2' } }).error, 'bad_request');

  // отметка пункта: done_by / done_at ставит сервер
  const item = b.tasks.find((x) => x.id === 'ОБК-26-001.2').checklist[0].id;
  const tc = G.post({ action: 'toggleCheck', key: kom, params: { id: 'ОБК-26-001.2', item, done: true } });
  assert.equal(tc.ok, true);
  const crow = G.rows('Checklist').find((r) => r.id === item);
  assert.equal(crow.done, 'TRUE'); assert.equal(crow.done_by, 'kom'); assert.match(crow.done_at, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);

  // два окна правят одну задачу: второе получает conflict, данные первого целы
  const before = G.rows('Activity').map((r) => JSON.stringify(r));
  assert.equal(G.post({ action: 'reschedule', key: head, params: { id: 'ОБК-26-001.2', version: 1, due: '2026-11-09', reason: 'Типография' } }).ok, true);
  const cf = G.post({ action: 'setBlocker', key: kom, params: { id: 'ОБК-26-001.2', version: 1, comment: 'Нет стикеров' } });
  assert.deepEqual([cf.error, cf.message], ['conflict', 'Задачу изменили, обновите.']);
  const r2 = G.rows('Tasks').find((r) => r.id === 'ОБК-26-001.2');
  assert.equal(r2.due_date, '2026-11-09'); assert.equal(r2.reschedule_count, '1'); assert.equal(r2.manual_flag, ''); assert.equal(r2.version, '2');

  // перенос без причины невозможен
  assert.equal(G.post({ action: 'reschedule', key: head, params: { id: 'ОБК-26-001.2', version: 2, due: '2026-11-10', reason: '' } }).message, 'Без причины перенос невозможен.');

  // лента только дописывается: старые строки не изменились
  const after = G.rows('Activity').map((r) => JSON.stringify(r));
  assert.deepEqual(after.slice(0, before.length), before);
  assert.ok(after.length > before.length);

  // квота писем: при нуле письма не уходят, действие всё равно проходит
  G.ctx.MailApp.quota = 0;
  assert.equal(G.post({ action: 'addComment', key: kom, params: { id: c.result.id, text: '@Подрядчики посмотрите' } }).ok, true);
  assert.equal(G.mails.length, 1);

  // отзыв ключа
  G.ctx.revokeKey('kom');
  assert.equal(G.post({ action: 'bootstrap', key: kom }).error, 'auth');
  assert.equal(G.post({ action: 'bootstrap', key: head }).ok, true);
  // перевыпуск: старая ссылка перестаёт работать
  const head2 = keyOf(G.ctx.issueKey('head'));
  assert.equal(G.post({ action: 'bootstrap', key: head }).error, 'auth');
  assert.equal(G.post({ action: 'bootstrap', key: head2 }).ok, true);
});
