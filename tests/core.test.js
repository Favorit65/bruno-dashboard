// Права и действия API на демо-данных. Каждый сценарий идёт на обеих копиях
// (shared/core.js и apps-script/Core.gs) и результаты сверяются между собой.
const test = require('node:test');
const assert = require('node:assert/strict');
const { copies, plain } = require('./load.js');

const DEMO = require('../docs/demo_tasks.json');
const COPIES = copies();

function freshDb() {
  const d = plain(DEMO);
  return { tasks: d.tasks, activity: d.activity, users: d.users, folders: d.folders };
}
function envAt(today, time) {
  let n = 0;
  return { today, ts: today + ' ' + (time || '12:00'), year: today.slice(2, 4), uid: () => 'u' + (++n) };
}
// Выполнить действие; ошибка возвращается как объект, а не исключение.
function run(C, db, me, action, params, env) {
  try { return plain(C.Core.handle(db, me, action, params, env || envAt('2026-10-27'))); }
  catch (e) { if (e && e.error) return plain(e); throw e; }
}
const T = (db, id) => plain(db.tasks.find((t) => t.id === id));

// Сценарий выполняется на обеих копиях; проверки — на результате каждой,
// плюс итоговые базы обеих копий должны совпасть байт в байт.
function both(name, fn) {
  test(name, () => {
    const out = COPIES.map((C) => { const db = freshDb(); fn(C, db); return plain(db); });
    assert.deepEqual(out[0], out[1], 'копии разошлись');
  });
}

both('createTask: код ПАПКА-ГГ-NNN из счётчика папки, теги из названия, назначение', (C, db) => {
  const r = run(C, db, 'head', 'createTask', { folder: 'ПДР', title: 'Ввод #бф подрядчика охраны #Срочно', prio: 'P1', objects: ['ALL'],
    owner: 'pdr', controller: 'head', workType: 'wt_02', start: '2026-10-28', due: '2026-11-20', checklist: ['Договор', '', 'Пропуска'] });
  assert.equal(r.result.id, 'ПДР-26-003');
  const t = T(db, 'ПДР-26-003');
  assert.equal(t.title, 'Ввод подрядчика охраны');
  assert.deepEqual(t.tags, ['БФ', 'Срочно']); // #бф приведён к уже существующему #БФ
  assert.deepEqual(t.checklist.map((c) => c.text), ['Договор', 'Пропуска']);
  assert.equal(t.version, 1);
  assert.equal(db.folders.find((f) => f.code === 'ПДР').counters['26'], 3);
  assert.deepEqual(r.patch.activity.map((a) => a.type), ['created', 'assign']);
  assert.deepEqual(r.notify, [{ type: 'assign', user: 'pdr', task: 'ПДР-26-003' }]);
  // номер не переиспользуется и идёт по счётчику, даже если задач меньше
  db.folders.find((f) => f.code === 'ОРГ').counters['26'] = 7;
  const r2 = run(C, db, 'mod', 'createTask', { folder: 'ОРГ', title: 'Х', owner: 'mod', controller: 'head', start: '2026-10-28', due: '2026-10-29' });
  assert.equal(r2.result.id, 'ОРГ-26-008');
  // новый год — новый счётчик
  const r3 = run(C, db, 'mod', 'createTask', { folder: 'ОРГ', title: 'Y', owner: 'mod', controller: 'head', start: '2027-01-10', due: '2027-01-20' }, envAt('2027-01-09'));
  assert.equal(r3.result.id, 'ОРГ-27-001');
});

both('createTask: ответственный не может создать поручение (проверка на сервере)', (C, db) => {
  const r = run(C, db, 'kom', 'createTask', { folder: 'ОБК', title: 'Х', owner: 'kom', controller: 'head', start: '2026-10-28', due: '2026-10-29' });
  assert.equal(r.error, 'forbidden');
  const r2 = run(C, db, 'head', 'createTask', { folder: 'ОБК', title: '#VIP', owner: 'kom', controller: 'head', start: '2026-10-28', due: '2026-10-29' });
  assert.equal(r2.error, 'bad_request');
  const r3 = run(C, db, 'head', 'createTask', { folder: 'ОБК', title: 'Х', owner: 'kom', controller: 'head', start: '2026-10-30', due: '2026-10-29' });
  assert.equal(r3.message, 'Дедлайн раньше старта.');
});

