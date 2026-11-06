/* Планировщик поручений: права (ТЗ §2, объект R прототипа) и действия API.
   Работает поверх «базы в памяти» — db = {tasks, activity, users, folders}
   в форме фронта (поля как в прототипе docs/planner_demo.html).

   ОДИН И ТОТ ЖЕ код используется:
     - сервером: apps-script/Core.gs — копия этого файла; Code.gs читает листы
       таблицы в db, вызывает PlannerCore.handle() и пишет изменённое обратно;
     - фронтом в демо (?demo=1): mock-сервер на localStorage;
     - фронтом для оптимистичного обновления: то же действие применяется к
       локальной копии сразу, не дожидаясь ответа сервера.
   Поэтому права и правила (обязательные комментарии, коды, теги) одинаковы
   везде. Правите здесь — копируйте файл в Core.gs и запускайте `node --test`.

   Зависит от PlannerStatus (shared/status.js / Status.gs). */
var PlannerCore = (function () {
  'use strict';
  // PlannerStatus ищем при первом вызове, а не при загрузке: в Apps Script порядок
  // файлов проекта произвольный, и Core.gs может выполниться раньше Status.gs.
  var S_ = null;
  function St() { if (!S_) S_ = (typeof PlannerStatus !== 'undefined') ? PlannerStatus : require('./status.js'); return S_; }
  var BRUNO_ST = ['NEW', 'WAITING', 'COMPLETING', 'COMPLETED', 'MISSED'];
  var ROLES = ['head', 'mod', 'owner', 'observer'];
  // Действия, которые меняют саму задачу и поэтому сверяют version.
  // Пункты чек-листа, комментарии и подзадачи — точечные добавления, version не трогают.
  var VERSIONED = { shortUpdate:1, shortToggle:1, updateTask: 1, submit: 1, accept: 1, 'return': 1, setBlocker: 1, clearBlocker: 1, reschedule: 1, cancel: 1, setBrunoRef: 1 };

  function fail(code, message) { throw { error: code, message: message }; }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function isDate(s) { if(!/^\d{4}-\d\d-\d\d$/.test(s))return false;var d=new Date(s+'T00:00:00Z');return isFinite(+d)&&d.toISOString().slice(0,10)===s; }
  function fd(s) { return s ? s.slice(8, 10) + '.' + s.slice(5, 7) : '—'; }
  function lc(s) { return String(s).toLowerCase(); }

  /* ---------- окружение запроса ---------- */
  function ctxOf(db, env) {
    var byId = {}, kidsOf = {};
    db.tasks.forEach(function (t) { byId[t.id] = t; if (t.parent) (kidsOf[t.parent] = kidsOf[t.parent] || []).push(t); });
    return {
      today: env.today,
      T: function (id) { return byId[id] || null; },
      kids: function (id) { return kidsOf[id] || []; }
    };
  }
  function userOf(db, id) { for (var i = 0; i < db.users.length; i++) if (db.users[i].id === id) return db.users[i]; return null; }
  function canView(db, meId, t) {
    var me = userOf(db, meId);
    if (!me || me.active === false || !t) return false;
    if (me.role === 'head' || me.role === 'mod') return true;
    var root = t.parent || t.id;
    var children = db.tasks.filter(function (x) { return x.parent === root; });
    return children.length ? children.some(function (x) { return x.owner === meId; }) : t.owner === meId;
  }

  /* ---------- права (ТЗ §2; как объект R в прототипе) ---------- */
  function rights(db, meId, env) {
    var c = ctxOf(db, env), me = userOf(db, meId) || { role: 'observer' };
    var mgr = me.role === 'head' || me.role === 'mod', mod = me.role === 'mod';
    var st = function (t) { return St().statusOf(t, c); };
    var not = function (t, list) { return list.indexOf(st(t)) < 0; };
    var isLeaf = function (t) { return !c.kids(t.id).length; };
    var R = {
      isMgr: function () { return mgr; },
      view: function (t) { return canView(db, meId, t); },
      edit: function (t) { return R.view(t) && (mgr || t.owner === meId); },
      check: function (t) { return R.edit(t) && not(t, ['done', 'review', 'cancelled']); },
      submit: function (t) { return (t.owner === meId || mgr) && not(t, ['done', 'review', 'cancelled']); },
      accept: function (t) { return mgr && st(t) === 'review'; },
      block: function (t) { return (t.owner === meId || mgr) && not(t, ['done', 'cancelled']); },
      resched: function (t) { return mgr && not(t, ['done', 'cancelled']); },
      sub: function (t) { return !t.parent && not(t, ['done', 'review', 'cancelled']) && R.view(t); },
      bruno: function (t) { return mgr && isLeaf(t) && t.flag !== 'cancelled'; },
      update: function (t) { return mgr && t.flag !== 'cancelled'; },
      cancel: function (t) { return mgr && not(t, ['done', 'cancelled']); },
      create: function () { return mgr; },
      comment: function (t) { return !!t && R.view(t); }
    };
    return R;
  }

  /* ---------- теги, упоминания, коды ---------- */
  var TAG_RE = /#[\wА-Яа-яЁё\-]+/g;
  function allTags(db) {
    var m = {}, out = [];
    db.tasks.forEach(function (t) { (t.tags || []).forEach(function (g) { if (!m[lc(g)]) { m[lc(g)] = 1; out.push(g); } }); });
    return out;
  }
  // Регистр тега берётся у уже существующего (#вип → #VIP, если #VIP уже есть).
  function extractTags(text, existing) {
    var out = [];
    (String(text).match(TAG_RE) || []).forEach(function (tg) {
      var raw = tg.slice(1), k = lc(raw), hit = null, i;
      for (i = 0; i < existing.length && !hit; i++) if (lc(existing[i]) === k) hit = existing[i];
      for (i = 0; i < out.length && !hit; i++) if (lc(out[i]) === k) hit = out[i];
      hit = hit || raw;
      if (out.indexOf(hit) < 0) out.push(hit);
    });
    return { tags: out, clean: String(text).replace(TAG_RE, '').replace(/\s{2,}/g, ' ').trim() };
  }
  function mergeTags(a, b) {
    var out = (a || []).slice();
    (b || []).forEach(function (g) { if (!out.some(function (x) { return lc(x) === lc(g); })) out.push(g); });
    return out;
  }
  function parseMentions(db, text) {
    var ids = [];
    (String(text).match(/@([\wА-Яа-яЁё_]+)/g) || []).forEach(function (x) {
      var h = lc(x.slice(1));
      db.users.forEach(function (u) { if (u.active !== false && u.handle && lc(u.handle) === h && ids.indexOf(u.id) < 0) ids.push(u.id); });
    });
    return ids;
  }
  function newFolderCode(db,name){
    var words=String(name).toUpperCase().match(/[А-ЯЁA-Z0-9]+/g)||[];
    var base=(words.length>1?words.map(function(w){return w[0];}).join(''):words.join('').slice(0,3)).slice(0,8)||'ПП';
    if(base.length<2)base+='1';var code=base,n=2;
    while(db.folders.some(function(f){return f.code===code;})){code=base+String(n++);}
    return code;
  }
  function folderOf(db, code) { for (var i = 0; i < db.folders.length; i++) if (db.folders[i].code === code) return db.folders[i]; return null; }
  // ПАПКА-ГГ-NNN: свой счётчик у папки на каждый год, номер не переиспользуется.
  function nextCode(db, code, year) {
    var f = folderOf(db, code), re = new RegExp('^' + code + '-' + year + '-(\\d{3,})$'), mx = 0;
    if (f && f.counters && f.counters[year]) mx = +f.counters[year];
    db.tasks.forEach(function (t) { var m = t.id.match(re); if (m) mx = Math.max(mx, +m[1]); });
    var n = mx + 1, s = String(n);
    while (s.length < 3) s = '0' + s;
    return { id: code + '-' + year + '-' + s, n: n };
  }
  function nextSub(db, pid) {
    var mx = 0;
    db.tasks.forEach(function (t) { if (t.parent === pid) mx = Math.max(mx, +t.id.slice(pid.length + 1) || 0); });
    return pid + '.' + (mx + 1);
  }

  /* ---------- обработчик действий ---------- */
  // env = {ts:'ГГГГ-ММ-ДД ЧЧ:ММ', today:'ГГГГ-ММ-ДД', year:'26', uid:function(){...}}
  // Возвращает {patch:{tasks,activity,users,folders}, notify:[...], result:{...}}.
  function handle(db, meId, action, p, env) {
    p = p || {};
    if(action.indexOf('short')===0)return (typeof CurrentTasks!=='undefined'?CurrentTasks:require('./current.js')).handle(db,meId,action,p,env);
    var me = userOf(db, meId);
    if (!me || me.active === false) fail('auth', 'Пользователь не найден или отключён.');
    var R = rights(db, meId, env), c = ctxOf(db, env);
    var dirtyT = {}, dirtyU = {}, dirtyF = {}, acts = [], notify = [], result = {};
    var name = function (id) { var u = userOf(db, id); return u ? u.name : '—'; };
    var handleOf = function (id) { var u = userOf(db, id); return u ? u.handle : '?'; };
    var touch = function (t, bump) { if (bump) t.version = (+t.version || 0) + 1; t.updated = env.ts; dirtyT[t.id] = t; };
    var log = function (task, type, text, mentions, payload) {
      var a = { id: 'a' + env.uid(), task: task, ts: env.ts, author: meId, type: type, text: text, mentions: mentions || [] };
      if (payload) a.payload = payload;
      db.activity.push(a); acts.push(a); return a;
    };
    var need = function (ok, msg) { if (!ok) fail('forbidden', msg || 'Недостаточно прав для этого действия.'); };
    var task = function () {
      var t = c.T(str(p.id));
      if (!t) fail('not_found', 'Задача ' + str(p.id) + ' не найдена.');
      need(R.view(t));
      if (VERSIONED[action] && p.version != null && +p.version !== +t.version) fail('conflict', 'Задачу изменили, обновите.');
      return t;
    };
    var userId = function (id, what) { var u = userOf(db, id); if (!u || u.active === false) fail('bad_request', 'Не выбран ' + what + '.'); return id; };
    var headId = function () {
      var heads = db.users.filter(function (u) { return u.role === 'head' && u.active !== false; });
      if (heads.length !== 1) fail('bad_request', 'В списке сотрудников должен быть один действующий руководитель.');
      return heads[0].id;
    };
    var dates = function (st, du) {
      if (!isDate(st) || !isDate(du)) fail('bad_request', 'Укажите старт и дедлайн.');
      if (du < st) fail('bad_request', 'Дедлайн раньше старта.');
    };
    var clItems = function (id, list) {
      var rows=[];(list||[]).forEach(function(x){var text=str(x&&typeof x==='object'?x.text:x),done=!!(x&&typeof x==='object'&&x.done);text.split(/\r?\n/).forEach(function(line){line=line.replace(/^\s*[•○◯]\s*/, '').trim();if(line)rows.push({text:line,done:done});});});
      if(rows.length>100)fail('bad_request','До 100 пунктов за один раз.');
      return rows.map(function(x,i){return {id:id+'-c'+env.uid(),text:x.text,done:x.done,by:x.done?meId:'',at:x.done?env.ts:'',order:i+1,createdBy:meId,createdAt:env.ts};});
    };
    var newTask = function (id, parent, o) {
      var t = { id: id, parent: parent ? parent.id : null, folder: o.folder, title: o.title, desc: o.desc || '', objects: o.objects || [], zone: o.zone || '', zoneId: '', teamId: '',
        owner: o.owner, controller: o.controller, workType: o.workType || '', start: o.start, due: o.due, prio: o.prio, tags: o.tags || [], dep: o.dep || '',
        flag: '', flagNote: '', submitted: false, accepted: false, resched: 0, brunoRef: '', brunoStatus: '', photo: false,
        created: env.ts, createdBy: meId, updated: env.ts, version: 1, checklist: [] };
      t.checklist = clItems(id, o.checklist);
      db.tasks.push(t); dirtyT[id] = t;
      c = ctxOf(db, env); R = rights(db, meId, env);
      return t;
    };
    var assigned = function (t) {
      if (t.owner === meId) return;
      log(t.id, 'assign', 'назначил(а) ответственным @' + handleOf(t.owner), [t.owner]);
      notify.push({ type: 'assign', user: t.owner, task: t.id });
    };

    switch (action) {
      case 'saveUser': {
        need(R.isMgr());
        var uid = str(p.userId), role = str(p.role), email = str(p.email).toLowerCase(), subtype = str(p.subtype);
        if (role === 'head') subtype = '';
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(uid) || !str(p.name) || !/^[^\s@]+@vtb\.ru$/.test(email)) fail('bad_request', 'Укажите id, имя и почту @vtb.ru.');
        if (['head','mod','owner'].indexOf(role) < 0) fail('bad_request', 'Неизвестная роль.');
        if (role !== 'head' && ['admin','commandant','inspector','moderator'].indexOf(subtype) < 0) fail('bad_request', 'Выберите тип ответственного.');
        if ((role === 'mod') !== (subtype === 'moderator')) fail('bad_request', 'Тип «Модератор» соответствует правам модератора.');
        if (role === 'head' && db.users.some(function (u) { return u.id !== uid && u.role === 'head' && u.active !== false; })) fail('bad_request', 'Руководитель может быть только один.');
        if (db.users.some(function (u) { return u.id !== uid && lc(u.email || '') === email; })) fail('bad_request', 'Этот адрес уже используется.');
        var person = userOf(db, uid);
        if(person&&person.role==='head'&&person.active!==false&&(role!=='head'||p.active===false))fail('bad_request','В планировщике должен оставаться один активный руководитель.');
        if (person && person.id === meId && (role !== person.role || p.active === false)) fail('bad_request', 'Нельзя отключить или понизить собственный доступ.');
        if (!person) { person = {id:uid, keyHash:'', lastRead:'', active:true}; db.users.push(person); }
        if (person.email && person.email !== email) { person.keyHash = ''; person.sessionExpires = ''; }
        person.name = str(p.name); person.email = email; person.role = role; person.subtype = role === 'head' ? '' : subtype;
        person.handle = str(p.handle) || uid; person.active = p.active !== false; dirtyU[uid] = person;
        break;
      }
      case 'saveFolder': {
        need(R.isMgr());
        var fn = str(p.name),fc = str(p.code).toUpperCase()||newFolderCode(db,fn);
        if (!/^[А-ЯЁA-Z0-9]{2,12}$/.test(fc) || !fn || fn.length > 100) fail('bad_request', 'Укажите код папки (2–12 букв/цифр) и название до 100 знаков.');
        var folder = folderOf(db, fc);
        if (!folder) { folder = {code:fc, counters:{}, order:db.folders.reduce(function(m,f){return Math.max(m,+f.order||0);},0)+1}; db.folders.push(folder); }
        folder.name = fn; if(p.active!=null)folder.active=p.active!==false;else if(folder.active==null)folder.active=true;dirtyF[fc] = folder;result.code=fc;
        break;
      }
      case 'moveFolder': {
        need(R.isMgr());var ordered=db.folders.slice().sort(function(a,b){return (+a.order||0)-(+b.order||0)||a.code.localeCompare(b.code);});
        var at=ordered.findIndex(function(f){return f.code===str(p.code);}),step=+p.direction;
        if(at<0)fail('not_found','Папка не найдена.');if(step!==1&&step!==-1)fail('bad_request','Выберите направление.');
        var to=at+step;if(to<0||to>=ordered.length)break;
        var moved=ordered.splice(at,1)[0];ordered.splice(to,0,moved);
        ordered.forEach(function(f,i){f.order=i+1;dirtyF[f.code]=f;});break;
      }
      case 'deleteFolder': {
        need(R.isMgr());
        var df = folderOf(db, str(p.code));
        if (!df) fail('not_found', 'Папка не найдена.');
        if (db.tasks.concat(db.shortTasks||[]).some(function (t) { return t.folder === df.code; })) fail('bad_request', 'Папка содержит задачи. Используйте архивирование.');
        db.folders = db.folders.filter(function (f) { return f.code !== df.code; });
        dirtyF[df.code] = {code:df.code, deleted:true};
        break;
      }
      case 'savePreferences': {
        me.preferences = {assign:p.assign !== false, mention:p.mention !== false, returned:p.returned !== false, digest:!!p.digest, shortAssign:p.shortAssign!==false, shortReschedule:p.shortReschedule!==false, shortReminder:p.shortReminder!==false};
        dirtyU[me.id] = me;
        break;
      }
      case 'createTask': {
        need(R.create(), 'Создавать поручения могут руководитель и модератор.');
        var f = folderOf(db, str(p.folder));
        if (!f || f.active === false) fail('bad_request', 'Выберите папку.');
        var raw = str(p.title); if (!raw) fail('bad_request', 'Укажите название.');
        var ex = extractTags(raw, allTags(db)); if (!ex.clean) fail('bad_request', 'Название не может состоять только из тегов.');
        dates(str(p.start), str(p.due));
        var prio = ['P1', 'P2', 'P3'].indexOf(p.prio) >= 0 ? p.prio : 'P3';
        var code = nextCode(db, f.code, env.year);
        f.counters = f.counters || {}; f.counters[env.year] = code.n; dirtyF[f.code] = f;
        var t = newTask(code.id, null, { folder: f.code, title: ex.clean, desc: str(p.desc), prio: prio, tags: ex.tags,
          objects: (p.objects || []).map(str).filter(Boolean), owner: userId(p.owner, 'ответственный'), controller: headId(),
          workType: str(p.workType), start: str(p.start), due: str(p.due), checklist: p.checklist });
        log(t.id, 'created', 'создал(а) поручение');
        assigned(t);
        result.id = t.id;
        break;
      }
      case 'addSubtask': {
        var par = c.T(str(p.parent)); if (!par) fail('not_found', 'Поручение не найдено.');
        need(R.sub(par), 'Подзадачи добавляют руководитель, модератор и ответственный за поручение.');
        var raw2 = str(p.title); if (!raw2) fail('bad_request', 'Укажите название.');
        var ex2 = extractTags(raw2, allTags(db)); if (!ex2.clean) fail('bad_request', 'Название не может состоять только из тегов.');
        dates(str(p.start), str(p.due));
        if (str(p.due) > par.due) fail('bad_request', 'Дедлайн подзадачи не может быть позже срока поручения.');
        var sid = nextSub(db, par.id);
        var s = newTask(sid, par, { desc:str(p.desc), folder: par.folder, title: ex2.clean, prio: par.prio, tags: mergeTags(par.tags, ex2.tags), objects: par.objects.slice(), zone: par.zone,
          owner: userId(p.owner, 'ответственный'), controller: headId(), workType: par.workType, start: str(p.start), due: str(p.due), checklist: p.checklist });
        log(par.id, 'subtask_added', 'добавил(а) подзадачу ' + sid + ' «' + ex2.clean + '»');
        log(sid, 'created', 'создал(а) подзадачу');
        assigned(s);
        result.id = sid;
        break;
      }
      case 'updateTask': {
        var u = task(); need(R.update(u), 'Менять поля поручения могут руководитель и модератор.');
        var fl = p.fields || {}, changed = [], kids = c.kids(u.id);
        if (fl.title != null) {
          var ex3 = extractTags(str(fl.title), allTags(db)); if (!ex3.clean) fail('bad_request', 'Укажите название.');
          if (ex3.clean !== u.title) { u.title = ex3.clean; changed.push('название'); }
          var mt = mergeTags(u.tags, ex3.tags); if (mt.length !== u.tags.length) { u.tags = mt; changed.push('теги'); }
        }
        if (fl.desc != null && str(fl.desc) !== u.desc) { u.desc = str(fl.desc); changed.push('описание'); }
        if (fl.folder != null && fl.folder !== u.folder && !u.parent) {
          if (!folderOf(db, fl.folder)) fail('bad_request', 'Нет такой папки.');
          u.folder = fl.folder; changed.push('папка'); kids.forEach(function (k) { k.folder = u.folder; touch(k, true); });
        }
        if (fl.prio != null && fl.prio !== u.prio && !u.parent) {
          if (['P1', 'P2', 'P3'].indexOf(fl.prio) < 0) fail('bad_request', 'Приоритет — P1, P2 или P3.');
          u.prio = fl.prio; changed.push('приоритет'); kids.forEach(function (k) { k.prio = u.prio; touch(k, true); });
        }
        if (fl.objects != null) { var ob = fl.objects.map(str).filter(Boolean); if (ob.join(',') !== u.objects.join(',')) { u.objects = ob; changed.push('объект'); } }
        if (fl.zone != null && str(fl.zone) !== u.zone) { u.zone = str(fl.zone); changed.push('зона'); }
        if (fl.workType != null && str(fl.workType) !== u.workType) { u.workType = str(fl.workType); changed.push('вид работ'); }
        if (fl.controller != null && fl.controller !== u.controller) { u.controller = headId(); changed.push('руководитель'); }
        if (fl.start != null && str(fl.start) !== u.start) { dates(str(fl.start), u.due); u.start = str(fl.start); changed.push('старт'); }
        if (fl.photo != null && !!fl.photo !== !!u.photo) { u.photo = !!fl.photo; changed.push('фото'); }
        if (fl.dep != null && str(fl.dep) !== u.dep) { if (str(fl.dep) && !c.T(str(fl.dep))) fail('bad_request', 'Нет задачи ' + str(fl.dep) + '.'); u.dep = str(fl.dep); changed.push('зависимость'); }
        var ownerChanged = fl.owner != null && fl.owner !== u.owner;
        if (ownerChanged) u.owner = userId(fl.owner, 'ответственный');
        if (!changed.length && !ownerChanged) break;
        touch(u, true);
        if (changed.length) log(u.id, 'status', 'изменил(а): ' + changed.join(', '));
        if (ownerChanged) assigned(u);
        break;
      }
      case 'addCheckItem': {
        var a = c.T(str(p.id)); if (!a) fail('not_found', 'Задача не найдена.');
        need(R.check(a), 'Пункты добавляет ответственный, пока задача не сдана.');
        var items=clItems(a.id,p.items||[p.text]);if(!items.length)fail('bad_request','Пустой пункт.');
        var offset=a.checklist.reduce(function(m,x){return Math.max(m,+x.order||0);},0);
        items.forEach(function(item,i){item.order=offset+i+1;a.checklist.push(item);log(a.id,'check','добавил(а) пункт «'+item.text+'»');});
        touch(a,false);result.item=items[0].id;
        break;
      }
      case 'toggleCheck': {
        var b = c.T(str(p.id)); if (!b) fail('not_found', 'Задача не найдена.');
        need(R.check(b), 'Отмечать пункты может ответственный, пока задача не сдана.');
        var it = null; b.checklist.forEach(function (x) { if (x.id === p.item) it = x; });
        if (!it) fail('not_found', 'Пункт не найден.');
        var done = !!p.done;
        if (it.done === done) break; // уже в нужном состоянии — повтор запроса ничего не портит
        it.done = done;
        if (done) { it.by = meId; it.at = env.ts; log(b.id, 'check', 'отметил(а) «' + it.text + '»'); }
        else { it.by = ''; it.at = ''; log(b.id, 'uncheck', 'снял(а) отметку «' + it.text + '»'); }
        touch(b, false);
        break;
      }
      case 'addComment': {
        var cm = c.T(str(p.id)); if (!cm) fail('not_found', 'Задача не найдена.');
        need(R.comment(cm));
        var body = str(p.text); if (!body && !(p.attachments || []).length) fail('bad_request', 'Пустой комментарий.');
        if (body.length > 5000) fail('bad_request', 'Комментарий длиннее 5000 знаков.');
        var men = parseMentions(db, body);
        log(cm.id, 'comment', body, men, {attachments:p.attachments || []});
        men.forEach(function (uid) { if (uid !== meId) notify.push({ type: 'mention', user: uid, task: cm.id, text: body }); });
        var tg = extractTags(body, allTags(db)).tags, mt2 = mergeTags(cm.tags, tg);
        if (mt2.length !== cm.tags.length) { cm.tags = mt2; touch(cm, false); }
        result.mentions = men;
        break;
      }
      case 'submit': {
        var sb = task(); need(R.submit(sb));
        sb.submitted = true; touch(sb, true);
        log(sb.id, 'submit', 'сдал(а) на проверку @' + handleOf(sb.controller), [sb.controller]);
        break;
      }
      case 'accept': {
        var ac = task(); need(R.accept(ac), 'Принимает контролёр задачи или модератор.');
        ac.accepted = true; ac.submitted = false; touch(ac, true);
        log(ac.id, 'accept', 'принял(а) работу');
        break;
      }
      case 'return': {
        var rt = task(); need(R.accept(rt), 'Возвращает контролёр задачи или модератор.');
        var why = str(p.comment); if (!why) fail('bad_request', 'Без комментария вернуть нельзя.');
        rt.submitted = false; rt.accepted = false; touch(rt, true);
        log(rt.id, 'return', 'вернул(а) в работу: ' + why + ' @' + handleOf(rt.owner), [rt.owner]);
        notify.push({ type: 'return', user: rt.owner, task: rt.id, text: why });
        break;
      }
      case 'setBlocker': {
        var bl = task(); need(R.block(bl));
        var note = str(p.comment); if (!note) fail('bad_request', 'Опишите, что мешает.');
        bl.flag = 'blocker'; bl.flagNote = note; touch(bl, true);
        log(bl.id, 'blocker', 'Блокер: ' + note);
        break;
      }
      case 'clearBlocker': {
        var ub = task(); need(R.block(ub) && ub.flag === 'blocker', 'Блокера нет или нет прав его снять.');
        var how = str(p.comment); if (!how) fail('bad_request', 'Напишите, как решилось.');
        ub.flag = ''; ub.flagNote = ''; touch(ub, true);
        log(ub.id, 'unblock', 'снял(а) блокер: ' + how);
        break;
      }
      case 'reschedule': {
        var rs = task(); need(R.resched(rs), 'Переносит срок контролёр задачи или модератор.');
        var d = str(p.due), reason = str(p.reason);
        if (!isDate(d)) fail('bad_request', 'Укажите дату.');
        if (d === rs.due) fail('bad_request', 'Новая дата совпадает с текущей.');
        if (d < rs.start) fail('bad_request', 'Дедлайн не может быть раньше старта.');
        if (rs.parent && d > c.T(rs.parent).due) fail('bad_request', 'Дедлайн подзадачи позже срока поручения.');
        if (c.kids(rs.id).some(function (x) { return x.flag !== 'cancelled' && x.due > d; })) fail('bad_request', 'Сначала измените сроки подзадач, выходящих за новый дедлайн.');
        if (!reason) fail('bad_request', 'Без причины перенос невозможен.');
        log(rs.id, 'due_change', 'Срок ' + fd(rs.due) + ' → ' + fd(d) + '. Причина: ' + reason, [], { from: rs.due, to: d });
        rs.due = d; rs.resched = (+rs.resched || 0) + 1; touch(rs, true);
        break;
      }
      case 'cancel': {
        var cn = task(); need(R.cancel(cn), 'Отменять могут руководитель и модератор.');
        var cr = str(p.reason); if (!cr) fail('bad_request', 'Укажите причину отмены.');
        cn.flag = 'cancelled'; cn.flagNote = cr; touch(cn, true);
        log(cn.id, 'status', 'отменил(а): ' + cr);
        c.kids(cn.id).forEach(function (k) {
          if (k.flag === 'cancelled' || k.accepted) return;
          k.flag = 'cancelled'; k.flagNote = 'отменено вместе с поручением'; touch(k, true);
          log(k.id, 'status', 'отменено вместе с поручением ' + cn.id);
        });
        break;
      }
      case 'setBrunoRef': {
        var br = task(); need(R.bruno(br), 'Связь с Bruno ставит модератор или руководитель, у задачи без подзадач.');
        var ref = str(p.ref); if (!/^\d{3,}$/.test(ref)) fail('bad_request', 'ID задачи Bruno — только цифры, минимум 3.');
        var bs = BRUNO_ST.indexOf(p.status) >= 0 ? p.status : 'NEW';
        var first = !br.brunoRef;
        br.brunoRef = ref; br.brunoStatus = bs;
        if (p.zoneId != null) br.zoneId = str(p.zoneId);
        if (p.teamId != null) br.teamId = str(p.teamId);
        touch(br, true);
        log(br.id, 'bruno', first ? 'передал(а) в Bruno, задача #' + ref : 'обновил(а) связь с Bruno: #' + ref + ', статус ' + bs);
        break;
      }
      case 'markRead': {
        me.lastRead = env.ts; dirtyU[me.id] = me;
        break;
      }
      default: fail('bad_request', 'Неизвестное действие: ' + action);
    }

    var patch = { tasks: [], activity: acts, users: [], folders: [] };
    Object.keys(dirtyT).forEach(function (k) { patch.tasks.push(dirtyT[k]); });
    Object.keys(dirtyU).forEach(function (k) { patch.users.push(publicUser(dirtyU[k])); });
    Object.keys(dirtyF).forEach(function (k) { patch.folders.push(dirtyF[k]); });
    return { patch: patch, notify: notify, result: result };
  }

  // Авторизованному клиенту: рабочая почта для поиска, без ключей и сеансов.
  function publicUser(u) {
    return { id: u.id, name: u.name, handle: u.handle, role: ROLES.indexOf(u.role) >= 0 ? u.role : 'observer', position: u.position || '',
      objects: u.objects || [], bruno: u.bruno || '', active: u.active !== false, lastRead: u.lastRead || '', color: u.color || '', hasEmail: !!u.email,
      email: u.email || '', subtype: u.subtype || '', preferences: u.preferences || {assign:true, mention:true, returned:true, digest:false} };
  }
  // Ответ bootstrap: всё, что нужно фронту, плюс «кто я».
  function snapshot(db, meId, limit) {
    var act = db.activity.slice().sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0; });
    var tasks = db.tasks.filter(function (t) { return canView(db, meId, t); });
    var ids = {}; tasks.forEach(function (t) { ids[t.id] = true; });
    act = act.filter(function (a) { return ids[a.task]; });
    return { shortTasks:(typeof CurrentTasks!=='undefined'?CurrentTasks:require('./current.js')).snapshot(db,meId), me: meId, tasks: tasks, activity: act.slice(Math.max(0, act.length - (limit || 300))),
      users: db.users.map(publicUser), folders: db.folders.slice().sort(function (a, b) { return (+a.order || 0) - (+b.order || 0); }) };
  }

  return { handle: handle, rights: rights, snapshot: snapshot, publicUser: publicUser, canView: canView, extractTags: extractTags, allTags: allTags,
    parseMentions: parseMentions, nextCode: nextCode, nextSub: nextSub, VERSIONED: VERSIONED, BRUNO_ST: BRUNO_ST };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = PlannerCore;
