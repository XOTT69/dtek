import test from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotGroups, sameSnapshot, selectCorrection, renderCorrectionTelegram,
  renderCancelledReminder
} from '../src/corrections.mjs';
import { publishScheduleCorrection } from '../src/correction-publisher.mjs';
import { GROUPS } from '../src/schedule.mjs';

const DATE='2026-10-16';
const old = () => Object.fromEntries(GROUPS.map(group => [group, []]));
function example() {
  const s=old();
  for (const group of ['1.1','1.2','2.1','2.2']) s[group]=[[540,690]];
  for (const group of ['3.1','3.2','4.1','4.2']) s[group]=[[660,900]];
  return s;
}
function newExample() {
  const s=example();
  s['2.2']=[[540,900]];
  return s;
}
function asByGroup(s) {
  return Object.fromEntries(GROUPS.map(group=> [
    group, {mode:'fact',confirmed:s[group].map(([start,end])=>
      ({start,end,minutes:end-start})),possible:[]}
  ]));
}
const silence={log(){},warn(){}};

test('revised 2.2 ending produces 11:30 correction with the groups from example',()=>{
  const oldSchedule=example(),updated=newExample();
  const change=selectCorrection(DATE,oldSchedule,updated,680);
  assert.equal(change.minute,690);
  assert.deepEqual(change.changed,['2.2']);
  assert.deepEqual(change.restored,['1.1','1.2','2.1']);
  assert.deepEqual(change.starting,[]);
  assert.deepEqual(change.continuing,['2.2','3.1','3.2','4.1','4.2']);
  const text=renderCorrectionTelegram(change);
  assert.match(text,/⚠️ <b>Коригування<\/b>/);
  assert.match(text,/11:30/);
  assert.match(text,/🔋 Підгрупа 1\.1/);
  assert.match(text,/🔋 Підгрупа 2\.1/);
  assert.match(text,/⚠️ Підгрупа 2\.2/);
  assert.match(text,/⚠️ Підгрупа 4\.2/);
  assert.match(text,/Змінено підгрупи: 2\.2/);
  assert.doesNotMatch(text,/💡Підгрупа 2\.2 відключення:|❌з \d/);
});

test('correction boundary selection prefers near upcoming, ignores irrelevant old ones',()=>{
  assert.equal(selectCorrection(DATE,example(),newExample(),680).minute,690);
  assert.equal(selectCorrection(DATE,example(),newExample(),710).minute,690); // just passed
  assert.equal(selectCorrection(DATE,example(),newExample(),750).minute,900); // later
  assert.equal(selectCorrection(DATE,example(),newExample(),1000),null);
  assert.equal(selectCorrection(DATE,example(),example(),680),null);
  assert.equal(renderCancelledReminder(DATE,690).includes('скасовано або перенесено'),true);
});

test('a newly confirmed schedule is only recorded as a baseline, no fake correction',async()=>{
  const state={events:{},publications:{}};
  let saves=0,sends=0;
  const result=await publishScheduleCorrection({
    state,date:DATE,byGroup:asByGroup(newExample()),nowMinute:680,
    sender:async()=>{sends++;return 40;},save:async()=>{saves++;},
    logger:silence,claim:async()=>{throw Error('no claim for baseline')}
  });
  assert.equal(result.status,'baseline');
  assert.equal(saves,1);
  assert.equal(sends,0);
  assert.ok(sameSnapshot(state.scheduleSnapshots[DATE],snapshotGroups(asByGroup(newExample()))));
});

test('real change sends one correction and fixes an already-sent future reminder',async()=>{
  const state={events:{'2026-10-16@11:30#pre30':{messageId:14}},scheduleSnapshots:{[DATE]:example()}};
  const sent=[],edited=[];
  const sender=async text=>{sent.push(text);return 99};
  sender.edit=async(id,text)=>{edited.push({id,text});return true};
  let claims=0;
  const opts={
    state,date:DATE,byGroup:asByGroup(newExample()),nowMinute:680,
    sender,save:async()=>{},claim:async()=>{claims++;return {claimed:true}},logger:silence
  };
  const result=await publishScheduleCorrection(opts);
  assert.equal(result.status,'published');
  assert.equal(result.messageId,99);
  assert.equal(claims,1);
  assert.equal(sent.length,1);
  assert.equal(edited.length,1);
  assert.equal(edited[0].id,14);
  assert.match(edited[0].text,/До планового часу: 10 хв/);
  assert.doesNotMatch(edited[0].text,/🔋 Підгрупа 2\.2/);
  assert.match(edited[0].text,/⚫️ Підгрупа 2\.2/);
  assert.deepEqual(state.scheduleSnapshots[DATE],newExample());
  assert.equal((await publishScheduleCorrection(opts)).status,'unchanged');
  assert.equal(sent.length,1);
});

