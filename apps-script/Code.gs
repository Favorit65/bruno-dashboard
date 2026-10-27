/* Планировщик поручений — бэкенд на Google Apps Script.
   Скрипт привязан к Google Таблице (Расширения → Apps Script) и развёрнут как
   веб-приложение: «Выполнять от имени: меня», «Доступ: все».

   Файлы проекта:
     Code.gs        — этот файл: вход doPost, ключи, чтение/запись листов, письма;
     Core.gs        — копия shared/core.js: права и действия (общие с фронтом);
     Status.gs      — копия shared/status.js: авто-статусы (общие с фронтом);
     appsscript.json — манифест (часовой пояс, настройки веб-приложения).

   Протокол: POST, тело — JSON-строка {action, key, params}, Content-Type
   text/plain (так браузер не делает preflight-запрос). Ответ — JSON:
   {ok:true, ...} или {error:'auth'|'forbidden'|'conflict'|'bad_request'|'not_found'|'busy'|'server', message}.

   Пошаговое развёртывание — docs/DEPLOY_planner.md. */

var TZ = 'Europe/Moscow';
var ACTIVITY_LIMIT = 300;

// Для запуска issueKey / revokeKey прямо из редактора: впишите сюда id
// пользователя из листа Users, выберите функцию и нажмите «Выполнить».
// Удобнее — меню «Планировщик» в самой таблице.
var KEY_USER_ID = '';

// Листы и колонки (ТЗ §4 + Folders из v1.1). setup() создаёт недостающие листы
// и дописывает недостающие колонки в конец — порядок колонок можно менять руками,
// скрипт ищет их по заголовку.
var SCHEMA = {
  Tasks: ['id', 'parent_id', 'folder_code', 'title', 'description', 'object', 'zone', 'zone_id', 'team_id', 'owner_id', 'controller_id',
    'work_type_id', 'start_date', 'due_date', 'status', 'manual_flag', 'flag_note', 'workflow', 'priority', 'tags', 'depends_on',
    'bruno_ref', 'bruno_status', 'photo_required', 'reschedule_count', 'created_by', 'created_at', 'updated_at', 'version'],
  Checklist: ['id', 'task_id', 'order', 'text', 'due_date', 'done', 'done_by', 'done_at', 'created_by', 'created_at'],
  Activity: ['id', 'task_id', 'ts', 'author_id', 'type', 'text', 'payload_json', 'mentions'],
  Users: ['id', 'name', 'handle', 'role', 'position', 'objects', 'email', 'bruno_employee_id', 'key_hash', 'active', 'last_read_ts'],
  Folders: ['code', 'name', 'order', 'active', 'counters_json'],
  Settings: ['key', 'value', 'note']
};
var SETTINGS = [
  ['planner_url', 'https://favorit65.github.io/bruno-dashboard/planner.html', 'Адрес planner.html на GitHub Pages — для ссылок с ключом и в письмах'],
  ['demo_url', 'https://raw.githubusercontent.com/Favorit65/bruno-dashboard/main/docs/demo_tasks.json', 'Откуда seedDemo() берёт демо-данные'],
  ['mail_enabled', 'TRUE', 'FALSE — не слать письма вообще'],
  ['backup_folder', 'Планировщик — резервные копии', 'Папка на Google Диске для еженедельной копии таблицы']
];
var START_FOLDERS = [['ПДР', 'Подрядчики'], ['РМТ', 'Ремонт и VIP-обращения'], ['ОБК', 'Обклейка и маркировка'], ['ВНД', 'Внедрение Bruno'], ['ОТЧ', 'Отчётность'], ['ОРГ', 'Прочее и орг.']];
var WRITE_ACTIONS = ['createTask', 'addSubtask', 'updateTask', 'addCheckItem', 'toggleCheck', 'addComment', 'submit', 'accept', 'return',
  'setBlocker', 'clearBlocker', 'reschedule', 'cancel', 'setBrunoRef', 'markRead'];

/* =====================================================================
   Вход
   ===================================================================== */
function doGet() {
  return json_({ ok: true, service: 'bruno-planner', hint: 'API принимает только POST {action, key, params}' });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (x) { return json_({ error: 'bad_request', message: 'Тело запроса — не JSON.' }); }
  try {
    return json_(route_(req || {}));
  } catch (err) {
    if (err && err.error) return json_({ error: err.error, message: err.message });
    console.error(err && err.stack || err);
    return json_({ error: 'server', message: 'Ошибка сервера: ' + (err && err.message || err) });
  }
}

