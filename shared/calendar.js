/* Date-only calendar arithmetic, independent of browser timezone and DST. */
var PlannerCalendar=(function(){
  function parse(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(s))throw Error('Invalid date');var d=new Date(s+'T00:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==s)throw Error('Invalid date');return d;}
  function iso(d){return d.toISOString().slice(0,10);}
  function add(s,n){var d=parse(s);d.setUTCDate(d.getUTCDate()+n);return iso(d);}
  function monday(s){var d=parse(s);return add(s,-((d.getUTCDay()+6)%7));}
  function days(anchor,mode){var start=mode==='month'?monday(anchor.slice(0,7)+'-01'):monday(anchor);return Array.from({length:mode==='month'?42:7},function(_,i){return add(start,i);});}
  function shift(anchor,mode,n){if(mode==='week')return add(anchor,7*n);var d=parse(anchor);d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+n);return iso(d);}
  function buckets(tasks,dates,done){var out={};dates.forEach(function(d){out[d]=[];});tasks.filter(function(t){return done||!t.done;}).forEach(function(t){var d=t.dueAt.slice(0,10);if(out[d])out[d].push(t);});Object.keys(out).forEach(function(d){out[d].sort(function(a,b){return a.dueAt.localeCompare(b.dueAt)||a.prio.localeCompare(b.prio)||a.id.localeCompare(b.id);});});return out;}
  function agenda(tasks,today){
    var tomorrow=add(today,1), start=monday(today), saturday=add(start,5), sunday=add(start,6), nextSunday=add(start,13);
    var groups=[
      {label:'Просрочено',contains:function(date){return date<today;}},
      {label:'Сегодня',contains:function(date){return date===today;}},
      {label:'Завтра',contains:function(date){return date===tomorrow;}},
      {label:'До выходных',contains:function(date){return date<saturday;}},
      {label:'Выходные',contains:function(date){return date<=sunday;}},
      {label:'Следующая неделя',contains:function(date){return date<=nextSunday;}},
      {label:'Остаток месяца',contains:function(date){return date.slice(0,7)===today.slice(0,7);}},
      {label:'Позже',contains:function(){return true;}}
    ];
    groups.forEach(function(group){group.tasks=[];});
    tasks.forEach(function(task){
      var group=groups.find(function(group){return group.contains(task.dueAt.slice(0,10));});
      group.tasks.push(task);
    });
    return groups.filter(function(group){return group.tasks.length;}).map(function(group){return {label:group.label,tasks:group.tasks};});
  }
  return {days:days,shift:shift,buckets:buckets,add:add,agenda:agenda};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=PlannerCalendar;
