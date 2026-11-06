/* Shared activity cube for every task view. Kept separate from legacy report cubes. */
let ACTIVITY_ROWS = null, ACTIVITY_VIEW_KEY = null;
let ACTIVITY_EMPTY_RESTORE = null;
function activityMaps() {
  return {ROWS_BY_DATE, ROWS_ROLE_BY_DATE, FUNCTION_ROWS_BY_DATE, ROWS_HOUR_BY_KEY,
    ZONE_ROWS_BY_DATE, ROWS_FB_BY_DATE, ROWS_FB_HOUR_BY_KEY};
}
function installActivityMaps(maps) {
  ({ROWS_BY_DATE, ROWS_ROLE_BY_DATE, FUNCTION_ROWS_BY_DATE, ROWS_HOUR_BY_KEY,
    ZONE_ROWS_BY_DATE, ROWS_FB_BY_DATE, ROWS_FB_HOUR_BY_KEY} = maps);
  _cacheKey=null; _cachePeriod=null; _cacheDay=new Map(); _grpKey=null;
}
const ACTIVITY_STATUSES = [
  {key:'completed', status:'COMPLETED', label:'Выполнено', color:'#002882'},
  {key:'missed', status:'MISSED', label:'Пропущено', color:'#E62632'},
  {key:'waiting', status:'WAITING', label:'Ожидает выполнения', color:'#B07800'},
  {key:'completing', status:'COMPLETING', label:'Выполняется', color:'#008ABD'},
  {key:'new', status:'NEW', label:'Новое', color:'#8670B0'},
];
function activityEfficiency(completed, missed, waiting = 0) {
  return DP.efficiency(completed, missed, waiting, state.duration);
}
function activityFormula() {
  return state.duration === 'prolonged'
    ? 'выполнено / (выполнено + пропущено + ожидает выполнения)'
    : 'выполнено / (выполнено + пропущено)';
}
function activityLabel() { return state.duration === 'prolonged' ? 'Пролонгированные · >24 ч' : 'Ежедневные · ≤24 ч'; }
function decodeActivity(packed) {
  if (!packed) return;
  if (packed.stride !== 27 || packed.rows.length % 27) throw new Error('Неверный формат данных по датам выполнения');
  ACTIVITY_ROWS = []; ACTIVITY_VIEW_KEY = null; ACTIVITY_EMPTY_RESTORE = null;
  const a = packed.rows;
  for (let i=0; i<a.length; i+=27) ACTIVITY_ROWS.push({date:V2.days[a[i]], hour:String(a[i+1]).padStart(2,'0'),
    objId:V2.objIds[a[i+2]], role:V2.roles[a[i+3]], teamId:V2.teamIds[a[i+4]], empId:V2.empIds[a[i+5]],
    zoneId:V2.zoneIds[a[i+6]], duration:V2.windowKinds[a[i+7]], feedbackId:V2.feedbackIds[a[i+8]],
    planned:bucketAt(a,i+9,true), unplanned:bucketAt(a,i+18,true)});
}
function legacyActivity(cube) {
  if (!cube) return;
  ACTIVITY_VIEW_KEY = null; ACTIVITY_EMPTY_RESTORE = null;
  ACTIVITY_ROWS = Object.entries(cube).map(([key,value]) => {
    const [date,hour,objId,role,teamId,empId,zoneId,duration,feedbackId] = key.split('|');
    return {date,hour,objId,role,teamId,empId,zoneId,duration,feedbackId,...value};
  });
}
function applyActivityView() {
  if (!ACTIVITY_ROWS) return;
  const key = state.duration + '|' + Boolean(state.noRoles) + '|' + [...state.roles].sort().join(',');
  if (key === ACTIVITY_VIEW_KEY) return;
  // Keep the current aggregates while the selection is empty; reset restores
  // them without another scan. Decoding a new model invalidates this snapshot.
  if (state.noRoles) {
    if (ACTIVITY_VIEW_KEY && !ACTIVITY_EMPTY_RESTORE) ACTIVITY_EMPTY_RESTORE = {key:ACTIVITY_VIEW_KEY, maps:activityMaps()};
    ACTIVITY_VIEW_KEY = key;
    installActivityMaps(Object.fromEntries(Object.keys(activityMaps()).map(k=>[k,new Map()])));
    HAS_FB=true; HAS_FUNCTION_STATS=true;
    return;
  }
  if (ACTIVITY_EMPTY_RESTORE?.key === key) {
    installActivityMaps(ACTIVITY_EMPTY_RESTORE.maps);
    ACTIVITY_EMPTY_RESTORE=null; ACTIVITY_VIEW_KEY=key;
    return;
  }
  ACTIVITY_EMPTY_RESTORE=null;
  ACTIVITY_VIEW_KEY = key;
  const selected = state.noRoles ? [] : ACTIVITY_ROWS.filter(r => DP.enabled(r.objId) && r.duration === state.duration && (!state.roles.size || state.roles.has(r.role)));
  function group(fields, rows=selected) {
    const m = new Map();
    for (const r of rows) {
      const k = fields.map(f => r[f]).join('|');
      let v=m.get(k);
      if (!v) { v={planned:emptyBucket(),unplanned:emptyBucket()}; fields.forEach(f=>v[f]=r[f]); m.set(k,v); }
      addBucket(v.planned,r.planned); addBucket(v.unplanned,r.unplanned);
    }
    return [...m.values()];
  }
  function byDate(rows, hour=false) {
    const m=new Map();
    for(const r of rows) { const k=r.date+(hour?'|'+r.hour:''); if(!m.has(k))m.set(k,[]); m.get(k).push(r); }
    return m;
  }
  ROWS_BY_DATE=byDate(group(['date','objId']));
  ROWS_ROLE_BY_DATE=byDate(group(['date','objId','role']));
  FUNCTION_ROWS_BY_DATE=byDate(group(['date','objId','role','teamId','empId']));
  ROWS_HOUR_BY_KEY=byDate(group(['date','hour','objId']),true);
  ZONE_ROWS_BY_DATE=byDate(group(['date','objId','zoneId']).map(r=>({...r,objectID:r.objId})));
  const fbRows=selected.filter(r=>r.feedbackId);
  function feedback(hour=false) {
    const fields=hour?['date','hour','objId']:['date','objId'];
    const counts=new Map();
    for(const r of fbRows) {const k=fields.map(f=>r[f]).join('|'); if(!counts.has(k))counts.set(k,new Set());counts.get(k).add(r.feedbackId);}
    return byDate(group(fields,fbRows).map(r=>{
      const b=addBucket({...r.planned},r.unplanned);
      return {...r,...b,fb:counts.get(fields.map(f=>r[f]).join('|')).size,tasks:bucketAll(b)};
    }),hour);
  }
  ROWS_FB_BY_DATE=feedback(); ROWS_FB_HOUR_BY_KEY=feedback(true);
  if (typeof META !== 'undefined' && Array.isArray(META.feedbackRegister)) {
    const counts = requestCounts(META.feedbackRegister);
    ROWS_FB_BY_DATE = byDate(counts.days);
    ROWS_FB_HOUR_BY_KEY = byDate(counts.hours, true);
  }
  HAS_FB=true; HAS_FUNCTION_STATS=true;
  _cacheKey=null; _cachePeriod=null; _cacheDay=new Map(); _grpKey=null;
}
function activityControls() {
  const host=document.getElementById('activity-controls');
  host.querySelectorAll('[data-duration]').forEach(b=>{
    b.classList.toggle('active',b.dataset.duration===state.duration);
    b.setAttribute('aria-pressed',String(b.dataset.duration===state.duration));
    b.onclick=()=>{state.duration=b.dataset.duration;renderAll();};
  });
  const qa=META.activityQA||{};
  const missing=(qa.missingActualCompletionDate||0)+(qa.missingExecutor||0);
  document.getElementById('activity-note').textContent = 'Выполнено — по фактической дате, остальные статусы — по дате задания (МСК). Эффективность: '+activityFormula()+'.'
    +(qa.unknown?' Без определённого срока: '+fmt(qa.unknown)+' задач в архиве, вне обоих режимов.':'')
    +(missing?' Без подтверждённого выполнения: '+fmt(missing)+' задач в архиве, исключены.':'');
  const legend=document.getElementById('activity-statuses');
  legend.innerHTML=ACTIVITY_STATUSES.map(s=>`<label><input type="checkbox" data-status="${s.key}" ${state.statuses.has(s.key)?'checked':''}><span class="sw" style="background:${s.color}"></span>${s.label}</label>`).join('');
  legend.querySelectorAll('input').forEach(el=>el.onchange=()=>{
    if(el.checked)state.statuses.add(el.dataset.status);else state.statuses.delete(el.dataset.status);
    renderAll();
  });
}
function statusBucket(b, extra={}) {
  return {...extra, completed:b.COMPLETED,missed:b.MISSED,waiting:b.WAITING,completing:b.COMPLETING,new:b.NEW,
    other:b.WAITING+b.COMPLETING+b.NEW,all:bucketAll(b),eff:activityEfficiency(b.COMPLETED,b.MISSED,b.WAITING)};
}
function dailyTableData(def, variant) {
  // Existing builders share the page's filter functions. Isolate each day and
  // restore state/caches even if a builder fails; never leave a changed filter.
  if (def.register && FB_MODE_FB()) return requestTable();
  const dates=periodDates().slice(), period=state.period, time=state.time;
  let result=null;
  try {
    for(const date of dates) {
      state.period={from:date,to:date};state.time={...time,hour:null,gran:'day'};cacheSync();
      const part=def.build(variant);
      if(!result) result={...part,cols:[{h:'Дата',t:'txt'},...part.cols],rows:[]};
      result.rows.push(...part.rows.map(r=>[date,...r]));
    }
    if(!result) {const part=def.build(variant);result={...part,cols:[{h:'Дата',t:'txt'},...part.cols],rows:[]};}
    result.note='Детализация по дням. '+activityLabel()+'. '+(result.note||'');
    return result;
  } finally {state.period=period;state.time=time;cacheSync();}
}
function taskEmployeeList(dates=periodDates()) {
  const m=new Map();
  for(const r of functionRows(dates)) {
    if(!r.empId||!DP.selected(r.objId,state.objects)|| (state.roles.size&&!state.roles.has(r.role)))continue;
    const b=DP.totals(r,state.scope), key=r.empId+'|'+r.role;
    if(!m.has(key))m.set(key,{empId:r.empId,role:r.role,name:(EMPLOYEES[r.empId]||{}).name||r.empId,completed:0,missed:0,waiting:0,assigned:0});
    const v=m.get(key);v.completed+=b.COMPLETED;v.missed+=b.MISSED;v.waiting+=b.WAITING;v.assigned+=Object.values(b).reduce((a,n)=>a+n,0);
  }
  return [...m.values()].map(r=>({...r,eff:activityEfficiency(r.completed,r.missed,r.waiting)})).filter(r=>r.assigned>0).sort((a,b)=>(b.eff??-1)-(a.eff??-1));
}
function showDailyModal(title,data,slug) {
  const html='<table class="detail-table"><thead><tr>'+data.cols.map(c=>'<th>'+esc(c.h)+'</th>').join('')+'</tr></thead><tbody>'
    +data.rows.map(r=>'<tr>'+data.cols.map((c,i)=>'<td>'+cellHtml(r[i],c.t)+'</td>').join('')+'</tr>').join('')+'</tbody></table><p class="note">'+esc(data.note||'')+'</p>';
  showModal(esc(title),data.rows.length?html:'<p class="note">Нет данных в выбранном срезе.</p>',{slug,cols:data.cols,rows:data.rows});
}
function activityZones(objectID,dates=periodDates()) {
  if(!DP.selected(objectID,state.objects))return [];
  const map=new Map();
  for(const date of dates)for(const r of ZONE_ROWS_BY_DATE.get(date)||[]) {
    if(r.objId!==objectID)continue;
    if(!map.has(r.zoneId))map.set(r.zoneId,emptyBucket());
    addBucket(map.get(r.zoneId),combinedDay(r));
  }
  return [...map].map(([id,b])=>({id,name:(zoneById[id]||{}).name||'Зона не указана',count:bucketAll(b),completed:b.COMPLETED,
    missed:b.MISSED,waiting:b.WAITING,eff:activityEfficiency(b.COMPLETED,b.MISSED,b.WAITING)})).filter(r=>r.count>0).sort((a,b)=>b.count-a.count);
}