function route_(req) {
  var action = String(req.action || ''), params = req.params || {};
  var me = auth_(req.key);
  if (action === 'bootstrap') return bootstrap_(me);
  if (WRITE_ACTIONS.indexOf(action) < 0) fail_('bad_request', 'Неизвестное действие: ' + action);
  if (PlannerCore.VERSIONED[action] && params.version == null) fail_('bad_request', 'Не передана версия задачи (version).');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) fail_('busy', 'Сервер занят, повторите через минуту.');
  var out, notify, db;
  try {
    TABLES_ = {}; // после захвата блокировки — только свежие данные
    db = loadDb_();
    var env = env_();
    var r = PlannerCore.handle(db, me.id, action, params, env);
    saveDb_(db, r.patch, env);
    SpreadsheetApp.flush();
    out = { ok: true, patch: r.patch, result: r.result };
    notify = r.notify;
  } finally {
    lock.releaseLock();
  }
  // Письма — уже без блокировки: таблица записана, отправка не задерживает остальных.
  try { sendMails_(notify, me, db); } catch (e) { console.error('Письма не отправлены: ' + e); }
  return out;
}

function bootstrap_(me) {
  var db = loadDb_({ activity: ACTIVITY_LIMIT });
  var snap = PlannerCore.snapshot(db, me.id, ACTIVITY_LIMIT);
  snap.ok = true;
  snap.today = env_().today;
  return snap;
}

/* =====================================================================
   Ключи доступа (ТЗ §3): в таблице хранится только SHA-256 ключа
   ===================================================================== */
function auth_(key) {
  key = String(key || '');
  if (!key) fail_('auth', 'Нужна персональная ссылка. Обратитесь к модератору.');
  var h = sha256Hex_(key);
  var users = readTable_('Users').rows;
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    if (u.key_hash && u.key_hash === h) {
      if (!bool_(u.active)) fail_('auth', 'Доступ отключён. Обратитесь к модератору.');
      return { id: u.id, name: u.name };
    }
  }
  fail_('auth', 'Ключ не действует (возможно, его перевыпустили). Обратитесь к модератору.');
}

// Выдать (или перевыпустить) ключ. Старый ключ сразу перестаёт работать.
// Возвращает персональную ссылку; сам ключ нигде не сохраняется.
function issueKey(userId) {
  userId = String(userId || KEY_USER_ID || '').trim();
  if (!userId) throw new Error('Не указан пользователь. Впишите id в KEY_USER_ID вверху Code.gs или воспользуйтесь меню «Планировщик → Выдать ключ…» в таблице.');
  var key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  setUserKeyHash_(userId, sha256Hex_(key));
  var link = setting_('planner_url') + '#k=' + key;
  console.log('Ключ для ' + userId + ' (показывается один раз): ' + link);
  return link;
}

function revokeKey(userId) {
  userId = String(userId || KEY_USER_ID || '').trim();
  if (!userId) throw new Error('Не указан пользователь. Впишите id в KEY_USER_ID вверху Code.gs или воспользуйтесь меню в таблице.');
  setUserKeyHash_(userId, '');
  console.log('Ключ пользователя ' + userId + ' отозван.');
}

function setUserKeyHash_(userId, hash) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    TABLES_ = {};
    var t = readTable_('Users');
    var row = null;
    t.rows.forEach(function (r) { if (r.id === userId) row = r; });
    if (!row) throw new Error('В листе Users нет пользователя с id «' + userId + '».');
    row.key_hash = hash;
    if (hash) row.active = 'TRUE';
    upsert_(t, [row], 'id');
  } finally { lock.releaseLock(); }
}

function sha256Hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { var v = (b + 256) % 256; return (v < 16 ? '0' : '') + v.toString(16); }).join('');
}

/* =====================================================================
   Меню в таблице
   ===================================================================== */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Планировщик')
    .addItem('Выдать ключ…', 'menuIssueKey')
    .addItem('Отозвать ключ…', 'menuRevokeKey')
    .addSeparator()
    .addItem('Пересчитать колонку status', 'refreshStatuses')
    .addItem('Включить резервное копирование и пересчёт статусов', 'installTriggers')
    .addToUi();
}