test('remote correction claim blocks duplicate sends after lost local state',async()=>{
  const state={events:{},scheduleSnapshots:{[DATE]:example()}};
  let sends=0;
  const result=await publishScheduleCorrection({
    state,date:DATE,byGroup:asByGroup(newExample()),nowMinute:680,
    sender:async()=>{sends++;return 1},save:async()=>{},
    claim:async()=>({claimed:false}),logger:silence
  });
  assert.equal(result.status,'already-reserved');
  assert.equal(sends,0);
  assert.deepEqual(state.scheduleSnapshots[DATE],newExample());
});

test('if old reminder is cancelled, edit rather than leave outdated warning',async()=>{
  const baseline=old();
  baseline['1.1']=[[690,750]];
  const current=old();
  current['1.1']=[[750,810]];
  const events={'2026-10-16@11:30#pre30':{messageId:18}};
  const edits=[];
  const sender=async()=>42;
  sender.edit=async(id,text)=>edits.push({id,text});
  const result=await publishScheduleCorrection({
    state:{events,scheduleSnapshots:{[DATE]:baseline}},
    date:DATE,byGroup:asByGroup(current),nowMinute:680,
    sender,save:async()=>{},claim:async()=>({claimed:true}),logger:silence
  });
  assert.equal(result.status,'published');
  assert.equal(edits.length,1);
  assert.match(edits[0].text,/скасовано або перенесено/);
});

test('tentative schedules never create a correction or baseline',async()=>{
  const groups=asByGroup(newExample());
  groups['2.2'].mode='preset';
  let called=false;
  const state={};
  const result=await publishScheduleCorrection({
    state,date:DATE,byGroup:groups,nowMinute:680,
    sender:async()=>{called=true;},save:async()=>{called=true;},logger:silence
  });
  assert.equal(result.status,'unconfirmed');
  assert.equal(called,false);
});

test('recent already-passed reminder is corrected without pretending a future countdown',async()=>{
  const state={events:{'2026-10-16@11:30#pre30':{messageId:22}},
    scheduleSnapshots:{[DATE]:example()}};
  const edited=[];
  const sender=async()=>33;
  sender.edit=async(id,text)=>{edited.push({id,text});return true};
  await publishScheduleCorrection({
    state,date:DATE,byGroup:asByGroup(newExample()),nowMinute:705,
    sender,save:async()=>{},claim:async()=>({claimed:true}),logger:silence
  });
  assert.equal(edited.length,1);
  assert.equal(edited[0].id,22);
  assert.match(edited[0].text,/Уточнення після зміни графіка/);
  assert.doesNotMatch(edited[0].text,/До планового часу/);
  assert.match(edited[0].text,/⚫️ Підгрупа 2\.2/);
});

test('very old reminder is not silently edited after its switching time',async()=>{
  const state={events:{'2026-10-16@11:30#pre30':{messageId:22}},
    scheduleSnapshots:{[DATE]:example()}};
  const edited=[];
  const sender=async()=>33;
  sender.edit=async(id,text)=>edited.push({id,text});
  await publishScheduleCorrection({
    state,date:DATE,byGroup:asByGroup(newExample()),nowMinute:780,
    sender,save:async()=>{},claim:async()=>({claimed:true}),logger:silence
  });
  assert.equal(edited.length,0);
});

test('change-triggered correction warns when emergency outages suspend ordinary schedule',async()=>{
  const state={
    events:{},
    scheduleSnapshots:{[DATE]:example()},
    emergency:{status:{
      active:true,kind:'екстрені',scope:'districts',
      districts:['Бучанський','Обухівський','Фастівський']
    }}
  };
  const messages=[];
  const result=await publishScheduleCorrection({
    state,date:DATE,byGroup:asByGroup(newExample()),nowMinute:680,
    sender:async text=>{messages.push(text);return 50},
    save:async()=>{},claim:async()=>({claimed:true}),
    updateReminders:false,logger:silence
  });
  assert.equal(result.status,'published');
  assert.equal(messages.length,1);
  assert.match(messages[0],/⚠️ <b>Увага:<\/b>/);
  assert.match(messages[0],/Графіки не діють/);
  assert.match(messages[0],/11:30/);
});