function requestTasks(request) {
  if (state.noRoles) return [];
  return request.tasks.filter(task => task.window === state.duration &&
    (!state.roles.size || state.roles.has(task.role)));
}

function requestMatches(request, tasks) {
  return tasks.length > 0 || (!request.tasks.length && roleFilterAllSel());
}

function requestCounts(requests) {
  const days = new Map(), hours = new Map();
  function count(map, key, date, hour, objId, tasks) {
    if (!map.has(key)) map.set(key, {date, hour, objId, fb:0, tasks:0, ...emptyBucket()});
    const bucket = map.get(key);
    bucket.fb++;
    bucket.tasks += tasks.length;
    for (const task of tasks) if (FB_ST.includes(task.status)) bucket[task.status]++;
  }
  for (const request of requests) {
    const tasks = requestTasks(request);
    if (!request.registered || !requestMatches(request, tasks)) continue;
    const day = request.registered.slice(0, 10), hour = request.registered.slice(11, 13);
    count(days, day+'|'+request.object, day, hour, request.object, tasks);
    count(hours, day+'|'+hour+'|'+request.object, day, hour, request.object, tasks);
  }
  return {days:[...days.values()], hours:[...hours.values()]};
}

function requestCompletion(tasks) {
  if (!tasks.length) return '—';
  const done = tasks.filter(t => t.done).length;
  return done === tasks.length ? 'Да' : done + '/' + tasks.length;
}

