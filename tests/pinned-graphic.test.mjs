import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUPS
} from '../src/schedule.mjs';
import {
  PINNED_GRAPHIC_VERSION, hasConfirmedGraphic, outageHalves,
  graphicFingerprint, renderPinnedGraphicSvg, renderPinnedGraphicPng,
  pinnedPhotoCaption
} from '../src/pinned-graphic.mjs';
import {publishPinnedGraphic} from '../src/pinned-publisher.mjs';

const DATE='2026-10-17';
const silence={log(){},warn(){}};
function schedule(start=570,end=690){
  return Object.fromEntries(GROUPS.map(g=>[
    g,{mode:'fact',confirmed:g==='1.1'?[{start,end,minutes:end-start}]:[],possible:[]}
  ]));
}
function makeSender({failPin=false}={}){
  const calls=[];
  const sender=Object.assign(async()=>{},{
    photo:async (png,caption)=>{calls.push(['send',png,caption]);return 77;},
    editPhoto:async (id,png,caption)=>{calls.push(['edit',id,png,caption]);return id;},
    pin:async id=>{calls.push(['pin',id]);if(failPin)throw Error('not enough rights');return true;}
  });
  return {sender,calls};
}
const png=async()=>Buffer.from([137,80,78,71]);

test('renders exact 24 hourly columns with 12 subgroup rows and half-hour shading',()=>{
  const s=schedule(570,690); // 09:30 to 11:30
  const svg=renderPinnedGraphicSvg(DATE,s);
  assert.ok(hasConfirmedGraphic(s));
  assert.equal((svg.match(/Підгрупа \d\.\d/g)||[]).length,12);
  assert.ok(svg.includes('00–01'));
  assert.ok(svg.includes('23–24'));
  assert.ok(svg.includes('09–10'));
  assert.ok(svg.includes('30 хв без світла'));
  assert.ok(svg.includes('rotate(-90)'));
  assert.deepEqual(outageHalves(s['1.1'].confirmed).slice(18,24),
    [false,true,true,true,true,false]);
  assert.notEqual(graphicFingerprint(DATE,s,null),
    graphicFingerprint('2026-10-18',s,null));
});

test('rejects tentative schedules and paints no fake outages',()=>{
  const s=schedule();
  s['2.2'].mode='preset';
  assert.equal(hasConfirmedGraphic(s),false);
  assert.match(renderPinnedGraphicSvg(DATE,s),/Очікуємо підтверджений графік ДТЕК/);
});

test('emergency prominently warns only about known districts',()=>{
  const s=schedule();
  const emergency={active:true,kind:'екстрені',scope:'districts',districts:['Бучанський','Обухівський']};
  const svg=renderPinnedGraphicSvg(DATE,s,emergency);
  assert.match(svg,/Бучанський район/);
  assert.match(svg,/Обухівський район/);
  assert.match(svg,/не діють/);
  assert.match(pinnedPhotoCaption(DATE,true,emergency),/Екстрені відключення/);
  assert.notEqual(graphicFingerprint(DATE,s,null),graphicFingerprint(DATE,s,emergency));
});

test('sharp renders a valid PNG, within Telegram photo dimensions',async()=>{
  const buffer=await renderPinnedGraphicPng(DATE,schedule());
  assert.ok(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  assert.ok(buffer.length<8*1024*1024);
});

test('publish once, pin once, edit same photo on changes and next date',async()=>{
  const state={};const {sender,calls}=makeSender();let claims=0, saves=0;
  const args={state,date:DATE,byGroup:schedule(),sender,renderPng:png,
    save:async()=>{saves++;},claim:async()=>{claims++;return {claimed:true}},logger:silence};
  assert.equal((await publishPinnedGraphic(args)).status,'published');
  assert.equal(state.pinnedGraphic.messageId,77);
  assert.equal(state.pinnedGraphic.pinned,true);
  assert.deepEqual(calls.map(x=>x[0]),['send','pin']);
  assert.equal((await publishPinnedGraphic(args)).status,'unchanged');
  assert.equal(claims,1);
  args.byGroup=schedule(600,690);
  assert.equal((await publishPinnedGraphic(args)).status,'edited');
  assert.deepEqual(calls.map(x=>x[0]),['send','pin','edit']);
  assert.equal(calls[2][1],77);
  args.date='2026-10-18';
  assert.equal((await publishPinnedGraphic(args)).status,'edited');
  assert.equal(state.pinnedGraphic.messageId,77);
  assert.equal(claims,1);
  assert.ok(saves>=4);
});

test('retries failed pin of same photo without sending a replacement',async()=>{
  const state={};let failPin=true;const {sender,calls}=makeSender();
  sender.pin=async id=>{calls.push(['pin',id]);if(failPin)throw Error('not enough rights');};
  const args={state,date:DATE,byGroup:schedule(),sender,renderPng:png,
    save:async()=>{},claim:async()=>({claimed:true}),logger:silence};
  await assert.rejects(()=>publishPinnedGraphic(args),/not enough rights/);
  assert.equal(state.pinnedGraphic.messageId,77);
  assert.equal(state.pinnedGraphic.pinned,false);
  failPin=false;
  assert.equal((await publishPinnedGraphic(args)).status,'pinned');
  assert.equal(calls.filter(x=>x[0]==='send').length,1);
  assert.equal(calls.filter(x=>x[0]==='edit').length,0);
});

test('fixed remote claim blocks duplicate pinned photo after missing state',async()=>{
  const {sender,calls}=makeSender();
  const result=await publishPinnedGraphic({
    state:{},date:DATE,byGroup:schedule(),sender,renderPng:png,
    save:async()=>{},claim:async()=>({claimed:false}),logger:silence
  });
  assert.equal(result.status,'already-reserved');
  assert.equal(calls.length,0);
});

test('dry-run neither sends nor claims and returns a preview',async()=>{
  let invoked=false;
  const result=await publishPinnedGraphic({
    state:{},date:DATE,byGroup:schedule(),dryRun:true,logger:silence,
    claim:async()=>{invoked=true;return {claimed:true}}
  });
  assert.equal(result.status,'preview');
  assert.equal(invoked,false);
  assert.equal(PINNED_GRAPHIC_VERSION,1);
});
