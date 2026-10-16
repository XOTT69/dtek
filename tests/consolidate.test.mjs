import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidateLegacyPost } from '../src/consolidate.mjs';
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
