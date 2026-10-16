import test from 'node:test';
import assert from 'node:assert/strict';
import { publishTomorrowNotice } from '../src/notice-publisher.mjs';

const NOW = new Date('2026-10-15T14:10:00Z');
const DATE = '2026-10-16';
const partial = 'УВАГА! Завтра, 16 ЖОВТНЯ, у частині регіонів України будуть ' +
  'застосовуватись графіки: 06:00 – 23:59 – графіки погодинних відключень ' +
  'для всіх категорій споживачів.';
function html(id, body=partial) {
  return '<div class="tgme_widget_message_wrap">' +
    '<div class="tgme_widget_message" data-post="Ukrenergo/' + id + '">' +
    '<div class="tgme_widget_message_text js-message_text" dir="auto">' +
    body + '</div><a><time datetime="2026-10-15T13:10:00Z"></time></a></div></div>';
}
const logger={log(){},warn(){}};
const fetchFn = body => async () => ({ok:true, status:200, text: async () => body});

test('publishes verified Ukrenergo notice once and saves its state', async () => {
  const state = {publications:{},events:{}};
  let sent=0, persisted=0;
  const sender=async message => {
    sent++;
    assert.match(message, /Для Київської області застосування ще не підтверджене/);
    return 123;
  };
  sender.edit=async()=>{throw Error('Unexpected edit')};
  const options={
    state,sender,now:NOW,logger,fetchFn:fetchFn(html(111)),
    save:async()=>{persisted++}
  };
  assert.equal((await publishTomorrowNotice(options)).status,'published');
  assert.equal(sent,1);
  assert.equal(persisted,1);
  assert.equal(state.announcements[DATE].messageId,123);
  assert.equal((await publishTomorrowNotice(options)).status,'unchanged');
  assert.equal(sent,1);
  assert.equal(persisted,1);
});

test('corrected hours edit existing notice without sending a second message',async()=>{
  const state={};
  const calls=[];
  const sender=async text=>{calls.push(['send',text]);return 77};
  sender.edit=async(id,text)=>{calls.push(['edit',id,text]);return true};
  const common={state,sender,now:NOW,logger,save:async()=>{}};
  await publishTomorrowNotice({...common,fetchFn:fetchFn(html(112))});
  await publishTomorrowNotice({...common,fetchFn:fetchFn(html(
    113,partial.replace('06:00 – 23:59 – графіки погодинних', '08:00 – 22:00 – графіки погодинних')
  ))});
  assert.equal(calls.length,2);
  assert.deepEqual(calls.map(x=>x[0]),['send','edit']);
  assert.equal(calls[1][1],77);
  assert.match(calls[1][2],/08:00–22:00/);
  assert.equal(state.announcements[DATE].sourcePostId,113);
});

test('older official post cannot reverse a later correction',async()=>{
  const state={};
  const sender=async()=>11;
  sender.edit=async()=>{throw Error('Should not edit older post')};
  const common={state,sender,now:NOW,logger,save:async()=>{}};
  await publishTomorrowNotice({...common,fetchFn:fetchFn(html(500))});
  const result=await publishTomorrowNotice({
    ...common,fetchFn:fetchFn(html(200,partial.replace('06:00','07:00')))
  });
  assert.equal(result.status,'older');
});

test('missing applicable official announcement does not spam the channel',async()=>{
  let sent=0;
  const sender=async()=>{sent++;return 1};
  const result=await publishTomorrowNotice({
    state:{},sender,now:NOW,logger,fetchFn:fetchFn(html(
      404,partial.replace('Завтра, 16 ЖОВТНЯ','Завтра, 17 ЖОВТНЯ')
    )),save:async()=>{}
  });
  assert.equal(result.status,'none');
  assert.equal(sent,0);
});

test('preview uses no Telegram publishing or persistent state',async()=>{
  const state={};
  const sender=async()=>{throw Error('Preview attempted to publish')};
  let calls=0;
  const result=await publishTomorrowNotice({
    state,sender,now:NOW,logger,dryRun:true,
    fetchFn:fetchFn(html(110)),
    save:async()=>{calls++}
  });
  assert.equal(result.status,'dry-run');
  assert.equal(calls,0);
  assert.equal(state.announcements,undefined);
});