function requestTable() {
  const cols = ['Дата и время', 'Объект', 'Этаж', 'Зона', 'Выполнено', 'Исполнитель', 'Обращение'].map(h => ({h,t:'txt'}));
  const result = {cols, rows:[], head:[['Категория задач','обращения'],['Детализация','по обращениям'],['Дата учёта','Регистрация обращения, МСК']], note:'Дата регистрации по Москве. Одна строка на обращение. «Да» — все связанные задания выполнены; иначе выполнено/всего создано. Указаны фактические исполнители выполненных заданий.'};
  if (!Array.isArray(META.feedbackRegister)) {
    result.note = 'Реестр будет доступен после обновления модели.';
    return result;
  }
  for (const r of META.feedbackRegister) {
    if (!r.registered || !inPeriod(r.registered.slice(0,10)) || !DP.selected(r.object,state.objects) || !requestMatches(r, requestTasks(r))) continue;
    const people = [...new Set(r.tasks.filter(t=>t.done).map(t=>EMPLOYEES[t.executor]?.name || t.executor))];
    result.rows.push([r.registered.slice(0,19).replace('T',' '), objById[r.object]?.name || r.object,
      r.floor, r.zone, requestCompletion(r.tasks), people.join(', '), r.text]);
  }
  result.rows.sort((a,b)=>b[0].localeCompare(a[0]));
  return result;
}
