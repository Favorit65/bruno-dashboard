/* Local browser showcase only. Never seeds Google or sends mail. */
var PlannerDemoCurrent=(function(){
  var titles=['Согласовать график обходов','Проверить освещение переговорной','Заказать пропуска подрядчику','Подтвердить доставку расходников','Отправить акт выполненных работ','Проверить уборку входной группы','Уточнить срок ремонта двери','Подготовить список сотрудников','Проверить запас питьевой воды','Согласовать замену табличек','Передать заявку инженеру','Проверить готовность переговорной','Обновить контакты дежурных','Получить документы подрядчика','Проверить маркировку помещений','Запланировать контрольный обход','Проверить кондиционер','Согласовать заявку на закупку','Подготовить ежедневную сводку','Закрыть замечания по этажу'];
  function seed(db,today){
    if(db.currentShowcaseVersion===1)return db;
    db.shortTasks=db.shortTasks||[];
    var users=db.users.filter(function(u){return u.active!==false&&u.role!=='observer';}),folders=db.folders.filter(function(f){return f.active!==false;});
    if(!users.length||!folders.length)return db;
    titles.forEach(function(title,i){
      var id='DEMO-CURRENT-'+String(i+1).padStart(2,'0');if(db.shortTasks.some(function(t){return t.id===id;}))return;
      var date=new Date(today+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+[-2,-1,0,0,0,1,1,1,2,2,3,4,5,6,7,8,10,12,15,20][i]);
      var day=date.toISOString().slice(0,10),due=day+'T'+String(9+i%9).padStart(2,'0')+':'+(i%2?'30':'00'),owner=users[i%users.length].id;
      db.shortTasks.push({id:id,title:title+' · демо',folder:folders[i%folders.length].code,prio:['P1','P2','P3'][i%3],owner:owner,dueAt:due,createdBy:users[0].id,createdAt:today+' 09:00',updatedAt:today+' 09:00',version:1,done:false,doneBy:'',doneAt:'',history:[{type:'create',by:users[0].id,at:today+' 09:00',owner:owner}],notices:[],reminderDue:due});
    });
    db.currentShowcaseVersion=1;return db;
  }
  return {seed:seed};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=PlannerDemoCurrent;
