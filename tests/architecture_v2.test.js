// Регрессия согласованной архитектуры; проверяется вместе с architecture_full.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../shared/core.js');
function fixture() {
  const task = (id, parent, owner) => ({id,parent,owner,controller:'h',folder:'ПЛ',title:id,start:'2026-10-01',due:'2026-11-30',prio:'P3',tags:[],objects:[],version:1,checklist:[],flag:'',submitted:false,accepted:false});
  return {users:[{id:'h',role:'head',active:true},{id:'m',role:'mod',active:true},{id:'a',role:'owner',active:true},{id:'b',role:'owner',active:true},{id:'x',role:'owner',active:true}],tasks:[task('ПЛ-26-001',null,'h'),task('ПЛ-26-001.1','ПЛ-26-001','a'),task('ПЛ-26-001.2','ПЛ-26-001','b'),task('ПЛ-26-002',null,'x')],folders:[{code:'ПЛ',name:'Пилот',active:true,counters:{}}],activity:[]};
}
let seq=0;
const env = {today:'2026-10-31',ts:'2026-10-31 12:00',year:'26',uid:()=>String(++seq)};
test('участник видит цель с коллегами, но не чужую цель',()=>{
  const db=fixture(),s=Core.snapshot(db,'a',300);
  assert.deepEqual(s.tasks.map(t=>t.id),['ПЛ-26-001','ПЛ-26-001.1','ПЛ-26-001.2']);
  assert.equal(Core.canView(db,'x',db.tasks[0]),false);
});
test('руководитель и модератор самостоятельно принимают работу',()=>{
  const db=fixture(),t=db.tasks[1];t.submitted=true;
  for(const id of ['h','m'])assert.equal(Core.rights(db,id,env).accept(t),true);
  assert.equal(Core.rights(db,'a',env).accept(t),false);
});
test('участник создаёт подзадачи, но не переносит сроки и не отмечает чужую работу',()=>{
  const db=fixture(),r=Core.rights(db,'a',env);
  assert.equal(r.sub(db.tasks[0]),true);assert.equal(r.resched(db.tasks[1]),false);assert.equal(r.check(db.tasks[2]),false);
});
test('новая подзадача ограничена общим сроком',()=>{
  assert.throws(()=>Core.handle(fixture(),'a','addSubtask',{parent:'ПЛ-26-001',title:'Новая',owner:'a',start:'2026-11-01',due:'2026-12-01'},env),e=>e.error==='bad_request');
});
test('общий срок нельзя сократить за сроки подзадач',()=>{
  assert.throws(()=>Core.handle(fixture(),'h','reschedule',{id:'ПЛ-26-001',version:1,due:'2026-11-15',reason:'Новый план'},env),e=>e.error==='bad_request');
});
test('чужую задачу нельзя комментировать через прямой вызов',()=>{
  assert.throws(()=>Core.handle(fixture(),'x','addComment',{id:'ПЛ-26-001',text:'Нет доступа'},env),e=>e.error==='forbidden');
});
test('папку с задачами можно архивировать, но нельзя удалить',()=>{
  const db=fixture();assert.throws(()=>Core.handle(db,'m','deleteFolder',{code:'ПЛ'},env),e=>e.error==='bad_request');
  Core.handle(db,'h','saveFolder',{code:'ПЛ',name:'Пилот',active:false},env);assert.equal(db.folders[0].active,false);
});
test('настройки писем меняются только у самого пользователя',()=>{
  const db=fixture();Core.handle(db,'a','savePreferences',{assign:false,digest:true,userId:'b'},env);
  assert.equal(db.users.find(u=>u.id==='a').preferences.digest,true);assert.equal(db.users.find(u=>u.id==='b').preferences,undefined);
});