both('addSubtask: код .N, права ответственного за поручение', (C, db) => {
  const r = run(C, db, 'pdr', 'addSubtask', { parent: 'ПДР-26-001', title: 'Сверка актов #договор', owner: 'clean', controller: 'head', start: '2026-11-01', due: '2026-11-05', checklist: ['А'] });
  assert.equal(r.result.id, 'ПДР-26-001.6');
  const s = T(db, 'ПДР-26-001.6');
  assert.equal(s.prio, 'P1'); assert.equal(s.folder, 'ПДР');
  assert.deepEqual(s.tags, ['БФ', 'договор']);
  assert.equal(run(C, db, 'kom', 'addSubtask', { parent: 'ПДР-26-001', title: 'Х', owner: 'kom', controller: 'head', start: '2026-11-01', due: '2026-11-05' }).error, 'forbidden');
  assert.equal(run(C, db, 'head', 'addSubtask', { parent: 'ПДР-26-001.1', title: 'Х', owner: 'kom', controller: 'head', start: '2026-11-01', due: '2026-11-05' }).error, 'forbidden', 'третий уровень вложенности');
});

both('toggleCheck: сервер ставит done_by / done_at, чужую задачу отмечать нельзя', (C, db) => {
  const t = T(db, 'ОБК-26-001.2'), item = t.checklist[0].id;
  const r = run(C, db, 'kom', 'toggleCheck', { id: t.id, item, done: true }, envAt('2026-10-27', '09:41'));
  assert.equal(r.patch.tasks[0].checklist[0].by, 'kom');
  assert.equal(r.patch.tasks[0].checklist[0].at, '2026-10-27 09:41');
  assert.equal(r.patch.tasks[0].version, 1, 'отметка не меняет version');
  assert.equal(r.patch.activity[0].text, 'отметил(а) «Снять старые стикеры»');
  assert.equal(run(C, db, 'mms', 'toggleCheck', { id: t.id, item, done: false }).error, 'forbidden');
  const r2 = run(C, db, 'kom', 'toggleCheck', { id: t.id, item, done: false });
  assert.equal(T(db, t.id).checklist[0].by, '');
  assert.equal(r2.patch.activity[0].type, 'uncheck');
  assert.equal(run(C, db, 'kom', 'addCheckItem', { id: t.id, text: 'Новый пункт' }).patch.tasks[0].checklist.length, 5);
});

both('version: устаревшая версия → conflict, данные не меняются', (C, db) => {
  const id = 'ОБК-26-001.2';
  assert.equal(run(C, db, 'head', 'reschedule', { id, version: 1, due: '2026-11-09', reason: 'Типография' }).patch.tasks[0].version, 2);
  const r = run(C, db, 'kom', 'setBlocker', { id, version: 1, comment: 'Нет стикеров' });
  assert.equal(r.error, 'conflict');
  assert.equal(r.message, 'Задачу изменили, обновите.');
  assert.equal(T(db, id).flag, '');
  assert.equal(run(C, db, 'kom', 'setBlocker', { id, version: 2, comment: 'Нет стикеров' }).patch.tasks[0].version, 3);
});

both('reschedule: причина обязательна, переносов +1, переносит только контролёр/модератор', (C, db) => {
  const id = 'ОБК-26-001.1';
  assert.equal(run(C, db, 'head', 'reschedule', { id, version: 1, due: '2026-11-02', reason: '' }).message, 'Без причины перенос невозможен.');
  assert.equal(run(C, db, 'head', 'reschedule', { id, version: 1, due: '2026-10-30', reason: 'х' }).message, 'Новая дата совпадает с текущей.');
  assert.equal(run(C, db, 'kom', 'reschedule', { id, version: 1, due: '2026-11-02', reason: 'х' }).error, 'forbidden');
  const r = run(C, db, 'mod', 'reschedule', { id, version: 1, due: '2026-11-02', reason: 'тираж задержали' });
  assert.equal(r.patch.tasks[0].resched, 2);
  assert.equal(r.patch.activity[0].text, 'Срок 30.10 → 02.11. Причина: тираж задержали');
});

both('submit → return (комментарий обязателен) → submit → accept', (C, db) => {
  const id = 'ОРГ-26-001';
  run(C, db, 'mms', 'submit', { id, version: 1 });
  assert.equal(T(db, id).submitted, true);
  assert.equal(run(C, db, 'mms', 'accept', { id, version: 2 }).error, 'forbidden', 'ответственный сам себя не принимает');
  assert.equal(run(C, db, 'head', 'return', { id, version: 2, comment: ' ' }).message, 'Без комментария вернуть нельзя.');
  const r = run(C, db, 'head', 'return', { id, version: 2, comment: 'Нет перечня на замену' });
  assert.deepEqual(r.patch.activity[0].mentions, ['mms']);
  assert.deepEqual(r.notify, [{ type: 'return', user: 'mms', task: id, text: 'Нет перечня на замену' }]);
  assert.equal(T(db, id).submitted, false);
  run(C, db, 'mms', 'submit', { id, version: 3 });
  run(C, db, 'head', 'accept', { id, version: 4 });
  assert.equal(T(db, id).accepted, true);
});

