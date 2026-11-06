/* Durable event outbox and reminders. Install only after external setup approval. */
function sendCurrentNotifications(){
  var lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  try{
    TABLES_={};if(!bool_(setting_('mail_enabled')))return;
    var db=loadDb_(),now=Date.now(),url=setting_('planner_url');
    db.shortTasks.forEach(function(t){
      if(t.done)return;
      var due=CurrentTasks.epoch(t.dueAt),jobs=(t.notices||[]).filter(function(n){return !n.sent&&!n.cancelled&&n.owner===t.owner&&n.dueAt===t.dueAt;});
      if(t.reminderDue!==t.dueAt&&now>=due-3600000&&now<due)jobs.push({type:'reminder',owner:t.owner});
      jobs.forEach(function(n){
        var u=db.users.filter(function(u){return u.id===n.owner&&u.active;})[0];
        var pref={assign:'shortAssign',reschedule:'shortReschedule',reminder:'shortReminder'}[n.type];
        if(!u||!u.email||(u.preferences||{})[pref]===false){finish();return;}
        if(MailApp.getRemainingDailyQuota()<1)return;
        var label={assign:'Вам назначена задача',reschedule:'Изменён срок задачи',reminder:'До срока задачи около часа'}[n.type];
        MailApp.sendEmail({to:u.email,subject:label+' · '+t.title,body:t.title+'\nСрок (Москва): '+t.dueAt.replace('T',' ')+'\nПриоритет: '+t.prio+'\nОткрыть: '+url+'#s='+encodeURIComponent(t.id)});
        finish();
        function finish(){if(n.type==='reminder')t.reminderDue=t.dueAt;else n.sent=true;upsert_(readTable_('CurrentTasks'),[{id:t.id,data_json:JSON.stringify(t)}],'id');}
      });
    });
  }finally{lock.releaseLock();}
}
