const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../shared/current');
let seq=0;
const env={ts:'2026-11-03 10:00',uid:()=>String(++seq)};
function db(){return {users:[{id:'h',role:'head'},{id:'m',role:'mod'},{id:'a',role:'owner'},{id:'b',role:'owner'},{id:'x',role:'owner'}],folders:[{code:'ORG',active:true}],shortTasks:[]};}
const p={title:'Договориться о встрече',folder:'ORG',owner:'b',prio:'P2',dueAt:'2026-11-03T13:00'};
function create(d){C.handle(d,'a','shortCreate',p,env);return d.shortTasks[0];}
test('автор и исполнитель видят задачу, посторонний не видит и не закрывает',()=>{const d=db(),t=create(d);assert.equal(C.snapshot(d,'a').length,1);assert.equal(C.snapshot(d,'b').length,1);assert.equal(C.snapshot(d,'x').length,0);for(const id of ['x','a'])assert.throws(()=>C.handle(d,id,'shortToggle',{id:t.id,version:1,done:true},env),e=>e.error==='forbidden');});
test('фактический исполнитель и история сохраняются после повторного открытия',()=>{const d=db(),t=create(d);C.handle(d,'m','shortToggle',{id:t.id,version:1,done:true},env);assert.equal(t.doneBy,'m');assert.equal(t.history[1].owner,'b');C.handle(d,'b','shortToggle',{id:t.id,version:2,done:false},env);assert.equal(t.doneBy,'');assert.equal(t.history[1].by,'m');C.handle(d,'b','shortToggle',{id:t.id,version:3,done:true},env);assert.equal(t.doneBy,'b');});
test('конфликт версий и запрет изменения назначенного срока исполнителем',()=>{const d=db(),t=create(d);assert.throws(()=>C.handle(d,'b','shortUpdate',{...p,id:t.id,version:1},env),e=>e.error==='forbidden');C.handle(d,'a','shortUpdate',{...p,id:t.id,version:1,dueAt:'2026-11-04T14:00'},env);assert.equal(t.notices[0].cancelled,true);assert.equal(t.notices[1].type,'reschedule');assert.throws(()=>C.handle(d,'h','shortToggle',{id:t.id,version:1,done:true},env),e=>e.error==='conflict');});
test('неизвестный исполнитель, архив и неверные даты отклоняются',()=>{for(const change of [{owner:'external@vtb.ru'},{dueAt:'2026-02-30T12:00'},{dueAt:'2026-11-03T25:00'},{title:''},{folder:'NONE'}])assert.throws(()=>C.handle(db(),'a','shortCreate',{...p,...change},env),e=>e.error==='bad_request');});
test('короткий срок не создаёт повторное напоминание; очередь не раскрывается клиенту',()=>{const d=db();C.handle(d,'a','shortCreate',{...p,dueAt:'2026-11-03T10:30'},env);assert.equal(d.shortTasks[0].reminderDue,'2026-11-03T10:30');assert.equal(C.snapshot(d,'a')[0].notices,undefined);});
test('optimistic edit работает с публичным снимком',()=>{const d=db();create(d);d.shortTasks=C.snapshot(d,'a');assert.doesNotThrow(()=>C.handle(d,'a','shortUpdate',{...p,id:d.shortTasks[0].id,version:1,dueAt:'2026-11-04T10:00'},env));});
const {fakeGas}=require('./gas_fake');
function gas(){const g=fakeGas();g.ctx.setup();g.ctx.upsert_(g.ctx.readTable_('Users'),[{id:'a',name:'Автор',role:'owner',active:'TRUE',email:'a@vtb.ru',key_hash:g.ctx.sha256Hex_('token'),session_expires:String(Date.now()+86400000)},{id:'b',name:'Исполнитель',role:'owner',active:'TRUE',email:'b@vtb.ru'}],'id');g.ctx.TABLES_={};return g;}
test('сервер: запись и чтение после нового запроса, конфликт, durable outbox и повторный запуск писем',()=>{const g=gas(),call=(action,params)=>g.post({key:'token',action,params});const r=call('shortCreate',{...p,folder:'ОРГ'});assert.equal(r.ok,true,JSON.stringify(r));const s=call('bootstrap',{});assert.equal(s.shortTasks.length,1);const t=s.shortTasks[0];assert.equal(g.rows('CurrentTasks').length,1);assert.equal(call('shortUpdate',{...p,folder:'ОРГ',id:t.id,version:99}).error,'conflict');g.ctx.sendCurrentNotifications();assert.equal(g.mails.length,1);g.ctx.sendCurrentNotifications();assert.equal(g.mails.length,1);assert.equal(g.mails[0].to,'b@vtb.ru');});
test('сервер: напоминание один раз, пользовательские настройки и закрытые задачи',()=>{
  const g=gas();let d=g.ctx.loadDb_();const dueAt=new Date(Date.now()+30*60000+10800000).toISOString().slice(0,16);
  const t={id:'reminder',title:'Проверка',owner:'b',createdBy:'a',dueAt,done:false,notices:[],reminderDue:'',version:1,history:[]};
  g.ctx.upsert_(g.ctx.readTable_('CurrentTasks'),[{id:t.id,data_json:JSON.stringify(t)}],'id');g.ctx.TABLES_={};
  g.ctx.sendCurrentNotifications();assert.equal(g.mails.length,1);g.ctx.sendCurrentNotifications();assert.equal(g.mails.length,1);
  t.id='disabled';t.reminderDue='';g.ctx.upsert_(g.ctx.readTable_('CurrentTasks'),[{id:t.id,data_json:JSON.stringify(t)}],'id');
  const u=g.ctx.readTable_('Users').rows.find(u=>u.id==='b');u.preferences_json=JSON.stringify({shortReminder:false});g.ctx.upsert_(g.ctx.readTable_('Users'),[u],'id');g.ctx.TABLES_={};g.ctx.sendCurrentNotifications();assert.equal(g.mails.length,1);
  t.id='done';t.done=true;g.ctx.upsert_(g.ctx.readTable_('CurrentTasks'),[{id:t.id,data_json:JSON.stringify(t)}],'id');g.ctx.TABLES_={};g.ctx.sendCurrentNotifications();assert.equal(g.mails.length,1);
});