function menuIssueKey() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Выдать ключ', 'id пользователя из листа Users (колонка id). Старый ключ этого пользователя перестанет работать.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var link = issueKey(r.getResponseText());
  var safe = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  var html = HtmlService.createHtmlOutput(
    '<div style="font:14px Arial,sans-serif">Персональная ссылка — <b>показывается один раз</b>. Скопируйте и передайте сотруднику лично.' +
    '<input id="l" value="' + safe + '" readonly style="width:100%;margin:12px 0;padding:6px;font:12px monospace" onclick="this.select()">' +
    '<button onclick="var l=document.getElementById(\'l\');l.select();document.execCommand(\'copy\');this.textContent=\'Скопировано\'">Скопировать</button></div>'
  ).setWidth(560).setHeight(150);
  ui.showModalDialog(html, 'Ключ выдан');
}

function menuRevokeKey() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Отозвать ключ', 'id пользователя из листа Users:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  revokeKey(r.getResponseText());
  ui.alert('Ключ отозван. Ссылка этого пользователя больше не работает.');
}

/* =====================================================================
   Первичная настройка и демо-данные
   ===================================================================== */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = SCHEMA[name];
    var have = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
    var missing = cols.filter(function (c) { return have.indexOf(c) < 0; });
    if (missing.length) sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
    var width = have.length + missing.length;
    // Все ячейки — простой текст: иначе таблица превращает «2026-11-20» в дату, а «P1» — во что-нибудь ещё.
    sh.getRange(1, 1, sh.getMaxRows(), width).setNumberFormat('@');
    sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#EAF1FB');
    sh.setFrozenRows(1);
  });
  var st = readTable_('Settings');
  var add = SETTINGS.filter(function (s) { return !st.rows.some(function (r) { return r.key === s[0]; }); })
    .map(function (s) { return { key: s[0], value: s[1], note: s[2] }; });
  if (add.length) upsert_(st, add, 'key');
  var fo = readTable_('Folders');
  if (!fo.rows.length) upsert_(fo, START_FOLDERS.map(function (f, i) { return { code: f[0], name: f[1], order: String(i + 1), active: 'TRUE', counters_json: '{}' }; }), 'code');
  var us = ss.getSheetByName('Users'), roleCol = readTable_('Users').head.indexOf('role') + 1;
  us.getRange(2, roleCol, us.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['head', 'mod', 'owner', 'observer'], true).setAllowInvalid(false)
      .setHelpText('head — руководитель, mod — модератор, owner — ответственный, observer — наблюдатель').build());
  var def = ss.getSheetByName('Лист1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  console.log('Готово: листы ' + Object.keys(SCHEMA).join(', ') + '.');
}

// Загрузить 8 демо-поручений прототипа (docs/demo_tasks.json) и демо-пользователей.
// Работает только на пустом листе Tasks, чтобы случайно не смешать демо с рабочими данными.
function seedDemo() {
  if (readTable_('Tasks').rows.length) throw new Error('В листе Tasks уже есть задачи — демо грузится только в пустую таблицу.');
  var demo = JSON.parse(UrlFetchApp.fetch(setting_('demo_url')).getContentText('UTF-8'));
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ut = readTable_('Users');
    upsert_(ut, demo.users.filter(function (u) { return !ut.rows.some(function (r) { return r.id === u.id; }); }).map(function (u) {
      return userRow_({ id: u.id, name: u.name, handle: u.handle, role: u.role, position: u.position, objects: u.objects, email: '', bruno: u.bruno, keyHash: '', active: true, lastRead: u.lastRead });
    }), 'id');
    upsert_(readTable_('Folders'), demo.folders.map(folderRow_), 'code');
    var db = { tasks: demo.tasks, activity: [], users: [], folders: [] };
    var env = env_();
    env.today = demo.baseDate;
    upsert_(readTable_('Tasks'), demo.tasks.map(function (t) { return taskRow_(t, db, env); }), 'id');
    var cl = [];
    demo.tasks.forEach(function (t) { t.checklist.forEach(function (c) { cl.push(checkRow_(t.id, c)); }); });
    upsert_(readTable_('Checklist'), cl, 'id');
    appendRows_(readTable_('Activity'), demo.activity.map(activityRow_));
  } finally { lock.releaseLock(); }
  console.log('Демо загружено: ' + demo.tasks.length + ' задач, ' + demo.activity.length + ' событий, ' + demo.users.length + ' пользователей. Ключи выдайте через issueKey.');
}

