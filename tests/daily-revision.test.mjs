import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, windowsFromHours, renderDailyMessages } from '../src/schedule.mjs';
import { trackDailyRevision, dailyIsUpdated } from '../src/daily-revision.mjs';

function confirmed(start=540,end=660) {
  const d=Object.fromEntries(Array.from({length:24},(_,i)=>[String(i+1),'yes']));
  for(let p=start;p<end;p+=30) {
    const hour=Math.floor(p/60)+1,first=p%60===0;
    const current=d[String(hour)];
    d[String(hour)]=current==='no'?'no':
      current==='yes'?(first?'first':'second'):'no';
  }
  return Object.fromEntries(GROUPS.map(g=>[
    g,{mode:'fact',...windowsFromHours(g==='1.2'?d:
      Object.fromEntries(Array.from({length:24},(_,i)=>[String(i+1),'yes'])))}
  ]));
}
const clone=x=>structuredClone(x);

test('first daily fact is initial, repeated polls never increment versions',()=>{
  const state={publications:{}},groups=confirmed();
  const first=trackDailyRevision(state,'2026-10-17',groups);
  assert.deepEqual(first,{eligible:true,updated:false,changed:true,revision:0});
  assert.equal(trackDailyRevision(state,'2026-10-17',clone(groups)).changed,false);
  assert.equal(dailyIsUpdated(state,'2026-10-17'),false);
  assert.match(renderDailyMessages('2026-10-17','завтра',groups,{},{
    updated:dailyIsUpdated(state,'2026-10-17')
  })[0].message,/^💡<b>Графік відключення світла на завтра\./);
});

test('real interval correction after prior publication produces updated message',()=>{
  const date='2026-10-17',state={publications:{}};
  const first=confirmed(),changed=confirmed(570,690);
  trackDailyRevision(state,date,first);
  state.publications[date+'/завтра/all']={messageId:28,hash:'some previous fact'};
  const changedResult=trackDailyRevision(state,date,changed);
  assert.equal(changedResult.updated,true);
  assert.equal(changedResult.revision,1);
  assert.match(renderDailyMessages(date,'сьогодні',changed,{},{
    updated:dailyIsUpdated(state,date)
  })[0].message,/^💡<b>Оновлений графік відключення світла на сьогодні\./);
  assert.equal(trackDailyRevision(state,date,changed).revision,1);
  const secondChange=trackDailyRevision(state,date,confirmed(600,720));
  assert.equal(secondChange.revision,2);
  assert.equal(secondChange.updated,true);
});

test('tomorrow-to-today rollover is not itself a revised timetable',()=>{
  const date='2026-10-17',state={publications:{}},groups=confirmed();
  trackDailyRevision(state,date,groups);
  state.publications[date+'/завтра/all']={messageId:90};
  const newDay=trackDailyRevision(state,date,groups);
  assert.equal(newDay.revision,0);
  assert.equal(newDay.updated,false);
  assert.match(renderDailyMessages(date,'сьогодні',groups,{},{
    updated:newDay.updated
  })[0].message,/^💡<b>Графік відключення світла на сьогодні\./);
});

test('source correction before first successful announcement remains initial',()=>{
  const date='2026-10-17',state={publications:{}};
  trackDailyRevision(state,date,confirmed());
  const changed=trackDailyRevision(state,date,confirmed(570,690));
  assert.equal(changed.revision,0);
  assert.equal(changed.updated,false);
});

test('emergency warnings and source timestamp updates cannot fake schedule revision',()=>{
  const state={publications:{}},date='2026-10-17',groups=confirmed();
  trackDailyRevision(state,date,groups);
  state.publications[date+'/сьогодні/all']={messageId:22};
  state.emergency={status:{active:true,kind:'екстрені',districts:['Бучанський']}};
  const check=trackDailyRevision(state,date,clone(groups));
  assert.equal(check.updated,false);
  assert.equal(check.revision,0);
});

test('unconfirmed tomorrow never creates a revision baseline or notice',()=>{
  const state={publications:{}},groups=confirmed();
  groups['4.2'].mode='preset';
  const got=trackDailyRevision(state,'2026-10-18',groups);
  assert.equal(got.eligible,false);
  assert.equal(got.changed,false);
  assert.equal(state.dailyRevisions,undefined);
});

test('legacy publisher migration detects genuine updates from complete old snapshot',()=>{
  const date='2026-10-17',before=confirmed(540,660),
    after=confirmed(600,720),state={publications:{}};
  const baseline=Object.fromEntries(GROUPS.map(g=>[
    g,before[g].confirmed.map(({start,end})=>[start,end])
  ]));
  state.scheduleSnapshots={[date]:baseline};
  state.publications[date+'/завтра/all']={messageId:31};
  const result=trackDailyRevision(state,date,after);
  assert.equal(result.updated,true);
  assert.equal(result.revision,1);
  assert.equal(dailyIsUpdated(state,date),true);
});

test('legacy publisher migration never assumes metadata edits constitute a revision',()=>{
  const date='2026-10-17',a=confirmed();
  const state={publications:{[date+'/завтра/all']:{messageId:35}},
    scheduleSnapshots:{[date]:Object.fromEntries(GROUPS.map(g=>[
      g,a[g].confirmed.map(({start,end})=>[start,end])
    ]))}};
  const result=trackDailyRevision(state,date,a);
  assert.equal(result.updated,false);
  assert.equal(result.revision,0);
});

test('legacy migration without complete baseline does not guess at changes',()=>{
  const date='2026-10-17',state={
    publications:{[date+'/сьогодні/all']:{messageId:11}},
    scheduleSnapshots:{[date]:{'1.2':[[540,660]]}}
  };
  const r=trackDailyRevision(state,date,confirmed(600,720));
  assert.equal(r.updated,false);
  assert.equal(r.revision,0);
});

test('restored or all-off schedules count as changes only after initial publication',()=>{
  const state={publications:{}},date='2026-10-17',initial=confirmed();
  trackDailyRevision(state,date,initial);
  state.publications[date+'/сьогодні/all']={messageId:56};
  const empty=confirmed(0,0);
  assert.equal(trackDailyRevision(state,date,empty).updated,true);
  assert.equal(trackDailyRevision(state,date,empty).changed,false);
});