both('блокер: ставится и снимается только с комментарием', (C, db) => {
  const id = 'ПДР-26-001.1';
  assert.equal(run(C, db, 'clean', 'clearBlocker', { id, version: 1, comment: '' }).message, 'Напишите, как решилось.');
  run(C, db, 'clean', 'clearBlocker', { id, version: 1, comment: 'Списки пришли' });
  assert.equal(T(db, id).flag, '');
  assert.equal(run(C, db, 'clean', 'setBlocker', { id, version: 2, comment: '' }).message, 'Опишите, что мешает.');
  assert.equal(run(C, db, 'mms', 'setBlocker', { id, version: 2, comment: 'х' }).error, 'forbidden');
});

both('addComment: @упоминания без учёта регистра, теги из комментария', (C, db) => {
  const r = run(C, db, 'head', 'addComment', { id: 'ОБК-26-002', text: 'Нужны фото, @клининг_бф и @Модератор, @нет_такого #vip' });
  assert.deepEqual(r.result.mentions, ['clean', 'mod']);
  assert.deepEqual(r.notify.map((n) => n.user), ['clean', 'mod']);
  assert.deepEqual(T(db, 'ОБК-26-002').tags, ['БФ', 'QR', 'VIP']);
  // себя не уведомляем
  assert.deepEqual(run(C, db, 'head', 'addComment', { id: 'ОБК-26-002', text: '@Руководитель себе' }).notify, []);
});

both('cancel: причина обязательна, подзадачи отменяются вместе с поручением', (C, db) => {
  assert.equal(run(C, db, 'kom', 'cancel', { id: 'ОБК-26-001', version: 1, reason: 'х' }).error, 'forbidden');
  const r = run(C, db, 'head', 'cancel', { id: 'ОБК-26-001', version: 1, reason: 'Переименование отменили' });
  assert.equal(r.patch.tasks.length, 5);
  assert.ok(db.tasks.filter((t) => t.id.startsWith('ОБК-26-001')).every((t) => t.flag === 'cancelled'));
});

both('setBrunoRef и updateTask: только руководитель/модератор', (C, db) => {
  assert.equal(run(C, db, 'mod', 'setBrunoRef', { id: 'ПДР-26-001', version: 1, ref: '123' }).error, 'forbidden', 'у поручения с подзадачами');
  assert.equal(run(C, db, 'mod', 'setBrunoRef', { id: 'ОРГ-26-001', version: 1, ref: '12a' }).error, 'bad_request');
  assert.equal(run(C, db, 'mod', 'setBrunoRef', { id: 'ОРГ-26-001', version: 1, ref: '48213977', status: 'COMPLETING' }).patch.tasks[0].brunoStatus, 'COMPLETING');
  assert.equal(run(C, db, 'mms', 'updateTask', { id: 'ОРГ-26-001', version: 2, fields: { title: 'Х' } }).error, 'forbidden');
  const r = run(C, db, 'head', 'updateTask', { id: 'ОБК-26-002', version: 1, fields: { prio: 'P1', owner: 'kom', folder: 'ВНД' } });
  assert.equal(r.patch.tasks.length, 4, 'приоритет и папка переходят на подзадачи');
  assert.equal(T(db, 'ОБК-26-002').folder, 'ВНД', 'перенос в папку код не меняет');
  assert.deepEqual(r.notify, [{ type: 'assign', user: 'kom', task: 'ОБК-26-002' }]);
});

both('markRead и наблюдатель', (C, db) => {
  run(C, db, 'kom', 'markRead', {}, envAt('2026-10-27', '15:30'));
  assert.equal(db.users.find((u) => u.id === 'kom').lastRead, '2026-10-27 15:30');
  db.users.push({ id: 'obs', name: 'Наблюдатель', handle: 'Наблюдатель', role: 'observer', active: true });
  assert.equal(run(C, db, 'obs', 'addComment', { id: 'ВНД-26-001', text: 'вопрос' }).patch.activity.length, 1);
  assert.equal(run(C, db, 'obs', 'submit', { id: 'ВНД-26-001.1', version: 1 }).error, 'forbidden');
  db.users.find((u) => u.id === 'obs').active = false;
  assert.equal(run(C, db, 'obs', 'addComment', { id: 'ВНД-26-001', text: 'вопрос' }).error, 'auth');
});

test('snapshot для bootstrap не отдаёт почту и ключи', () => {
  for (const C of COPIES) {
    const db = freshDb();
    db.users[0].email = 'boss@example.com'; db.users[0].keyHash = 'abc';
    const s = plain(C.Core.snapshot(db, 'head', 5));
    assert.equal(s.activity.length, 5);
    assert.equal(s.users[0].hasEmail, true);
    assert.ok(!('email' in s.users[0]) && !('keyHash' in s.users[0]));
  }
});