/* =====================================================================
   Триггеры: еженедельная копия таблицы и ежедневный пересчёт колонки status
   ===================================================================== */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['backup', 'refreshStatuses'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backup').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  ScriptApp.newTrigger('refreshStatuses').timeBased().everyDays(1).atHour(5).create();
  console.log('Триггеры включены: копия по понедельникам в 3:00, пересчёт статусов ежедневно в 5:00.');
}

function backup() {
  var ss = sheet_();
  var name = setting_('backup_folder') || 'Планировщик — резервные копии';
  var it = DriveApp.getFoldersByName(name);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + ' — ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), folder);
}

// Колонка status в листе — снимок для чтения человеком. Интерфейс считает статус
// на лету, а сюда он пишется при каждом изменении задачи и раз в сутки триггером.
function refreshStatuses() {
  var db = loadDb_(), env = env_();
  var t = readTable_('Tasks'), col = t.head.indexOf('status');
  if (col < 0 || !t.rows.length) return;
  var byId = {};
  db.tasks.forEach(function (x) { byId[x.id] = x; });
  var ctx = ctxFor_(db, env);
  var vals = t.rows.map(function (r) { var x = byId[r.id]; return [x ? PlannerStatus.statusOf(x, ctx) : r.status]; });
  t.sh.getRange(2, col + 1, vals.length, 1).setValues(vals);
}

/* =====================================================================
   Письма (MVP): назначение, @упоминание, возврат — только если есть email
   ===================================================================== */
function sendMails_(notify, me, db) {
  if (!notify || !notify.length || !bool_(setting_('mail_enabled'))) return;
  var url = setting_('planner_url'), seen = {};
  var SUBJ = { assign: 'вам назначена задача', mention: 'вас упомянули', 'return': 'задачу вернули в работу' };
  notify.forEach(function (n) {
    var k = n.user + '|' + n.task;
    if (seen[k]) return;
    seen[k] = 1;
    var u = null, t = null;
    db.users.forEach(function (x) { if (x.id === n.user) u = x; });
    db.tasks.forEach(function (x) { if (x.id === n.task) t = x; });
    if (!u || !u.email || u.active === false || !t) return;
    if (MailApp.getRemainingDailyQuota() < 1) { console.warn('Квота писем на сегодня исчерпана, письмо для ' + u.id + ' не отправлено.'); return; }
    var body = me.name + ': ' + SUBJ[n.type] + '.\n\n' + t.id + ' · ' + t.title + '\nСрок: ' + t.due.split('-').reverse().join('.') +
      (n.text ? '\n\n«' + n.text + '»' : '') + '\n\nОткрыть: ' + url + '#t=' + encodeURIComponent(t.id) +
      '\n\n— Поручения отдела. Письмо отправлено автоматически, отвечать на него не нужно.';
    MailApp.sendEmail({ to: u.email, subject: '[' + t.id + '] ' + SUBJ[n.type], body: body, name: 'Поручения отдела' });
  });
}

/* =====================================================================
   Чтение и запись листов
   ===================================================================== */
function sheet_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { /* веб-приложение — открываем по id */ }
  if (!ss) {
    var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (!id) fail_('server', 'Таблица не настроена: запустите setup() из редактора.');
    ss = SpreadsheetApp.openById(id);
  }
  return ss;
}

// Прочитанные листы в пределах одного запроса: каждый лист читается один раз.
var TABLES_ = {};

