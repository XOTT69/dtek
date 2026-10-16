import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidateLegacyPost, expandFullPostToSplit } from '../src/consolidate.mjs';
import { decideDailyPublication } from '../src/daily-publication.mjs';

test('old two-part posts become a single post without sending notifications', async () => {
  const state = { publications: {
    '2026-10-16/сьогодні/1.1-3.2': { messageId: 5 },
    '2026-10-16/сьогодні/4.1-6.2': { messageId: 6 }
  }};
  const calls = [];
  const sender = {
    edit: async (id, message) => { calls.push(['edit', id, message]); return true; },
    delete: async id => { calls.push(['delete', id]); return true; }
  };
  const input = {
    state,
    fragment: { key: '2026-10-16/сьогодні/all', message: 'Confirmed, 12 groups' },
    hash: 'newhash',
    sender,
    save: async () => {},
    log: {log() {}, warn() {}}
  };
  assert.equal(await consolidateLegacyPost(input), true);
  assert.deepEqual(calls, [
    ['edit', 5, 'Confirmed, 12 groups'],
    ['delete', 6]
  ]);
  assert.equal(state.publications['2026-10-16/сьогодні/all'].messageId, 5);
  assert.equal(Object.keys(state.publications).length, 1);
  assert.equal(await consolidateLegacyPost(input), true);
  assert.equal(calls.length, 2);
});

test('if there are no previous posts, initial publication is left unchanged', async () => {
  const state = { publications: {} };
  const result = await consolidateLegacyPost({
    state,
    fragment: { key: '2026-10-16/сьогодні/all', message: 'Confirmed, 12 groups' },
    hash: 'hash',
    sender: { edit() { throw Error('no edit'); }, delete() { throw Error('no delete'); } },
    save: async () => {}
  });
  assert.equal(result, false);
});

test('failed deletion is retried without reposting', async () => {
  const state = { publications: {
    '2026-10-16/сьогодні/all': { hash:'x', messageId: 5 },
    '2026-10-16/сьогодні/4.1-6.2': { messageId: 6 }
  }};
  let attempts = 0;
  const sender = {
    edit() { throw Error('Should not edit again'); },
    async delete() {
      attempts++;
      if (attempts === 1) throw Error('temporary deletion failure');
      return true;
    }
  };
  const input = {
    state, fragment: {key:'2026-10-16/сьогодні/all',message:'Complete'}, hash:'x',
    sender, save:async () => {}, log: {log() {},warn() {}}
  };
  await consolidateLegacyPost(input);
  assert.ok(state.publications['2026-10-16/сьогодні/4.1-6.2']);
  await consolidateLegacyPost(input);
  assert.equal(state.publications['2026-10-16/сьогодні/4.1-6.2'], undefined);
});


test('split to full after a genuine change edits one post but never sends a duplicate full announcement',async()=>{
  const state={publications:{
    '2026-10-17/сьогодні/1.1-3.2':{
      messageId:15,revision:0,headingState:'initial',formatVersion:7
    },
    '2026-10-17/сьогодні/4.1-6.2':{
      messageId:16,revision:0,headingState:'initial',formatVersion:7
    }
  }};
  const calls=[];
  const sender={
    edit:async(id,text)=>calls.push(['edit',id,text]),
    delete:async(id)=>calls.push(['delete',id])
  };
  const fragment={key:'2026-10-17/сьогодні/all',
    message:'💡<b>Оновлений графік відключення світла на сьогодні.</b>'};
  const emergency='\n⚠️ Надзвичайні відключення у визначених районах.';
  const context=JSON.stringify({active:true,districts:['Фастівський']});
  const input={
    state,fragment,hash:'hash-rev2',sender,save:async()=>{},
    revision:2,headingState:'updated',advisory:emergency,
    emergencyContextKey:context,log:{log(){},warn(){}}
  };
  assert.equal(await consolidateLegacyPost(input),true);
  assert.deepEqual(calls,[
    ['edit',15,fragment.message+emergency],['delete',16]
  ]);
  const current=state.publications[fragment.key];
  assert.equal(current.revision,2);
  assert.equal(current.headingState,'updated');
  assert.equal(current.formatVersion,7);
  assert.equal(current.emergencyContextKey,context);
  assert.equal(decideDailyPublication(current,'hash-rev2',2,'updated'),'unchanged');
  assert.equal(await consolidateLegacyPost(input),true);
  assert.equal(calls.length,2,'no additional notifications for an unchanged graph');
});

