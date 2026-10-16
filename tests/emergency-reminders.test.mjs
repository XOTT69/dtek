import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileEmergencyReminders, reconcileEmergencyDaily } from '../src/emergency-reminders.mjs';
import { GROUPS, windowsFromHours, renderDailyMessages } from '../src/schedule.mjs';
import { createHash } from 'node:crypto';

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
  assert.match(edits[0].text,/Графіки не діють/);
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

test('active emergency annotates existing confirmed daily graph without breaking water bot format',async()=>{
  const now=new Date('2026-10-16T10:00:00Z');
  const source={},groups=byGroup(['1.2','2.2'],19);
  const [fragment]=renderDailyMessages('2026-10-16','сьогодні',groups,source);
  const hash=createHash('sha256').update(fragment.fingerprint).digest('hex');
  const state={publications:{[fragment.key]:{messageId:16,hash}},emergency:{status}};
  const edits=[];
  const sender={edit:async(id,text)=>edits.push({id,text})};
  const args={state,source,allGroups:()=>groups,sender,save:async()=>{},now,logger};
  assert.equal(await reconcileEmergencyDaily(args),1);
  assert.equal(edits.length,1);
  assert.equal(edits[0].id,16);
  assert.match(edits[0].text,/💡<b>Підгрупа 1\.2 відключення:<\/b>/);
  assert.match(edits[0].text,/❌з 18:00 до 19:00 \(1\.0 год\)/);
  assert.match(edits[0].text,/⚠️ <b>Увага:<\/b>/);
  assert.match(edits[0].text,/Фастівський район/);
  assert.equal(await reconcileEmergencyDaily(args),0);
  assert.equal(edits.length,1);
});

test('official cancellation removes only the emergency disclaimer from the existing daily message',async()=>{
  const now=new Date('2026-10-16T10:00:00Z');
  const groups=byGroup(['2.2'],19);
  const [frag]=renderDailyMessages('2026-10-16','сьогодні',groups,{});
  const hash=createHash('sha256').update(frag.fingerprint).digest('hex');
  const state={publications:{[frag.key]:{
    messageId:16,hash,emergencyContextKey:'previous-emergency'
  }},emergency:{status:{active:false,kind:'екстрені',districts:[]}}};
  const edits=[];
  await reconcileEmergencyDaily({
    state,source:{},allGroups:()=>groups,
    sender:{edit:async(id,text)=>edits.push({id,text})},
    save:async()=>{},now,logger
  });
  assert.equal(edits.length,1);
  assert.equal(edits[0].id,16);
  assert.doesNotMatch(edits[0].text,/⚠️ <b>Увага:<\/b>/);
  assert.match(edits[0].text,/Підгрупа 2\.2 відключення/);
});

test('daily emergency annotation never replaces a graph with a mismatched content hash',async()=>{
  const groups=byGroup(['2.2'],19);
  const [frag]=renderDailyMessages('2026-10-16','сьогодні',groups,{});
  const state={publications:{[frag.key]:{messageId:16,hash:'stale-digest'}},emergency:{status}};
  let edits=0;
  assert.equal(await reconcileEmergencyDaily({
    state,source:{},allGroups:()=>groups,sender:{edit:async()=>edits++},
    save:async()=>{},now:new Date('2026-10-16T10:00:00Z'),logger
  }),0);
  assert.equal(edits,0);
});

test('emergency correction preserves an initially published plain schedule heading',async()=>{
  const now=new Date('2026-10-16T10:00:00Z'),date='2026-10-16';
  const groups=byGroup(['1.2'],19);
  const [post]=renderDailyMessages(date,'сьогодні',groups,{});
  const hash=createHash('sha256').update(post.fingerprint).digest('hex');
  const state={dailyRevisions:{[date]:{hash:'confirmed-facts',revision:0}},
    publications:{[post.key]:{messageId:31,hash}},emergency:{status}};
  const edits=[];
  const count=await reconcileEmergencyDaily({
    state,source:{},allGroups:()=>groups,sender:{
      edit:async(id,text)=>edits.push(text)
    },save:async()=>{},now,logger
  });
  assert.equal(count,1);
  assert.match(edits[0],/^💡<b>Графік відключення світла на сьогодні\./);
  assert.doesNotMatch(edits[0],/Оновлений графік/);
  assert.match(edits[0],/Графіки не діють/);
});

test('emergency cancellation preserves updated heading of an actually revised timetable',async()=>{
  const now=new Date('2026-10-16T10:00:00Z'),date='2026-10-16';
  const groups=byGroup(['1.2','2.2'],19);
  const [post]=renderDailyMessages(date,'сьогодні',groups,{},{
    updated:true
  });
  const hash=createHash('sha256').update(post.fingerprint).digest('hex');
  const state={dailyRevisions:{[date]:{hash:'confirmed-facts-revised',revision:2}},
    publications:{[post.key]:{
      messageId:37,hash,emergencyContextKey:'previous-emergency'
    }},emergency:{status:{active:false,kind:'екстрені',districts:[]}}};
  const edits=[];
  const count=await reconcileEmergencyDaily({
    state,source:{},allGroups:()=>groups,sender:{
      edit:async(id,text)=>edits.push(text)
    },save:async()=>{},now,logger
  });
  assert.equal(count,1);
  assert.match(edits[0],/^💡<b>Оновлений графік відключення світла на сьогодні\./);
  assert.doesNotMatch(edits[0],/Графіки не діють/);
  assert.match(edits[0],/❌з 18:00 до 19:00/);
});