// {sh, head:[колонки], rows:[{колонка:значение, __row:номер строки}]}
function readTable_(name, lastN) {
  if (!lastN && TABLES_[name]) return TABLES_[name];
  var sh = sheet_().getSheetByName(name);
  if (!sh) fail_('server', 'Нет листа «' + name + '». Запустите setup().');
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (!lastCol) fail_('server', 'Лист «' + name + '» пуст. Запустите setup().');
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var first = 2, n = lastRow - 1;
  if (lastN && n > lastN) { first = lastRow - lastN + 1; n = lastN; }
  var vals = n > 0 ? sh.getRange(first, 1, n, lastCol).getValues() : [];
  var rows = [];
  vals.forEach(function (v, i) {
    var o = { __row: first + i };
    head.forEach(function (h, j) { if (h) o[h] = cell_(v[j]); });
    if (o[head[0]] !== '') rows.push(o);
  });
  var t = { name: name, sh: sh, head: head, rows: rows };
  if (!lastN) TABLES_[name] = t;
  return t;
}

function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, (v.getHours() || v.getMinutes()) ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
  return v == null ? '' : String(v);
}
// Строка, начинающаяся с «=», иначе станет формулой.
function out_(v) {
  if (v == null) return '';
  v = String(v);
  return /^[=+]/.test(v) ? "'" + v : v;
}

// Обновить строки по ключу, новые — дописать в конец.
function upsert_(t, objs, key) {
  var index = {}, appends = [];
  t.rows.forEach(function (r) { index[r[key]] = r.__row; });
  objs.forEach(function (o) {
    var arr = t.head.map(function (h) { return h in o ? out_(o[h]) : ''; });
    var at = index[o[key]];
    if (at) t.sh.getRange(at, 1, 1, arr.length).setValues([arr]);
    else appends.push(arr);
  });
  if (appends.length) appendArrays_(t, appends);
}
function appendRows_(t, objs) {
  if (objs.length) appendArrays_(t, objs.map(function (o) { return t.head.map(function (h) { return h in o ? out_(o[h]) : ''; }); }));
}
function appendArrays_(t, arrs) {
  delete TABLES_[t.name]; // номера строк сдвинулись — следующее чтение заново
  var r = t.sh.getRange(t.sh.getLastRow() + 1, 1, arrs.length, t.head.length);
  r.setNumberFormat('@');
  r.setValues(arrs);
}

function bool_(v) { return /^(true|да|1|yes)$/i.test(String(v).trim()); }
function list_(v) { return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); }

/* ----- строки листов <-> объекты фронта ----- */
function loadDb_(opt) {
  opt = opt || {};
  var cl = {};
  readTable_('Checklist').rows.forEach(function (r) {
    (cl[r.task_id] = cl[r.task_id] || []).push({ id: r.id, text: r.text, done: bool_(r.done), by: r.done_by, at: r.done_at,
      order: +r.order || 0, due: r.due_date, createdBy: r.created_by, createdAt: r.created_at });
  });
  var tasks = readTable_('Tasks').rows.map(function (r) {
    return { id: r.id, parent: r.parent_id || null, folder: r.folder_code, title: r.title, desc: r.description, objects: list_(r.object), zone: r.zone,
      zoneId: r.zone_id, teamId: r.team_id, owner: r.owner_id, controller: r.controller_id, workType: r.work_type_id, start: r.start_date, due: r.due_date,
      prio: r.priority || 'P3', tags: list_(r.tags), dep: r.depends_on, flag: r.manual_flag, flagNote: r.flag_note,
      submitted: r.workflow === 'submitted', accepted: r.workflow === 'accepted', resched: +r.reschedule_count || 0,
      brunoRef: r.bruno_ref, brunoStatus: r.bruno_status, photo: bool_(r.photo_required), created: r.created_at, createdBy: r.created_by,
      updated: r.updated_at, version: +r.version || 1,
      checklist: (cl[r.id] || []).sort(function (a, b) { return a.order - b.order; }) };
  });
  var users = readTable_('Users').rows.map(function (r) {
    return { id: r.id, name: r.name, handle: r.handle || String(r.name).split(/\s+/)[0], role: r.role, position: r.position, objects: list_(r.objects),
      email: r.email, bruno: r.bruno_employee_id, keyHash: r.key_hash, active: bool_(r.active), lastRead: r.last_read_ts };
  });
  var folders = readTable_('Folders').rows.map(function (r) {
    var c = {};
    try { c = JSON.parse(r.counters_json || '{}'); } catch (e) { /* испорченный счётчик — считаем по кодам задач */ }
    return { code: r.code, name: r.name, order: +r.order || 0, active: r.active === '' ? true : bool_(r.active), counters: c };
  });
  var activity = opt.activity ? readTable_('Activity', opt.activity).rows.map(function (r) {
    var o = { id: r.id, task: r.task_id, ts: r.ts, author: r.author_id, type: r.type, text: r.text, mentions: list_(r.mentions) };
    if (r.payload_json) { try { o.payload = JSON.parse(r.payload_json); } catch (e) { /* не JSON — пропускаем */ } }
    return o;
  }) : [];
  return { tasks: tasks, activity: activity, users: users, folders: folders };
}

