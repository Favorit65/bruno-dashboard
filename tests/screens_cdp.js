// Скриншоты планировщика 1440 и 390 px и проверка консоли на ошибки — через
// Chrome DevTools Protocol, без Playwright (нужен только установленный Chrome/Edge).
// Запуск: в корне репо `python -m http.server 8000`, затем во втором окне
//   node tests/screens_cdp.js [папка для png]      (по умолчанию docs/planner_screens)
// Путь к браузеру можно задать переменной CHROME.
const {spawn}=require('child_process');const fs=require('fs');const path=require('path');const os=require('os');
const OUT=path.resolve(process.argv[2]||path.join(__dirname,'..','docs','planner_screens')), BASE='http://localhost:8000/';
const CHROME=process.env.CHROME||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>fs.existsSync(p));
fs.mkdirSync(OUT,{recursive:true});
const prof=fs.mkdtempSync(path.join(os.tmpdir(),'planner-cdp-'));
const ch=spawn(CHROME,['--headless=new','--remote-debugging-port=9333','--user-data-dir='+prof,'--no-first-run','--hide-scrollbars','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  let list;for(let i=0;i<50;i++){try{list=await (await fetch('http://127.0.0.1:9333/json/list')).json();if(list.find(t=>t.type==='page'))break}catch(e){}await sleep(200)}
  const ws=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise(r=>ws.onopen=r);
  let id=0;const wait={};const errors=[];let loaded=null;
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);
    if(m.id&&wait[m.id]){wait[m.id](m);delete wait[m.id]}
    if(m.method==='Runtime.exceptionThrown')errors.push('exception: '+JSON.stringify(m.params.exceptionDetails.exception&&m.params.exceptionDetails.exception.description||m.params.exceptionDetails.text));
    if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errors.push('console.error: '+m.params.args.map(a=>a.value||a.description).join(' '));
    if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')errors.push('log: '+m.params.entry.text+' '+(m.params.entry.url||''));
    if(m.method==='Page.loadEventFired'&&loaded){loaded();loaded=null}};
  const cmd=(method,params={})=>new Promise(r=>{const i=++id;wait[i]=r;ws.send(JSON.stringify({id:i,method,params}))});
  const evalJs=async src=>{const r=await cmd('Runtime.evaluate',{expression:src,awaitPromise:true,returnByValue:true});if(r.result&&r.result.exceptionDetails)throw new Error(JSON.stringify(r.result.exceptionDetails));return r.result&&r.result.result&&r.result.result.value};
  await cmd('Page.enable');await cmd('Runtime.enable');await cmd('Log.enable');
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
  const size=async(w,h)=>{await cmd('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:w<768?2:1,mobile:w<768})};
  const go=async(url,ms=1800)=>{const p=new Promise(r=>loaded=r);await cmd('Page.navigate',{url:BASE+url});await p;await sleep(ms)};
  const shot=async name=>{const r=await cmd('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,name),Buffer.from(r.result.data,'base64'));console.log('saved',name)};
  const asUser=async(user,view,extra='')=>{await evalJs(`localStorage.setItem('bruno-planner-ui-v1',JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('bruno-planner-ui-v1')||'{}'),{user:'${user}',view:'${view}',offset:0})));${extra}`);};

  await size(1440,900);
  await go('planner.html?demo=1');
  await evalJs(`localStorage.clear()`);
  await asUser('head','timeline');
  await go('planner.html?demo=1');
  await shot('1440_timeline.png');
  await evalJs(`document.querySelector('[data-open="ПДР-26-001.1"]').click()`);await sleep(300);
  await shot('1440_card_blocker.png');
  await evalJs(`document.querySelector('#cardRoot [data-act="close"]').click();document.querySelector('[data-view="summary"]').click()`);await sleep(300);
  await shot('1440_summary.png');
  await evalJs(`document.querySelector('[data-view="feed"]').click()`);await sleep(300);
  await shot('1440_feed.png');
  await evalJs(`document.querySelector('[data-view="timeline"]').click();document.querySelector('[data-act="new"]').click()`);await sleep(300);
  await shot('1440_new_task.png');
  await go('planner.html');
  await shot('1440_no_key.png');
  await go('dashboard_v2.html',6000);
  await shot('1440_dashboard.png');

  await size(390,844);
  await go('planner.html?demo=1');
  await asUser('kom','mine');
  await go('planner.html?demo=1');
  await shot('390_my_tasks.png');
  await evalJs(`document.querySelector('[data-open="ОБК-26-001.2"]').click()`);await sleep(300);
  await evalJs(`document.querySelector('#cardRoot input[data-chk]').click()`);await sleep(1200);
  await evalJs(`document.querySelector('#cardRoot .cl').scrollIntoView({block:'center'})`);await sleep(200);
  await shot('390_card_checked.png');
  await evalJs(`document.querySelector('#cardRoot [data-act="close"]').click();document.querySelector('[data-view="timeline"]').click()`);await sleep(300);
  await shot('390_timeline_weeks.png');
  await go('dashboard_v2.html',6000);
  await shot('390_dashboard.png');

  console.log(errors.length?'ОШИБКИ В КОНСОЛИ:\n'+errors.join('\n'):'Консоль без ошибок.');
  ws.close();ch.kill();
  setTimeout(()=>{try{fs.rmSync(prof,{recursive:true,force:true})}catch(e){}process.exit(errors.length?1:0)},800);
})().catch(e=>{console.error(e);ch.kill();process.exit(1)});
