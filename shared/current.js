/* Current tasks: shared browser / Apps Script domain rules. Times are Moscow. */
var CurrentTasks = (function () {
  'use strict';
  function fail(error,message){throw {error:error,message:message};}
  function manager(u){return u && (u.role==='head'||u.role==='mod');}
  function visible(t,u){return !!u && u.active!==false && (manager(u)||t.owner===u.id||t.createdBy===u.id);}
  function editable(t,u){return manager(u)||t.createdBy===u.id;}
  function closable(t,u){return manager(u)||t.owner===u.id;}
  function epoch(s){return Date.parse(s.replace(' ','T')+(s.length===16?':00':'')+'+03:00');}
  function validate(db,p){
    if(!String(p.title||'').trim()||String(p.title).trim().length>300)fail('bad_request','Название: от 1 до 300 символов.');
    if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(p.dueAt||'')||!Number.isFinite(epoch(p.dueAt))||new Date(epoch(p.dueAt)+10800000).toISOString().slice(0,16)!==p.dueAt)fail('bad_request','Укажите корректные дату и время по Москве.');
    if(!db.folders.some(function(f){return f.code===p.folder&&f.active!==false;}))fail('bad_request','Выберите активную папку.');
    if(!db.users.some(function(u){return u.id===p.owner&&u.active!==false&&u.role!=='observer';}))fail('bad_request','Выберите исполнителя из пользователей.');
    if(['P1','P2','P3'].indexOf(p.prio)<0)fail('bad_request','Выберите приоритет.');
  }
  function notice(t,type,env){
    t.notices.push({id:env.uid(),type:type,owner:t.owner,dueAt:t.dueAt,sent:false});
    t.reminderDue=epoch(t.dueAt)-epoch(env.ts)<=3600000?t.dueAt:'';
  }
  function handle(db,uid,action,p,env){
    var u=db.users.find(function(x){return x.id===uid;});
    if(!u||u.active===false)fail('auth','Войдите заново.');
    if(u.role==='observer')fail('forbidden','Доступен только просмотр.');
    db.shortTasks=db.shortTasks||[];
    var t;
    if(action==='shortCreate'){
      validate(db,p);
      t={id:'S-'+env.uid(),title:p.title.trim(),folder:p.folder,prio:p.prio,owner:p.owner,dueAt:p.dueAt,createdBy:uid,createdAt:env.ts,updatedAt:env.ts,version:1,done:false,doneBy:'',doneAt:'',history:[],notices:[],reminderDue:''};
      db.shortTasks.push(t);notice(t,'assign',env);
    }else{
      t=db.shortTasks.find(function(x){return x.id===p.id;});
      if(!t)fail('not_found','Задача не найдена.');
      if(!visible(t,u))fail('forbidden','Нет доступа к задаче.');
      if(+p.version!==t.version)fail('conflict','Задачу изменили. Обновите данные.');
      t.notices=t.notices||[];
      if(action==='shortUpdate'){
        if(!editable(t,u))fail('forbidden','Менять задачу может автор, руководитель или модератор.');
        if(t.done)fail('bad_request','Сначала верните задачу в работу.');
        validate(db,p);
        var reassigned=t.owner!==p.owner,changedDue=t.dueAt!==p.dueAt;
        t.history.push({type:'edit',by:uid,at:env.ts,before:{title:t.title,owner:t.owner,dueAt:t.dueAt,folder:t.folder,prio:t.prio}});
        ['title','folder','prio','owner','dueAt'].forEach(function(k){t[k]=k==='title'?p[k].trim():p[k];});
        if(reassigned||changedDue){t.notices.forEach(function(n){if(!n.sent)n.cancelled=true;});notice(t,reassigned?'assign':'reschedule',env);}
      }else if(action==='shortToggle'){
        if(!closable(t,u))fail('forbidden','Закрывает исполнитель, руководитель или модератор.');
        if(typeof p.done!=='boolean')fail('bad_request','Передайте состояние выполнения.');
        if(t.done===p.done)fail('conflict','Состояние уже изменилось. Обновите данные.');
        t.done=p.done;t.doneBy=t.done?uid:'';t.doneAt=t.done?env.ts:'';
        t.history.push({type:t.done?'done':'reopen',by:uid,at:env.ts,owner:t.owner});
      }else fail('bad_request','Неизвестное действие.');
      t.version++;t.updatedAt=env.ts;
    }
    if(action==='shortCreate')t.history.push({type:'create',by:uid,at:env.ts,owner:t.owner});
    if(JSON.stringify(t).length>45000)fail('bad_request','История задачи превысила лимит хранения. Создайте новую задачу.');
    return {patch:{tasks:[],activity:[],users:[],folders:[],shortTasks:[publicTask(t)]},notify:[],result:{id:t.id}};
  }
  function publicTask(t){var o=JSON.parse(JSON.stringify(t));delete o.notices;delete o.reminderDue;return o;}
  function snapshot(db,uid){var u=db.users.find(function(x){return x.id===uid;});return (db.shortTasks||[]).filter(function(t){return visible(t,u);}).map(publicTask);}
  return {handle:handle,snapshot:snapshot,visible:visible,editable:editable,closable:closable,epoch:epoch};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=CurrentTasks;
