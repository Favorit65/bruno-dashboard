/* Вход по почтовому коду, закрытые вложения и добровольная сводка.
   Внешнее развёртывание и доставка на банковскую почту в пилоте не проверялись. */
function parsePreferences_(s) { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } }
function loginUser_(email) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@vtb\.ru$/.test(email)) return null;
  var matches = readTable_('Users').rows.filter(function (u) { return bool_(u.active) && String(u.email).trim().toLowerCase() === email; });
  return matches.length === 1 ? matches[0] : null;
}
function requestCode_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    TABLES_ = {};
    var u = loginUser_(p.email), props = PropertiesService.getScriptProperties();
    var answer = {ok:true, message:'Если адрес есть в списке доступа, код отправлен. Он действует 10 минут.'};
    if (!u) return answer;
    var key = 'OTP_' + sha256Hex_(u.id), old = parsePreferences_(props.getProperty(key)), now = Date.now();
    if (old.sent && now - old.sent < 60000) return answer;
    var day = env_().today, countKey = 'OTP_COUNT_' + sha256Hex_(u.id);
    var count = parsePreferences_(props.getProperty(countKey));
    if (count.day === day && count.n >= 10) return answer;
    if (MailApp.getRemainingDailyQuota() < 1) fail_('busy', 'Отправка почты временно недоступна. Обратитесь к модератору.');
    var salt = Utilities.getUuid(), code = String(parseInt(sha256Hex_(Utilities.getUuid()).slice(0, 8), 16) % 1000000);
    while (code.length < 6) code = '0' + code;
    MailApp.sendEmail(u.email, 'Код входа в планировщик', 'Код: ' + code + '\nДействует 10 минут. Не передавайте его другим людям.');
    props.setProperty(key, JSON.stringify({hash:sha256Hex_(salt + code), salt:salt, expires:now + 600000, attempts:0, sent:now}));
    props.setProperty(countKey, JSON.stringify({day:day,n:count.day === day ? (+count.n || 0) + 1 : 1}));
    return answer;
  } finally { lock.releaseLock(); }
}
function verifyCode_(p) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    TABLES_ = {};
    var u = loginUser_(p.email), props = PropertiesService.getScriptProperties();
    if (!u) fail_('auth', 'Код неверен или истёк.');
    var key = 'OTP_' + sha256Hex_(u.id), otp = parsePreferences_(props.getProperty(key));
    if (!otp.expires || otp.expires < Date.now() || otp.attempts >= 5) fail_('auth', 'Код неверен или истёк.');
    otp.attempts++; props.setProperty(key, JSON.stringify(otp));
    if (!/^\d{6}$/.test(String(p.code)) || sha256Hex_(otp.salt + p.code) !== otp.hash) fail_('auth', 'Код неверен или истёк.');
    props.deleteProperty(key);
    var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    u.key_hash = sha256Hex_(token); u.session_expires = String(Date.now() + 7 * 86400000);
    upsert_(readTable_('Users'), [u], 'id');
    return {ok:true, key:token};
  } finally { lock.releaseLock(); }
}
function prepareAttachments_(db, me, p) {
  var files = p.files || [];
  // Клиенту нельзя подставить ссылку на чужой файл.
  p.attachments = [];
  if (!files.length) return p;
  var task = db.tasks.filter(function (t) { return t.id === p.id; })[0];
  if (!PlannerCore.canView(db, me.id, task)) fail_('forbidden', 'Нет доступа к задаче.');
  if (files.length > 3) fail_('bad_request', 'Не более трёх файлов в комментарии.');
  var decoded = [], total = 0;
  files.forEach(function (f) {
    if (!/\.(pdf|png|jpe?g|webp|heic|heif|txt|csv|docx|xlsx|pptx)$/i.test(f.name || '')) fail_('bad_request', 'Этот формат вложения не поддерживается.');
    if (String(f.data || '').length > 2800000) fail_('bad_request', 'Файл больше 2 МБ.');
    var bytes = Utilities.base64Decode(f.data); total += bytes.length;
    if (total > 2 * 1024 * 1024) fail_('bad_request', 'Общий размер файлов — до 2 МБ.');
    decoded.push({name:String(f.name).slice(0,150), bytes:bytes});
  });
  // Проверяем комментарий и права до создания файлов.
  PlannerCore.handle(JSON.parse(JSON.stringify(db)), me.id, 'addComment', {id:p.id,text:p.text || 'Вложения'}, env_());
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('ATTACHMENT_FOLDER_ID');
  var folder = id ? DriveApp.getFolderById(id) : DriveApp.createFolder('Планировщик — закрытые вложения');
  if (!id) props.setProperty('ATTACHMENT_FOLDER_ID', folder.getId());
  decoded.forEach(function (f) {
    var file = folder.createFile(Utilities.newBlob(f.bytes, 'application/octet-stream', f.name));
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    p.attachments.push({id:file.getId(),name:f.name,size:f.bytes.length});
  });
  return p;
}
function downloadAttachment_(me, p) {
  var db = loadDb_({activity:0}), task = db.tasks.filter(function (t) { return t.id === p.id; })[0];
  if (!PlannerCore.canView(db, me.id, task)) fail_('forbidden', 'Нет доступа к задаче.');
  var found = false;
  readTable_('Activity').rows.forEach(function (a) {
    if (a.task_id !== p.id) return;
    var payload = parsePreferences_(a.payload_json);
    (payload.attachments || []).forEach(function (f) { if (f.id === p.fileId) found = true; });
  });
  if (!found) fail_('not_found', 'Вложение не найдено.');
  var file = DriveApp.getFileById(p.fileId);
  return {ok:true,name:file.getName(),data:Utilities.base64Encode(file.getBlob().getBytes())};
}
function sendDailyDigests() {
  var db = loadDb_(), today = env_().today, settings = setting_('planner_url');
  if (!bool_(setting_('mail_enabled'))) return;
  db.users.forEach(function (u) {
    if (!u.active || !u.email || !(u.preferences || {}).digest) return;
    var tasks = db.tasks.filter(function (t) { return t.owner === u.id && !t.accepted && t.flag !== 'cancelled'; });
    var current=(db.shortTasks||[]).filter(function(t){return t.owner===u.id&&!t.done;});
    if ((!tasks.length&&!current.length) || MailApp.getRemainingDailyQuota() < 1) return;
    var props = PropertiesService.getScriptProperties(), key = 'DIGEST_' + sha256Hex_(u.id);
    if (props.getProperty(key) === today) return;
    var body = tasks.map(function (t) { return t.id + ' · ' + t.title + ' · до ' + t.due + (t.due < today ? ' · ПРОСРОЧЕНО' : ''); }).join('\n');
    body='ДОЛГОСРОЧНЫЕ\n'+(body||'Нет задач')+'\n\nТЕКУЩИЕ\n'+(current.sort(function(a,b){return a.dueAt.localeCompare(b.dueAt);}).map(function(t){return t.title+' · до '+t.dueAt.replace('T',' ')+' МСК';}).join('\n')||'Нет задач');
    MailApp.sendEmail(u.email, 'Ваши незавершённые задачи', body + '\n\n' + settings);
    props.setProperty(key, today);
  });
}
