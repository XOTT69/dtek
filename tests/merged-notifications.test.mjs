import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS } from '../src/schedule.mjs';
import { publishScheduleCorrection } from '../src/correction-publisher.mjs';
import { publishAdvanceReminder } from '../src/reminder-publisher.mjs';
import { reconcileEmergencyReminders } from '../src/emergency-reminders.mjs';

const DATE='2026-10-16',MINUTE=690;
const empty=()=>Object.fromEntries(GROUPS.map(g=>[g,[]]));
function oldPlan() {
  const s=empty();
  for (const g of ['1.1','1.2','2.1','2.2']) s[g]=[[540,690]];
  for (const g of ['3.1','3.2','4.1','4.2']) s[g]=[[660,900]];
  return s;
}
function newPlan() {
  const s=oldPlan();
  s['2.2']=[[540,900]];
  return s;
}
function groups(schedule) {
  return Object.fromEntries(GROUPS.map(g=>[
    g,{mode:'fact',confirmed:schedule[g].map(([start,end])=>
      ({start,end,minutes:end-start})),possible:[]}
  ]));
}
const logger={log(){},warn(){}};
const make=()=>({events:{},scheduleSnapshots:{[DATE]:oldPlan()},corrections:{}});
function senderPair() {
  const sends=[],edits=[];
  const sender=async text=>{sends.push(text);return 42};
  sender.edit=async(id,text)=>{edits.push({id,text});return true};
  return {sender,sends,edits};
}
function settings(state,sender,params={}) {
  return {state,date:DATE,byGroup:groups(newPlan()),nowMinute:670,
    save:async()=>{},sender,claim:async()=>({claimed:true}),
    claimAdvance:async()=>({claimed:true}),
    mergeNearby:true,logger,...params};
}

test('same-run update within 30m produces ONLY one combined correction and reserves its reminder',async()=>{
  const state=make(),{sender,sends,edits}=senderPair(),keys=[];
  const r=await publishScheduleCorrection(settings(state,sender,{
    claimAdvance:async key=>{keys.push(key);return {claimed:true}}
  }));
  assert.equal(r.status,'published');
  assert.equal(r.merged,true);
  assert.equal(sends.length,1);
  assert.equal(edits.length,0);
  assert.deepEqual(keys,['2026-10-16@11:30#pre30']);
  assert.match(sends[0],/⚠️ <b>Коригування графіка на 11:30<\/b>/);
  assert.match(sends[0],/До планового часу: 20 хв/);
  assert.match(sends[0],/🟢 <b>За графіком вмикаємо світло:<\/b>/);
  assert.match(sends[0],/⚫️ Підгрупа 2\.2/);
  assert.match(sends[0],/Змінено підгрупи: 2\.2/);
  assert.equal(state.events['2026-10-16@11:30#pre30'].messageId,42);
  assert.equal(state.corrections['2026-10-16@690'].combined,true);
  const retry=await publishAdvanceReminder({
    state,date:DATE,minutesNow:675,
    todayGroups:groups(newPlan()),tomorrowGroups:groups(empty()),
    sender:async()=>{throw Error('must not send another post')},
    claim:async()=>{throw Error('must not reserve again')},
    save:async()=>{throw Error('must not save again')},logger
  });
  assert.equal(retry.status,'already-sent');
  assert.equal(sends.length,1);
});

test('already-published 11:30 reminder is EDITED into merged correction instead of second post',async()=>{
  const state=make();
  state.events['2026-10-16@11:30#pre30']={messageId:87,formatVersion:5};
  const {sender,sends,edits}=senderPair();
  let calls=0;
  const result=await publishScheduleCorrection(settings(state,sender,{
    claimAdvance:async()=>{calls++;throw Error('no need for second claim')}
  }));
  assert.equal(result.status,'merged');
  assert.equal(result.messageId,87);
  assert.equal(calls,0);
  assert.equal(sends.length,0);
  assert.equal(edits.length,1);
  assert.equal(edits[0].id,87);
  assert.match(edits[0].text,/Коригування графіка на 11:30/);
  assert.equal(state.corrections['2026-10-16@690'].messageId,87);
});

