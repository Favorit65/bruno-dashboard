const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const DP=require('../dashboard-policy.js');
const code=fs.readFileSync(require.resolve('../dashboard-activity.js'),'utf8');
const html=fs.readFileSync(require.resolve('../dashboard_v2.html'),'utf8');
test('all inline and external scripts parse',()=>{
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
  new vm.Script(code);
});
test('daily and prolonged denominators exclude NEW and COMPLETING, null for zero',()=>{
  assert.equal(DP.efficiency(3,1,8,'daily'),.75);
  assert.equal(DP.efficiency(3,1,8,'prolonged'),.25);
  assert.equal(DP.efficiency(0,0,8,'daily'),null);
  assert.equal(DP.efficiency(0,0,8,'prolonged'),0);
  const row={objId:DP.enabledIds[0],role:'r',planned:{COMPLETED:3,MISSED:1,WAITING:8,NEW:50,COMPLETING:70}};
  assert.equal(DP.summary([row],{objects:new Set(DP.enabledIds),duration:'prolonged'})[0].eff,.25);
});
test('daily tables preserve per-day values and restore state after failure',()=>{
  const state={period:{from:'2026-10-26',to:'2026-10-27'},time:{gran:'month',hour:null},duration:'daily'};
  const period=state.period,time=state.time;
  const c={state,DP,cacheSync(){},periodDates:()=>['2026-10-26','2026-10-27']};
  vm.createContext(c);vm.runInContext(code,c);
  const result=c.dailyTableData({build:()=>({cols:[{h:'Выполнено',t:'int'}],rows:[[state.period.from.endsWith('26')?3:7]]})});
  assert.equal(JSON.stringify(result.rows),JSON.stringify([['2026-10-26',3],['2026-10-27',7]]));
  assert.equal(state.period,period);assert.equal(state.time,time);
  assert.throws(()=>c.dailyTableData({build(){throw Error('test');}}));
  assert.equal(state.period,period);assert.equal(state.time,time);
});
test('one activity source reconciles functions, objects, hours, zones and duration toggles',()=>{
  const empty=()=>({NEW:0,WAITING:0,COMPLETING:0,COMPLETED:0,MISSED:0,completedOnTime:0,completedLate:0,delayHoursSum:0,delayHoursN:0});
  const c={DP,Map,Set,state:{duration:'daily',roles:new Set(),objects:new Set(DP.enabledIds),scope:'planned'},
    emptyBucket:empty,addBucket:(a,b)=>{for(const k of Object.keys(a))a[k]+=b[k]||0;return a;},bucketAll:b=>b.NEW+b.WAITING+b.COMPLETING+b.COMPLETED+b.MISSED,
    _cacheKey:null,_cachePeriod:null,_cacheDay:new Map(),_grpKey:null};
  for(const key of ['ROWS_BY_DATE','ROWS_ROLE_BY_DATE','FUNCTION_ROWS_BY_DATE','ROWS_HOUR_BY_KEY','ZONE_ROWS_BY_DATE','ROWS_FB_BY_DATE','ROWS_FB_HOUR_BY_KEY'])c[key]=new Map();
  vm.createContext(c);vm.runInContext(code,c);
  c.input=[{date:'2026-10-26',hour:'11',objId:DP.enabledIds[0],role:'r',teamId:'t',empId:'e',zoneId:'z',feedbackId:'f',duration:'daily',planned:{...empty(),COMPLETED:3},unplanned:empty()},
    {date:'2026-10-27',hour:'12',objId:DP.enabledIds[0],role:'r',teamId:'t',empId:'',zoneId:'z',feedbackId:'',duration:'prolonged',planned:{...empty(),WAITING:5},unplanned:empty()}];
  vm.runInContext('ACTIVITY_ROWS=input;',c);c.applyActivityView();
  assert.equal(c.ROWS_BY_DATE.get('2026-10-26')[0].planned.COMPLETED,3);
  assert.equal(c.FUNCTION_ROWS_BY_DATE.get('2026-10-26')[0].planned.COMPLETED,3);
  assert.equal(c.ROWS_HOUR_BY_KEY.get('2026-10-26|11')[0].planned.COMPLETED,3);
  assert.equal(c.ROWS_FB_BY_DATE.get('2026-10-26')[0].fb,1);
  c.state.duration='prolonged';c.applyActivityView();
  assert.equal(c.ROWS_BY_DATE.has('2026-10-26'),false);
  assert.equal(c.ROWS_BY_DATE.get('2026-10-27')[0].planned.WAITING,5);
  c.state.duration='daily';c.applyActivityView();
  assert.equal(c.ROWS_BY_DATE.get('2026-10-26')[0].planned.COMPLETED,3);
  const saved=c.ROWS_BY_DATE; c.state.noRoles=true; c.applyActivityView();assert.equal(c.ROWS_BY_DATE.size,0); c.state.noRoles=false;c.applyActivityView();assert.equal(c.ROWS_BY_DATE,saved);
  c.state.roles=new Set(['missing']);c.applyActivityView();assert.equal(c.ROWS_BY_DATE.size,0);
});

 test('register completion includes tasks outside selected role and duration',()=>{
  const c={state:{duration:'daily',roles:new Set(['r']),objects:new Set([DP.enabledIds[0]])},DP,
    META:{feedbackRegister:[{registered:'2026-10-26T09:00:00+03:00',object:DP.enabledIds[0],floor:'2',zone:'z',text:'text',
      tasks:[{window:'daily',role:'r',done:true,executor:'e'},{window:'prolonged',role:'other',done:false}]}]},
    EMPLOYEES:{e:{name:'Person'}},objById:{[DP.enabledIds[0]]:{name:'Object'}},inPeriod:()=>true,
    emptyBucket:()=>({}), FB_ST:[]};
  c.roleFilterAllSel = () => !c.state.noRoles && [0,2].includes(c.state.roles.size);
  vm.createContext(c);vm.runInContext(code,c);
  assert.equal(c.requestTable().rows[0][4],'1/2');
  assert.equal(c.requestTable().rows[0][5],'Person');
  assert.equal(c.requestCompletion([]),'—');
  assert.equal(c.requestCompletion([{done:true},{done:true}]),'Да');
  assert.equal(c.requestCompletion([{done:false},{done:false},{done:false}]),'0/3');
  c.META.feedbackRegister.push({...c.META.feedbackRegister[0], tasks:[]});
  assert.equal(c.requestTable().rows.length,1);
  c.state.roles.clear();
  assert.equal(c.requestTable().rows[1][4],'—');
  assert.equal(c.requestCounts(c.META.feedbackRegister).days[0].fb,2);
  c.state.roles = new Set(['r','other']);
  assert.equal(c.requestTable().rows[1][4],'—');
  c.state.noRoles = true;
  assert.equal(c.requestTable().rows.length,0);
 });
