import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDtekEmergency,applyEmergencyStatus,emergencyAdvisory,selectLatestDtekEmergency} from '../src/emergency.mjs';
import {publishEmergencyUpdate} from '../src/emergency-publisher.mjs';

const NOW=new Date('2026-10-17T12:45:00Z');
const EARLIER=new Date('2026-10-16T08:42:22Z');
const POSTED=new Date('2026-10-17T04:58:00Z');
const ACTIVATION='‼️Київська область: в Бучанському, Обухівському, Фастівському районах за командою Укренерго застосовуються екстрені відключення\nНагадаємо, під час екстрених відключень графіки не діють.';
const RETURN='Київщина: за командою Укренерго застосовано графіки відключень\n▪️В разі змін будемо вас інформувати у нашому Telegram-каналі.';
function post(id,text,date=POSTED){return {id,text,publishedAt:date};}
function markup(id,text,date=POSTED){
  return '<div data-post="dtek_ua/'+id+'"><div class="tgme_widget_message_text js-message_text">'+
    text.replace(/&/g,'&amp;').replace(/\n/g,'<br/>')+
    '</div><time datetime="'+date.toISOString()+'"></time></div>';
}
const source=html=>async()=>({ok:true,text:async()=>html});
const logger={log(){},warn(){}};

test('official Kyiv oblast post 4643 explicitly activates schedules and ends tracked emergency',()=>{
  const event=parseDtekEmergency(post(4643,RETURN),NOW);
  assert.equal(event.id,4643);
  assert.equal(event.status,'cancelled');
  assert.equal(event.explicitReturnToPlan,true);
  assert.equal(event.kind,null,'Do not invent which type ended');
  assert.equal(event.scope,'oblast-unspecified');
  const previous=applyEmergencyStatus(null,
    parseDtekEmergency(post(4637,ACTIVATION,EARLIER),NOW));
  const next=applyEmergencyStatus(previous,event);
  assert.equal(next.active,false);
  assert.equal(next.kind,'екстрені');
  assert.equal(emergencyAdvisory(next),'');
});
test('normal schedules and non-oblast messages never invent cancellation',()=>{
  const samples=[
    '‼️Київщина: графіки відключень на 18 жовтня',
    '‼️Київщина: оновлені графіки відключень на сьогодні',
    'Київ: за командою Укренерго застосовано графіки відключень',
    'Дніпропетровщина: за командою Укренерго застосовано графіки відключень',
    'Київщина: завтра застосовано графіки відключень',
    'Київщина: поки не застосовано графіки відключень',
    'Київщина: у частині районів застосовано графіки відключень',
    'Київщина: застосовано графіки відключень, крім Бучанського району'
  ];
  for(const body of samples)
    assert.equal(parseDtekEmergency(post(4643,body),NOW),null,body);
  const stillEmergency=parseDtekEmergency(post(4643,
    'Київщина: екстрені відключення тривають, графіки відключень не діють'),NOW);
  assert.equal(stillEmergency.status,'active');
  assert.equal(selectLatestDtekEmergency([
    post(4637,ACTIVATION,EARLIER),
    post(4641,'Київщина: графіки відключень на 17 жовтня')
  ],NOW).id,4637);
});
test('district-scoped schedule resumption clears only explicitly named area',()=>{
  const prev=applyEmergencyStatus(null,
    parseDtekEmergency(post(4637,ACTIVATION,EARLIER),NOW));
  const event=parseDtekEmergency(post(4643,
    'Київщина: у Бучанському районі застосовано графіки відключень'),NOW);
  assert.equal(event.status,'cancelled');
  assert.deepEqual(event.districts,['Бучанський']);
  const next=applyEmergencyStatus(prev,event);
  assert.equal(next.active,true);
  assert.deepEqual(next.districts,['Обухівський','Фастівський']);
});
test('official 4643 clears real stored active state, posts once and keeps dedup',async()=>{
  const old=parseDtekEmergency(post(4637,ACTIVATION,EARLIER),NOW);
  const state={emergency:{
    status:applyEmergencyStatus(null,old),lastId:4637,messageId:17,
    lastSignature:'existing',formatVersion:2
  }};
  const messages=[],saves=[];
  let claims=0;
  const sender=async body=>{messages.push(body);return 35;};
  const opts={state,sender,save:async()=>saves.push(true),
    claim:async()=>{claims++;return {claimed:true};},
    now:NOW,logger,fetchFn:source(markup(4643,RETURN))};
  const first=await publishEmergencyUpdate(opts);
  assert.equal(first.status,'published');
  assert.equal(state.emergency.status.active,false);
  assert.equal(state.emergency.lastId,4643);
  assert.equal(messages.length,1);
  assert.match(messages[0],/Скасування екстрених відключень/);
  assert.match(messages[0],/Повертаємося до погодинних графіків/);
  assert.match(messages[0],/https:\/\/t\.me\/dtek_ua\/4643/);
  assert.equal(claims,1);
  assert.equal((await publishEmergencyUpdate(opts)).status,'unchanged');
  assert.equal(messages.length,1);
  assert.equal(saves.length,1);
});
test('routine plan announcement with no tracked incident records safely but sends nothing',async()=>{
  const state={};
  const messages=[];
  const options={state,sender:async text=>{messages.push(text);return 22;},
    save:async()=>{},claim:async()=>{throw Error('Must not claim fake cancellation');},
    now:NOW,logger,fetchFn:source(markup(4643,RETURN))};
  assert.equal((await publishEmergencyUpdate(options)).status,'already-clear');
  assert.equal(state.emergency.status.active,false);
  assert.equal(messages.length,0);
  assert.equal((await publishEmergencyUpdate(options)).status,'unchanged');
});
test('cancellation for an unrelated district does not claim/post a cancellation',async()=>{
  const state={emergency:{status:{
    active:true,kind:'екстрені',scope:'districts',
    districts:['Бучанський']
  },lastId:4637,lastSignature:'old'}};
  const body='Київщина: в Обухівському районі застосовано графіки відключень';
  const messages=[];
  const options={state,sender:async txt=>{messages.push(txt);return 55;},
    save:async()=>{},claim:async()=>{throw Error('Should not claim unrelated cancellation');},
    now:NOW,logger,fetchFn:source(markup(4643,body))};
  assert.equal((await publishEmergencyUpdate(options)).status,'unchanged-content');
  assert.equal(state.emergency.status.active,true);
  assert.deepEqual(state.emergency.status.districts,['Бучанський']);
  assert.equal(messages.length,0);
});
