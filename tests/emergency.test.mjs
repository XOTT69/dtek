import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOfficialPosts } from '../src/ukrenergo.mjs';
import {
  parseDtekEmergency, selectLatestDtekEmergency, renderEmergencyNotice,
  applyEmergencyStatus, emergencyAdvisory, fetchDtekEmergencies, DTEK_ALERT_FEED
} from '../src/emergency.mjs';
import { publishEmergencyUpdate } from '../src/emergency-publisher.mjs';

const NOW = new Date('2026-10-16T10:00:00Z');
const TIME = new Date('2026-10-16T05:42:00Z');
const START = '‼️Київська область: в Бучанському, Обухівському, Фастівському районах за командою Укренерго застосовуються екстрені відключення\nНагадаємо, під час екстрених відключень графіки не діють.';
const END = '💡Київщина: екстрені відключення світла скасовано\nПовертаємося до графіків.';
function post(id, text=START, publishedAt=TIME) {
  return {id,text,publishedAt,url:'https://t.me/dtek_ua/'+id};
}
function htmlPost(id,text=START,iso=TIME.toISOString()){
  return '<div class="tgme_widget_message" data-post="dtek_ua/'+id+'">' +
    '<div class="tgme_widget_message_text js-message_text">'+
    text.replace(/&/g,'&amp;').replace(/\n/g,'<br/>')+
    '</div><a><time datetime="'+iso+'"></time></a></div>';
}
const logger={log(){},warn(){}};

test('real DTEK announcement of Bucha/Obukhiv/Fastiv districts is correctly interpreted',()=>{
  const p = parseDtekEmergency(post(4637),NOW);
  assert.equal(p.id,4637);
  assert.equal(p.status,'active');
  assert.equal(p.kind,'екстрені');
  assert.equal(p.scope,'districts');
  assert.deepEqual(p.districts,['Бучанський','Обухівський','Фастівський']);
  assert.match(renderEmergencyNotice(p),/Графіки там тимчасово не діють|Погодинні графіки там тимчасово не діють/);
  assert.match(renderEmergencyNotice(p),/t\.me\/dtek_ua\/4637/);
});

test('Kyiv city emergency must not become fake Kyiv oblast alert',()=>{
  const city=post(100,'‼️Київ: за рішенням Укренерго запроваджені екстрені відключення');
  assert.equal(parseDtekEmergency(city,NOW),null);
  const dnipro=post(100,'‼️Одещина: діють аварійні відключення');
  assert.equal(parseDtekEmergency(dnipro,NOW),null);
});

test('Kyiv city plus explicitly mentioned oblast districts is relevant',()=>{
  const text='‼️Правий берег Києва та Бучанський і Вишгородський райони Київської області: за командою Укренерго застосовані екстрені відключення';
  const p=parseDtekEmergency(post(102,text),NOW);
  assert.deepEqual(p.districts,['Бучанський','Вишгородський']);
});

test('DTEK official cancellation despite intervening word світла',()=>{
  const p=parseDtekEmergency(post(500,END),NOW);
  assert.equal(p.status,'cancelled');
  assert.equal(p.kind,'екстрені');
  assert.equal(p.explicitReturnToPlan,true);
  assert.match(renderEmergencyNotice(p),/Скасування екстрених/);
  assert.match(renderEmergencyNotice(p),/Повертаємося до погодинних графіків/);
});

test('partial cancellation preserves areas still under emergency restrictions',()=>{
  const prev=applyEmergencyStatus(null,parseDtekEmergency(post(4637),NOW));
  assert.equal(prev.active,true);
  const stop=parseDtekEmergency(post(4638,'💡Київська область, Бучанський район: екстрені відключення скасовано'),NOW);
  const next=applyEmergencyStatus(prev,stop);
  assert.deepEqual(next.districts,['Обухівський','Фастівський']);
  assert.equal(next.active,true);
  assert.match(renderEmergencyNotice(stop,next.districts),/Обухівський район, Фастівський район/);
});

test('region-wide cancellation clears all affected districts',()=>{
  const prev=applyEmergencyStatus(null,parseDtekEmergency(post(4637),NOW));
  const after=applyEmergencyStatus(prev,parseDtekEmergency(post(4700,END),NOW));
  assert.equal(after.active,false);
  assert.deepEqual(after.districts,[]);
  assert.equal(emergencyAdvisory(after),'');
});