test('split-to-one migration keeps initial heading if no real source revision occurred',async()=>{
  const state={publications:{
    '2026-10-17/завтра/1.1-3.2':{messageId:7,revision:0},
    '2026-10-17/завтра/4.1-6.2':{messageId:8,revision:0}
  }};
  const edits=[];
  await consolidateLegacyPost({
    state,fragment:{key:'2026-10-17/завтра/all',
      message:'💡<b>Графік відключення світла на завтра.</b>'},
    hash:'h0',revision:0,headingState:'initial',
    sender:{edit:async(id,msg)=>edits.push([id,msg]),
      delete:async()=>true},
    save:async()=>{}
  });
  assert.equal(state.publications['2026-10-17/завтра/all'].revision,0);
  assert.equal(decideDailyPublication(
    state.publications['2026-10-17/завтра/all'],'h0',0,'initial'
  ),'unchanged');
  assert.equal(edits[0][0],7);
  assert.doesNotMatch(edits[0][1],/Оновлений/);
});


test('full daily post expanding into two chunks reuses the original message for first part',async()=>{
  const state={publications:{
    '2026-10-17/сьогодні/all':{
      hash:'oldfull',revision:0,formatVersion:7,headingState:'initial',messageId:125
    }
  }};
  const fragments=[
    {key:'2026-10-17/сьогодні/1.1-3.2',
      message:'💡<b>Оновлений графік відключення світла на сьогодні.</b>\nЧастина 1',
      fingerprint:'split-fragment-1'},
    {key:'2026-10-17/сьогодні/4.1-6.2',
      message:'💡<b>Оновлений графік відключення світла на сьогодні.</b>\nЧастина 2',
      fingerprint:'split-fragment-2'}
  ];
  const edits=[],stateWrites=[];
  const sender={edit:async(id,message)=>edits.push({id,message})};
  const save=async()=>stateWrites.push(JSON.stringify(state));
  const emergency='⚠️ Екстрені відключення діють у визначених районах';
  const status=JSON.stringify({active:true,districts:['Обухівський']});
  const options={state,fragments,sender,save,revision:1,
    headingState:'updated',advisory:emergency,
    emergencyContextKey:status,log:{log(){}}};
  assert.equal(await expandFullPostToSplit(options),true);
  assert.deepEqual(edits,[{id:125,message:fragments[0].message+emergency}]);
  assert.equal(stateWrites.length,1);
  assert.equal(state.publications['2026-10-17/сьогодні/all'],undefined);
  const first=state.publications[fragments[0].key];
  assert.equal(first.messageId,125);
  assert.equal(first.revision,1);
  assert.equal(first.headingState,'updated');
  assert.equal(first.emergencyContextKey,status);
  assert.equal(decideDailyPublication(first,first.hash,1,'updated'),'unchanged');
  assert.equal(state.publications[fragments[1].key],undefined,
    'second part is only created through normal atomic publisher');
  assert.equal(await expandFullPostToSplit(options),false);
  assert.equal(edits.length,1);
});

test('never attempt expansion without an owned prior full-day Telegram message',async()=>{
  const fragments=[
    {key:'2026-10-17/завтра/1.1-3.2',message:'part1',fingerprint:'a'},
    {key:'2026-10-17/завтра/4.1-6.2',message:'part2',fingerprint:'b'}
  ];
  const state={publications:{}};
  const noop={edit:async()=>{throw Error('Must not edit missing full post')}};
  assert.equal(await expandFullPostToSplit({
    state,fragments,sender:noop,save:async()=>{}
  }),false);
  assert.equal(await expandFullPostToSplit({
    state,fragments:[fragments[0]],sender:noop,save:async()=>{}
  }),false);
});
