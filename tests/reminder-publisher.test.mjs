import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, windowsFromHours } from '../src/schedule.mjs';
import { publishAdvanceReminder } from '../src/reminder-publisher.mjs';

const DATE = '2026-10-16';
const HOURS = Object.fromEntries(Array.from({length:24},(_,i)=>[String(i+1),'yes']));
const byGroup = value => Object.fromEntries(GROUPS.map(g => [
  g, {mode:'fact', ...windowsFromHours(value[g] || HOURS)}
]));
const off = (...hours) => ({...HOURS,...Object.fromEntries(hours.map(h=>[String(h),'no']))});
const logger = {log(){},warn(){}};
function fixtures() {
  return byGroup({
    '1.2': off(19),     // starts 18:00
    '2.2': off(19),     // starts 18:00
    '3.1': off(18,19),  // still off at 18:00
    '4.2': off(18)      // restores at 18:00
  });
}
const base = () => ({state:{events:{}},date:DATE,minutesNow:1055,
  todayGroups:fixtures(),tomorrowGroups:byGroup({}),logger});

test('first 5-minute dispatch sends one accurate 18:00 pre-switch message',async()=>{
  const p=base(),sent=[],claimed=[],saved=[];
  const result=await publishAdvanceReminder({...p,
    claim:async key=>{claimed.push(key);return {claimed:true}},
    sender:async msg=>{sent.push(msg);return 85},
    save:async state=>saved.push(structuredClone(state))
  });
  assert.equal(result.status,'published');
  assert.equal(result.key,'2026-10-16@18:00#pre30');
  assert.equal(result.leadMinutes,25);
  assert.deepEqual(claimed,['2026-10-16@18:00#pre30']);
  assert.equal(sent.length,1);
  assert.match(sent[0],/⏰ <b>18:00<\/b>/);
  assert.match(sent[0],/До планового часу: 25 хв/);
  assert.match(sent[0],/🪫 Підгрупа 1\.2/);
  assert.match(sent[0],/🪫 Підгрупа 2\.2/);
  assert.match(sent[0],/🔋 Підгрупа 4\.2/);
  assert.match(sent[0],/⚫️ Підгрупа 3\.1/);
  assert.equal(saved.length,1);
  assert.equal(saved[0].events[result.key].messageId,85);

  const another=await publishAdvanceReminder({...p,
    claim:async()=>{throw Error('must not reserve again')},
    sender:async()=>{throw Error('must not send twice')},
    save:async()=>{throw Error('must not save')},
  });
  assert.equal(another.status,'already-sent');
});

test('fresh workflow checkout with lost local state skips remotely claimed reminder',async()=>{
  const p=base();let sent=0,saved=0;
  const result=await publishAdvanceReminder({...p,
    claim:async()=>({claimed:false}),sender:async()=>{sent++;return 1},
    save:async()=>{saved++}
  });
  assert.equal(result.status,'already-reserved');
  assert.equal(sent,0);
  assert.equal(saved,1);
  assert.equal(p.state.events['2026-10-16@18:00#pre30'].claimed,true);
});

test('confirmed emergency caveat is appended to timed alerts',async()=>{
  const p=base();
  p.state.emergency={status:{active:true,kind:'екстрені',
    districts:['Бучанський','Обухівський','Фастівський']}};
  const result=await publishAdvanceReminder({...p,dryRun:true});
  assert.equal(result.status,'preview');
  assert.match(result.message,/⚠️ <b>Увага:<\/b>/);
  assert.match(result.message,/Графіки не діють/);
  assert.match(result.message,/Фастівський район/);
  assert.deepEqual(p.state.events,{});
});

test('never sends stale event at or after its scheduled half-hour boundary',async()=>{
  for (const minute of [1080,1085,1071]) {
    let sends=0;
    const result=await publishAdvanceReminder({...base(),minutesNow:minute,
      sender:async()=>{sends++},claim:async()=>{sends++},
      save:async()=>{sends++}
    });
    assert.equal(result.status,'none','minute='+minute);
    assert.equal(sends,0);
  }
});

test('midnight switching notification uses confirmed data from both days',async()=>{
  const today=byGroup({'2.2':off(24),'3.1':off(24)});
  const tomorrow=byGroup({'3.1':off(1),'1.2':off(1)});
  const p=base();
  const result=await publishAdvanceReminder({...p,minutesNow:1420,
    todayGroups:today,tomorrowGroups:tomorrow,dryRun:true});
  assert.equal(result.status,'preview');
  assert.equal(result.key,'2026-10-17@00:00#pre30');
  assert.match(result.message,/⏰ <b>00:00<\/b>/);
  assert.match(result.message,/🔋 Підгрупа 2\.2/);
  assert.match(result.message,/🪫 Підгрупа 1\.2/);
  assert.match(result.message,/⚫️ Підгрупа 3\.1/);
});

test('incomplete or only tentative forecast never triggers a switching alert',async()=>{
  const p=base();p.todayGroups['1.2'].mode='preset';
  let sends=0;
  assert.equal((await publishAdvanceReminder({...p,
    sender:async()=>{sends++},claim:async()=>{sends++}})).status,'none');
  assert.equal(sends,0);
});
