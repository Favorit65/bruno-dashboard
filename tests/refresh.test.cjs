const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('../dashboard-policy.js');
const source = fs.readFileSync(require.resolve('../dashboard-refresh.js'),'utf8');
function fixture() {
  const label = { textContent:'',classList:{add(){},toggle(){}},insertAdjacentElement(){} };
  const c = { ACTIVITY_ROWS:[], ACTIVITY_VIEW_KEY:null, console:{warn(){}}, Date, Intl, Map, Set, Promise,
    DP:{...policy,weekPeriod:()=>({from:'2026-11-02',to:'2026-11-02'}),today:()=> '2026-11-02'},
    document:{getElementById:()=>label,createElement:()=>({addEventListener(){}}),addEventListener:(k,f)=>{c.events[k]=f;}},
    events:{}, intervals:[], setInterval:(fn,ms)=>c.intervals.push({fn,ms}),
    META:{buildId:'old',sourceUpdatedAt:'2026-10-31T00:00:00Z'}, OBJECTS:policy.enabledIds.map(id=>({id})),
    objById:{},ZONES:[],zoneById:{},HAS_FB:true,HAS_EMP_OBJ:true,HAS_EMP_TASK:true,
    WORK_BY_DATE:new Map(),EMPLOYEES:{},ROLE_OF:{},ROLES:[],
    ARCHIVE_FROM:'2026-01-01',ARCHIVE_TO:'2026-10-31',ALL_DATES:['2026-10-31'],V2:{},
    CUBES_READY:true,CUBES_PROMISE:Promise.resolve(),TEAMS:{},HAS_FUNCTION_STATS:true,
    MODEL_REVISION:'old',M2_CORE:'core',M2_CUBES:'cubes',OPEN_FUNCTION_DETAIL:null,
    _cacheKey:'old',_cachePeriod:[],_cacheDay:new Map(),_grpKey:'old',
    state:{periodMode:'absolute',period:{from:'2026-10-01',to:'2026-10-07'},objects:new Set([policy.enabledIds[0]]),roles:new Set(['Клининг Д/С']),scope:'planned',drill:{b2aObj:null}},
    setupObjectMenu(){},setupRoleMenu(){},syncControlsFromState(){},renderAll(){c.renders++;},renders:0,
    enabledObjects:()=>c.OBJECTS.filter(o=>policy.enabled(o.id)),modelPartUrl:(url,rev)=>url+'?v='+rev,
    readModelRevision:async()=> 'new',revisionCalls:[],mapCalls:0,
    loadPart:async(url,progress,revision)=>{c.revisionCalls.push(revision);return url==='core'?{f:2,meta:{buildId:'new',sourceUpdatedAt:'2026-10-31T00:00:00Z'}}:{buildId:'new',cubes:{}};},
    mapCoreV2(core){c.ACTIVITY_ROWS=[];c.mapCalls++;c.META=core.meta;c.OBJECTS=policy.enabledIds.map(id=>({id}));c.ALL_DATES=['2026-10-31'];c.ARCHIVE_FROM='2026-01-01';c.ARCHIVE_TO='2026-10-31';c.ROWS_BY_DATE.set('2026-10-31',[{count:7}]);},
    mapCubesV2(){},finishRoles(){},
  };
  for(const k of ['ROWS_BY_DATE','ROWS_ROLE_BY_DATE','ROWS_HOUR_BY_KEY','ZONE_ROWS_BY_DATE','ROWS_FB_BY_DATE','ROWS_FB_HOUR_BY_KEY','EMP_ROWS_BY_DATE','EMP_OBJ_BY_DATE','EMP_TASK_BY_DATE','FUNCTION_ROWS_BY_DATE'])c[k]=new Map();
  c.ROWS_BY_DATE.set('old',[{count:3}]);c.window=c;vm.createContext(c);vm.runInContext(source,c);return c;
}
test('installs an hourly timer and checks when a hidden tab becomes visible',()=>{
  const c=fixture();c.BrunoRefresh.start();assert.equal(c.intervals[0].ms,3600000);assert.equal(c.intervals.length,1);
  assert.equal(typeof c.events.visibilitychange,'function');c.BrunoRefresh.start();assert.equal(c.intervals.length,1);
});
test('new model replaces rows once and preserves explicit filters and dates',async()=>{
  const c=fixture(), period=JSON.stringify(c.state.period), selection=[...c.state.objects];
  assert.equal(await c.BrunoRefresh.refresh(true),true);
  assert.equal(c.ROWS_BY_DATE.size,1);assert.equal(c.META.buildId,'new');assert.equal(JSON.stringify(c.state.period),period);
  assert.deepEqual([...c.state.objects],selection);assert.equal(c.state.scope,'planned');assert.equal(c.state.roles.has('Клининг Д/С'),true);
  assert.deepEqual(c.revisionCalls,['new','new']);
  assert.equal(await c.BrunoRefresh.refresh(true),true);assert.equal(c.mapCalls,1);assert.equal(c.ROWS_BY_DATE.size,1);
});
test('failed download retains the working snapshot',async()=>{
  const c=fixture(), rows=c.ROWS_BY_DATE;c.loadPart=async()=>{throw new Error('offline');};
  assert.equal(await c.BrunoRefresh.refresh(true),false);assert.equal(c.ROWS_BY_DATE,rows);assert.equal(c.META.buildId,'old');
});
test('failed mapping restores all model references',async()=>{
  const c=fixture(), rows=c.ROWS_BY_DATE;c.mapCubesV2=()=>{throw new Error('bad cube');};
  assert.equal(await c.BrunoRefresh.refresh(true),false);assert.equal(c.ROWS_BY_DATE,rows);assert.equal(c.META.buildId,'old');assert.equal(c.ROWS_BY_DATE.has('old'),true);
});
test('week mode advances to the new Monday while explicit periods stay fixed',async()=>{
  const c=fixture();c.state.periodMode='week';await c.BrunoRefresh.refresh(true);
  assert.equal(c.state.period.from,'2026-11-02');assert.equal(c.state.period.to,'2026-11-02');
});
