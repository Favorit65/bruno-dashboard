const test=require('node:test'),assert=require('node:assert/strict'),C=require('../shared/calendar');
test('неделя начинается в понедельник и переходит границу года',()=>{assert.deepEqual(C.days('2027-01-01','week'),['2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03']);});
test('месяц содержит все дни февраля високосного года и соседние дни',()=>{const ds=C.days('2028-02-29','month');assert.equal(ds.length,42);assert.equal(ds[0],'2028-01-31');assert.ok(ds.includes('2028-02-29'));assert.equal(C.shift('2028-01-31','month',1),'2028-02-01');assert.equal(C.shift('2026-12-31','month',1),'2027-01-01');});
test('задачи распределяются по дате МСК и времени, одинаковый срок — по приоритету',()=>{const rows=[{id:'1',dueAt:'2026-11-05T00:01',prio:'P2'},{id:'2',dueAt:'2026-11-05T00:01',prio:'P1'},{id:'3',dueAt:'2026-11-04T23:59',prio:'P1'},{id:'4',dueAt:'2026-11-05T10:00',prio:'P3',done:true}];const dates=C.days('2026-11-05','week'),b=C.buckets(rows,dates,false);assert.deepEqual(b['2026-11-05'].map(t=>t.id),['2','1']);assert.equal(b['2026-11-04'][0].id,'3');assert.equal(C.buckets(rows,dates,true)['2026-11-05'].length,3);});
test('группы сроков не пересекаются, завтра на выходных остаётся завтра',()=>{
  const dates=['2026-11-05','2026-11-06','2026-11-07','2026-11-08','2026-11-09','2026-11-16','2026-12-01'];
  const groups=C.agenda(dates.map(d=>({dueAt:d+'T09:00'})),'2026-11-06');
  assert.deepEqual(groups.map(g=>g.label),['Просрочено','Сегодня','Завтра','Выходные','Следующая неделя','Остаток месяца','Позже']);
  assert.deepEqual(groups.flatMap(g=>g.tasks.map(t=>t.dueAt.slice(0,10))),dates);
});