function ctxFor_(db, env) {
  var kids = {};
  db.tasks.forEach(function (t) { if (t.parent) (kids[t.parent] = kids[t.parent] || []).push(t); });
  return { today: env.today, kids: function (id) { return kids[id] || []; } };
}

function taskRow_(t, db, env) {
  return { id: t.id, parent_id: t.parent || '', folder_code: t.folder, title: t.title, description: t.desc, object: t.objects.join(', '), zone: t.zone,
    zone_id: t.zoneId, team_id: t.teamId, owner_id: t.owner, controller_id: t.controller, work_type_id: t.workType, start_date: t.start, due_date: t.due,
    status: PlannerStatus.statusOf(t, ctxFor_(db, env)), manual_flag: t.flag, flag_note: t.flagNote,
    workflow: t.accepted ? 'accepted' : t.submitted ? 'submitted' : '', priority: t.prio, tags: t.tags.join(', '), depends_on: t.dep,
    bruno_ref: t.brunoRef, bruno_status: t.brunoStatus, photo_required: t.photo ? 'TRUE' : 'FALSE', reschedule_count: t.resched,
    created_by: t.createdBy, created_at: t.created, updated_at: t.updated, version: t.version };
}
function checkRow_(taskId, c) {
  return { id: c.id, task_id: taskId, order: c.order, text: c.text, due_date: c.due || '', done: c.done ? 'TRUE' : 'FALSE', done_by: c.by, done_at: c.at,
    created_by: c.createdBy, created_at: c.createdAt };
}
function activityRow_(a) {
  return { id: a.id, task_id: a.task, ts: a.ts, author_id: a.author, type: a.type, text: a.text, payload_json: a.payload ? JSON.stringify(a.payload) : '',
    mentions: (a.mentions || []).join(', ') };
}
function userRow_(u) {
  return { id: u.id, name: u.name, handle: u.handle, role: u.role, position: u.position, objects: (u.objects || []).join(', '), email: u.email,
    bruno_employee_id: u.bruno, key_hash: u.keyHash, active: u.active ? 'TRUE' : 'FALSE', last_read_ts: u.lastRead };
}
function folderRow_(f) {
  return { code: f.code, name: f.name, order: f.order, active: f.active === false ? 'FALSE' : 'TRUE', counters_json: JSON.stringify(f.counters || {}) };
}

// Записать то, что изменило действие. Лист Activity только дописывается.
function saveDb_(db, patch, env) {
  if (patch.tasks.length) {
    upsert_(readTable_('Tasks'), patch.tasks.map(function (t) { return taskRow_(t, db, env); }), 'id');
    var cl = [];
    patch.tasks.forEach(function (t) { t.checklist.forEach(function (c) { cl.push(checkRow_(t.id, c)); }); });
    if (cl.length) upsert_(readTable_('Checklist'), cl, 'id');
  }
  if (patch.users.length) {
    var full = patch.users.map(function (p) { var u = null; db.users.forEach(function (x) { if (x.id === p.id) u = x; }); return userRow_(u); });
    upsert_(readTable_('Users'), full, 'id');
  }
  if (patch.folders.length) upsert_(readTable_('Folders'), patch.folders.map(folderRow_), 'code');
  if (patch.activity.length) appendRows_(readTable_('Activity'), patch.activity.map(activityRow_));
}

/* ----- мелочи ----- */
function env_() {
  var d = new Date();
  return {
    ts: Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm'),
    today: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'),
    year: Utilities.formatDate(d, TZ, 'yy'),
    uid: function () { return Utilities.getUuid().replace(/-/g, '').slice(0, 16); }
  };
}
function setting_(key) {
  var v = '';
  readTable_('Settings').rows.forEach(function (r) { if (r.key === key) v = r.value; });
  return v;
}
function fail_(code, message) { throw { error: code, message: message }; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
