const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const DP = require('../dashboard-policy.js');
const html = fs.readFileSync(require.resolve('../dashboard_v2.html'),'utf8');
const source = html.slice(html.indexOf('function workAgg() {'),html.indexOf('function renderB1Work() {'));
test('function productivity uses the same efficiency and selected categories as cards',()=>{
  const objId=DP.enabledIds[0], date='2026-10-30';
  const rows=[{objId,role:'Клининг Д/С',empId:'a',planned:{COMPLETED:3,MISSED:1,WAITING:8},unplanned:{COMPLETED:1,MISSED:9}}];
  const c={DP,Map,Set,Date,state:{objects:new Set([objId]),roles:new Set(),scope:'planned'},
    periodDates:()=>[date],roleFilterAllSel:()=>true,HAS_FUNCTION_STATS:true,
    ROWS_ROLE_BY_DATE:new Map([[date,rows]]),FUNCTION_ROWS_BY_DATE:new Map([[date,rows]]),
    META:{},ARCHIVE_TO:date,emptyBucket:()=>({COMPLETED:0,MISSED:0,NEW:0,WAITING:0,COMPLETING:0}),
    addBucket:(a,b)=>{for(const k of Object.keys(a))a[k]+=b[k]||0;},
    bucketAll:b=>b.COMPLETED+b.MISSED+b.NEW+b.WAITING+b.COMPLETING};
  vm.createContext(c);vm.runInContext(source,c);
  const work=c.workAgg()[0], card=DP.summary(rows,c.state)[0];
  assert.equal(work.eff,card.eff);assert.equal(work.eff,.75);assert.equal(work.workers,1);
  assert.equal(work.assignedPerDay,12);assert.equal(work.donePerDay,3);
});
