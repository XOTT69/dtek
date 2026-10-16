import test from 'node:test';
import assert from 'node:assert/strict';
import { consolidateLegacyPost } from '../src/consolidate.mjs';

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