test('unscheduled accident is distinguished from emergency and never claims ETA',()=>{
  const accident=post(190,'‼️Київщина, Бучанський район: через атаку фіксуються аварійні відключення');
  const p=parseDtekEmergency(accident,NOW);
  assert.equal(p.kind,'аварійні');
  const text=renderEmergencyNotice(p);
  assert.match(text,/Аварійні відключення/);
  assert.match(text,/не відповідати плановому графіку/);
  assert.match(text,/Точний час відновлення не підтверджено/);
  assert.doesNotMatch(text,/тимчасово не діють/);
});

test('stale incidents, non-power notices, and generic timetable posts are ignored',()=>{
  assert.equal(parseDtekEmergency(post(100,START,new Date('2026-10-13T06:00:00Z')),NOW),null);
  assert.equal(parseDtekEmergency(post(100,'‼️Київщина: графіки відключень на 16 жовтня'),NOW),null);
  assert.equal(selectLatestDtekEmergency([
    post(15,START),post(20,'‼️Київщина: графіки на завтра'),post(22,END)
  ],NOW).id,22);
});

test('public DTEK channel reader uses only matching DTEK posts',async()=>{
  const html=htmlPost(4637)+
    '<div data-post="Other/999"><div class="tgme_widget_message_text">Fake</div><time datetime="'+TIME.toISOString()+'"></time></div>';
  const posts=extractOfficialPosts(html,'dtek_ua');
  assert.equal(posts.length,1);
  assert.equal(posts[0].id,4637);
  let requested=0;
  const result=await fetchDtekEmergencies({
    now:NOW, fetchFn:async url=>{
      requested++;
      assert.equal(url,DTEK_ALERT_FEED);
      return {ok:true,text:async()=>html};
    }
  });
  assert.equal(requested,1);
  assert.deepEqual(result.districts,['Бучанський','Обухівський','Фастівський']);
});

test('publish once and persist latest official DTEK active alert',async()=>{
  const state={};
  const messages=[];
  let claimed=0,saves=0;
  const sender=async text=>{messages.push(text);return 18};
  const claim=async()=>{claimed++;return {claimed:true}};
  const opts={state,sender,save:async()=>{saves++},claim,
    now:NOW,fetchFn:async()=>({ok:true,text:async()=>htmlPost(4637)}),
    logger};
  const first=await publishEmergencyUpdate(opts);
  assert.equal(first.status,'published');
  assert.equal(messages.length,1);
  assert.equal(claimed,1);
  assert.equal(state.emergency.status.active,true);
  assert.equal(saves,1);
  assert.equal((await publishEmergencyUpdate(opts)).status,'unchanged');
  assert.equal(messages.length,1);
});

test('when DTEK cancels, publish separate cancellation and clear active warning',async()=>{
  const state={};
  const messages=[];
  const sender=async text=>{messages.push(text);return messages.length+20};
  const common={state,sender,save:async()=>{},claim:async()=>({claimed:true}),now:NOW,logger};
  await publishEmergencyUpdate({...common,fetchFn:async()=>({ok:true,text:async()=>htmlPost(4637)})});
  const done=await publishEmergencyUpdate({...common,fetchFn:async()=>({ok:true,text:async()=>htmlPost(4638,END)})});
  assert.equal(done.status,'published');
  assert.equal(messages.length,2);
  assert.match(messages[1],/Скасування екстрених/);
  assert.equal(state.emergency.status.active,false);
});

test('later same-state reminder is not posted twice, and lost state is protected by remote claim',async()=>{
  const state={};
  const messages=[];
  const sender=async text=>{messages.push(text);return 18};
  const claim=async()=>({claimed:true});
  const common={state,sender,save:async()=>{},claim,now:NOW,logger};
  await publishEmergencyUpdate({...common,fetchFn:async()=>({ok:true,text:async()=>htmlPost(4637)})});
  const again=await publishEmergencyUpdate({...common,fetchFn:async()=>({ok:true,text:async()=>htmlPost(4640)})});
  assert.equal(again.status,'unchanged-content');
  assert.equal(messages.length,1);
  const lost=await publishEmergencyUpdate({
    ...common,state:{},claim:async()=>({claimed:false}),
    fetchFn:async()=>({ok:true,text:async()=>htmlPost(4637)})
  });
  assert.equal(lost.status,'already-reserved');
  assert.equal(messages.length,1);
});

test('scheduled reminders get a clear district-scoped warning, not fabricated timing',()=>{
  const status=applyEmergencyStatus(null,parseDtekEmergency(post(4637),NOW));
  const note=emergencyAdvisory(status);
  assert.match(note,/Обухівський район/);
  assert.match(note,/Планові години можуть не виконуватися/);
  assert.doesNotMatch(note,/\d\d:\d\d/);
});