test('revised older correction can be updated in place when within 30 minutes',async()=>{
  const state=make();
  state.corrections['2026-10-16@690']={messageId:65,updatedAt:'2026-10-16T09:30:00Z'};
  const {sender,sends,edits}=senderPair();
  const keys=[];
  const result=await publishScheduleCorrection(settings(state,sender,{
    claimAdvance:async key=>{keys.push(key);return {claimed:true}}
  }));
  assert.equal(result.status,'merged');
  assert.deepEqual(keys,['2026-10-16@11:30#pre30']);
  assert.equal(edits.length,1);
  assert.equal(edits[0].id,65);
  assert.equal(sends.length,0);
  assert.equal(state.events['2026-10-16@11:30#pre30'].messageId,65);
});

test('correction more than 30 min earlier still posts once, later reminder is SHORT',async()=>{
  const state=make(),{sender,sends,edits}=senderPair();
  const r=await publishScheduleCorrection(settings(state,sender,{nowMinute:630}));
  assert.equal(r.status,'published');
  assert.notEqual(r.merged,true);
  assert.equal(sends.length,1);
  assert.match(sends[0],/⚠️ <b>Коригування<\/b>/);
  assert.doesNotMatch(sends[0],/До планового часу/);
  const later=await publishAdvanceReminder({
    state,date:DATE,minutesNow:665,
    todayGroups:groups(newPlan()),tomorrowGroups:groups(empty()),
    sender,save:async()=>{},claim:async()=>({claimed:true}),logger
  });
  assert.equal(later.status,'published');
  assert.equal(sends.length,2);
  assert.match(sends[1],/До планового часу: 25 хв/);
  assert.match(sends[1],/Нагадуємо про зміни за оновленим графіком/);
  assert.match(sends[1],/t\.me\/svitlo_kyivshchyna\/42/);
  assert.doesNotMatch(sends[1],/🪫 Підгрупа|🔋 Підгрупа/);
  assert.equal(edits.length,0);
});

test('lost state or repeated run cannot send a second near-term announcement',async()=>{
  const state=make(),{sender,sends}=senderPair();
  const r=await publishScheduleCorrection(settings(state,sender,{
    claimAdvance:async()=>({claimed:false})
  }));
  assert.equal(r.status,'already-reserved');
  assert.equal(sends.length,0);
  assert.equal(state.events['2026-10-16@11:30#pre30'].claimed,true);
});

test('nearby merge is explicitly disabled for tomorrow pending schedule, where nowMinute is placeholder zero',async()=>{
  const state=make(),{sender,sends}=senderPair();
  const r=await publishScheduleCorrection(settings(state,sender,{
    nowMinute:660,mergeNearby:false,
    claimAdvance:async()=>{throw Error('must not reserve a reminder')}
  }));
  assert.equal(r.status,'published');
  assert.equal(sends.length,1);
  assert.match(sends[0],/⚠️ <b>Коригування<\/b>/);
});

test('emergency announcement edit keeps the merged correction content',async()=>{
  const state=make(),{sender}=senderPair();
  await publishScheduleCorrection(settings(state,sender));
  const event=state.events['2026-10-16@11:30#pre30'];
  state.emergency={status:{
    active:true,kind:'екстрені',districts:['Бучанський','Фастівський']
  }};
  const changes=[];
  const editor={edit:async(id,text)=>changes.push({id,text})};
  const changed=await reconcileEmergencyReminders({
    state,source:{},allGroups:(_source,date)=>groups(newPlan()),
    sender:editor,save:async()=>{},
    now:new Date('2026-10-16T08:10:00Z'),logger
  });
  assert.equal(changed,1);
  assert.equal(changes[0].id,event.messageId);
  assert.match(changes[0].text,/Коригування графіка на 11:30/);
  assert.match(changes[0].text,/Графіки не діють/);
});

test('when DTEK cancels a previously expected switch, combined notice says so clearly', async()=>{
  const previous=empty(), current=empty();
  previous['1.1']=[[690,750]];
  current['1.1']=[[750,810]];
  const state={events:{},scheduleSnapshots:{[DATE]:previous},corrections:{}};
  const {sender,sends}=senderPair();
  const r=await publishScheduleCorrection({
    state,date:DATE,byGroup:groups(current),nowMinute:670,
    sender,save:async()=>{},
    claim:async()=>({claimed:true}),claimAdvance:async()=>({claimed:true}),
    mergeNearby:true,logger
  });
  assert.equal(r.status,'published');
  assert.equal(sends.length,1);
  assert.match(sends[0],/Коригування графіка на 11:30/);
  assert.match(sends[0],/Раніше заплановане перемикання на цей час скасовано або перенесено/);
  assert.doesNotMatch(sends[0],/🔴 <b>За графіком вимикаємо|🟢 <b>За графіком вмикаємо/);
});
