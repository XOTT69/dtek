import test from 'node:test';
import assert from 'node:assert/strict';
import { claimReminder } from '../src/reminder-claim.mjs';

const opts = {
  token: 'TEST_ONLY_FAKE_TOKEN',
  repo: 'example/dtek',
  branch: 'main',
  now: new Date('2026-10-16T08:04:00Z')
};

test('first worker atomically reserves a future reminder; subsequent workers see existing claim', async () => {
  const files = new Map();
  const requests = [];
  const fetchFn = async (url, request) => {
    requests.push({ url, method: request.method || 'GET' });
    if (request.method === 'PUT') {
      const claim = JSON.parse(request.body);
      assert.ok(claim.content);
      assert.ok(claim.message.includes('11:30#pre30'));
      if (files.has(url)) return { status: 422, ok: false };
      files.set(url, claim.content);
      return { status: 201, ok: true };
    }
    const path = url.split('?')[0];
    return { status: files.has(path) ? 200 : 404, ok: files.has(path) };
  };
  const key = '2026-10-16@11:30#pre30';
  const first = await claimReminder(key, { ...opts, fetchFn });
  assert.equal(first.claimed, true);
  assert.equal(first.path, 'state/reminder-claims/2026-10-16/11-30.json');
  const second = await claimReminder(key, { ...opts, fetchFn });
  assert.equal(second.claimed, false);
  assert.equal(files.size, 1);
  assert.equal(requests.length, 3);
});

test('never send if the claim could not be verified on GitHub', async () => {
  const key = '2026-10-16@12:00#pre30';
  const fetchFn = async () => ({ status: 422, ok: false });
  await assert.rejects(claimReminder(key, { ...opts, fetchFn }), /conflict without existing claim/);
  await assert.rejects(claimReminder(key, {
    ...opts, fetchFn: async () => ({ status: 403, ok: false })
  }), /refusing to repost/);
});

test('missing credentials or malformed keys fail closed without API request', async () => {
  const fake = async () => { throw new Error('API should not have been called'); };
  await assert.rejects(claimReminder('2026-10-16@11:30#pre30', {
    ...opts, token: '', fetchFn: fake
  }), /Missing GitHub credentials/);
  await assert.rejects(claimReminder('../danger', { ...opts, fetchFn: fake }), /Unsafe/);
});
