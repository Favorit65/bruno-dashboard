const { test } = require('node:test');
const assert = require('node:assert/strict');
const DP = require('../dashboard-policy.js');
const obj = DP.enabledIds[0];
const options = { objects: new Set([obj]), roles: new Set(), scope: 'all' };
const row = (changes={}) => ({ objId:obj, role:'Клининг Д/С', teamId:'t', empId:'',
  planned:{ COMPLETED:3, MISSED:1, WAITING:10 }, unplanned:{}, ...changes });

test('current week uses Moscow Monday across Sunday/Monday and year boundaries', () => {
  assert.deepEqual(DP.weekPeriod(new Date('2026-10-31T12:00Z')), {from:'2026-10-26',to:'2026-10-31'});
  assert.deepEqual(DP.weekPeriod(new Date('2026-11-01T21:01Z')), {from:'2026-11-02',to:'2026-11-02'});
  assert.deepEqual(DP.weekPeriod(new Date('2027-01-01T03:00Z')), {from:'2026-12-28',to:'2027-01-01'});
});
test('only the five approved objects survive selection; empty means empty', () => {
  const available = DP.enabledIds.map(id => ({id})).concat({id:'disabled'});
  assert.equal(DP.enabledIds.length, 5);
  assert.deepEqual([...DP.sanitizeObjects(['disabled',obj],available)], [obj]);
  assert.equal(DP.summary([row()], {...options,objects:new Set()}).length, 0);
  assert.equal(DP.summary([row({objId:'disabled'})], options).length, 0);
});
test('efficiency excludes open tasks and never averages employee percentages', () => {
  const totals = DP.summary([row(),row({empId:'a',planned:{COMPLETED:0,MISSED:6}})],options)[0];
  assert.equal(totals.completed, 3); assert.equal(totals.missed, 7);
  assert.equal(totals.eff, .3); assert.equal(totals.open, 10);
  assert.equal(DP.summary([row({planned:{WAITING:4}})],options)[0].eff, null);
});
test('four-column details reconcile with cards, preserve team rows and respect scope/role', () => {
  const input = [row(), row({empId:'a',planned:{COMPLETED:2},unplanned:{MISSED:3}}),
    row({role:'Коменданты',empId:'b',planned:{COMPLETED:2}}),row({objId:'disabled'})];
  const details = DP.details(input, options), summaries = DP.summary(input,options);
  for (const field of ['completed','missed']) assert.equal(details.reduce((s,r)=>s+r[field],0),summaries.reduce((s,r)=>s+r[field],0));
  assert.equal(details.find(r=>r.empId==='').missed,1);
  assert.equal(DP.summary(input,{...options,scope:'unplanned',roles:new Set(['Клининг Д/С'])})[0].missed,3);
});
test('rejects core/cubes from different publications', () => {
  assert.throws(()=>DP.assertSameBuild({meta:{buildId:'one'}},{buildId:'two'}));
  assert.doesNotThrow(()=>DP.assertSameBuild({meta:{buildId:'one'}},{buildId:'one'}));
});
