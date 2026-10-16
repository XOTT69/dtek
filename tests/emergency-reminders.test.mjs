import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileEmergencyReminders } from '../src/emergency-reminders.mjs';
import { GROUPS, windowsFromHours } from '../src/schedule.mjs';

function byGroup(offGroups = [], hour = 19) {
  const hours = Object.fromEntries(Array.from({length:24},(_,i)=>[String(i+1),'yes']));
  const outages = {...hours,[String(hour)]:'no'};
  return Object.fromEntries(GROUPS.map(group=>[
    group,{mode:'fact',...windowsFromHours(offGroups.includes(group)?outages:hours)}
  ]));
}
const status = {
  active:true,kind:'екстрені',scope:'districts',
  districts:['Бучанський','Обухівський','Фастівський']
};
const logger={log(){},warn(){}};

test('previously sent future reminder is edited with emergency warning, not reposted', async () => {
  const now=new Date('2026-10-16T14:35:00Z'); // 17:35 in Kyiv
  const state={events:{'2026-10-16@18:00#pre30':{messageId:20}},
    emergency:{status}};
  const edits=[],sends=[];
  const sender=async text=>{sends.push(text);return 44};
  sender.edit=async(id,text)=>{edits.push({id,text})};
  const doc={};const allGroups=()=>byGroup(['1.2','2.2'],19);
  const args={state,source:doc,allGroups,sender,save:async()=>{},
    now,logger};
  assert.equal(await reconcileEmergencyReminders(args),1);
  assert.equal(edits.length,1);
  assert.equal(edits[0].id,20);
  assert.match(edits[0].text,/18:00/);
  assert.match(edits[0].text,/25 хв/);
  assert.match(edits[0].text,/діють екстрені відключення/);
  assert.match(edits[0].text,/Планові години можуть не виконуватися/);
  assert.equal(sends.length,0);
  assert.equal(await reconcileEmergencyReminders(args),0);
  assert.equal(edits.length,1);
});

test('after official cancellation, future reminder reverts to normal schedule',async()=>{
  const now=new Date('2026-10-16T14:35:00Z');
  const state={events:{'2026-10-16@18:00#pre30':{
    messageId:20,emergencyContextKey:JSON.stringify({
      active:true,kind:'екстрені',districts:['Бучанський','Обухівський','Фастівський']
    })}},emergency:{status:{active:false,kind:'екстрені',districts:[]}}};
  const edits=[];
  const sender={edit:async(id,text)=>edits.push(text)};
  assert.equal(await reconcileEmergencyReminders({
    state,source:{},allGroups:()=>byGroup(['2.2'],19),sender,
    save:async()=>{},now,logger
  }),1);
  assert.equal(edits.length,1);
  assert.doesNotMatch(edits[0],/⚠️ <b>Увага/);
  assert.match(edits[0],/🪫 Підгрупа 2\.2/);
});

test('midnight event is preserved, not falsely marked cancelled',async()=>{
  const now=new Date('2026-10-16T20:38:00Z'); // 23:38 Kyiv
  const today=byGroup(['1.2'],24);
  const tomorrow=byGroup([],1);
  const state={events:{'2026-10-17@00:00#pre30':{messageId:31}},
    emergency:{status}};
  const edits=[];
  const sender={edit:async(id,text)=>edits.push(text)};
  const result=await reconcileEmergencyReminders({
    state,source:{},
    allGroups:(_source,date)=>date==='2026-10-16'?today:tomorrow,
    sender,save:async()=>{},now,logger
  });
  assert.equal(result,1);
  assert.match(edits[0],/00:00/);
  assert.match(edits[0],/🔋 Підгрупа 1\.2/);
  assert.doesNotMatch(edits[0],/скасовано або перенесено/);
});

test('past scheduled switching times are never edited retroactively by emergency reminder sync',async()=>{
  const state={events:{'2026-10-16@11:30#pre30':{messageId:14}},
    emergency:{status}};
  let edits=0;
  assert.equal(await reconcileEmergencyReminders({
    state,source:{},allGroups:()=>byGroup(['1.2'],19),
    sender:{edit:async()=>{edits++}},save:async()=>{},
    now:new Date('2026-10-16T10:00:00Z'),logger
  }),0);
  assert.equal(edits,0);
});
