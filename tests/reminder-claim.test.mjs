import test from 'node:test';
import assert from 'node:assert/strict';
import { claimReminder, claimScheduleUpdate, claimCorrection, claimUkrenergoNotice } from '../src/reminder-claim.mjs';

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

test('same confirmed daily schedule hash is claimed exactly once across independent runs', async () => {
  const existing = new Set();
  const fetchFn = async (url, options) => {
    const resource = url.split('?')[0];
    if (options.method === 'PUT') {
      if (existing.has(resource)) return {status: 422, ok: false};
      existing.add(resource);
      return {status: 201, ok: true};
    }
    return {status: existing.has(resource) ? 200 : 404, ok: existing.has(resource)};
  };
  const hash = 'a'.repeat(64);
  const key = '2026-10-16/сьогодні/all';
  const first = await claimScheduleUpdate(key, hash, {...opts, fetchFn});
  const second = await claimScheduleUpdate(key, hash, {...opts, fetchFn});
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.match(first.path, /state\/schedule-claims\/2026-10-16\/today-all-/);
  assert.equal(existing.size, 1);
  const changed = await claimScheduleUpdate(key, 'b'.repeat(64), {...opts, fetchFn});
  assert.equal(changed.claimed, true);
  assert.equal(existing.size, 2);
});

test('legitimate graph reversal A→B→A can be announced again, never twice',async()=>{
  const seen=new Set(),fetchFn=async(url,request)=>{
    const key=url.split('?')[0];
    if(request.method==='PUT') {
      if(seen.has(key))return {status:422,ok:false};
      seen.add(key);
      return {status:201,ok:true};
    }
    return {status:seen.has(key)?200:404,ok:seen.has(key)};
  };
  const key='2026-10-17/сьогодні/all',a='a'.repeat(64),b='b'.repeat(64);
  const first=await claimScheduleUpdate(key,a,{...opts,fetchFn,revision:0});
  const change=await claimScheduleUpdate(key,b,{...opts,fetchFn,revision:1});
  const restore=await claimScheduleUpdate(key,a,{...opts,fetchFn,revision:2});
  const repeated=await claimScheduleUpdate(key,a,{...opts,fetchFn,revision:2});
  assert.equal(first.claimed,true);
  assert.equal(change.claimed,true);
  assert.equal(restore.claimed,true);
  assert.equal(repeated.claimed,false);
  assert.equal(seen.size,3);
  assert.equal(first.path.includes('-r0'),false);
  assert.match(change.path,/-r1\.json$/);
  assert.match(restore.path,/-r2\.json$/);
  await assert.rejects(claimScheduleUpdate(key,a,{...opts,fetchFn,revision:-1}),
    /Unsafe DTEK schedule revision/);
});

test('schedule claim rejects malicious keys and invalid fingerprints', async () => {
  await assert.rejects(claimScheduleUpdate('../etc/passwords', 'c'.repeat(64)), /Unsafe/);
  await assert.rejects(claimScheduleUpdate('2026-10-16/сьогодні/all', 'short'), /Unsafe/);
});

test('correction is claimed once for a given confirmed revision and slot', async()=>{
  const seen = new Set();
  const fetchFn = async (url, options) => {
    const base = url.split('?')[0];
    if (options.method === 'PUT') {
      if (seen.has(base)) return {status:422,ok:false};
      seen.add(base);
      return {status:201,ok:true};
    }
    return {status:seen.has(base)?200:404,ok:seen.has(base)};
  };
  const hash='c'.repeat(64);
  const first=await claimCorrection('2026-10-16',690,hash,{...opts,fetchFn});
  const again=await claimCorrection('2026-10-16',690,hash,{...opts,fetchFn});
  assert.equal(first.claimed,true);
  assert.equal(again.claimed,false);
  assert.match(first.path,/correction-claims\/2026-10-16\/11-30-/);
  assert.equal((await claimCorrection('2026-10-16',690,'d'.repeat(64),{...opts,fetchFn})).claimed,true);
  assert.equal(seen.size,2);
});

test('initial Ukrenergo announcement is reserved only once per day', async()=>{
  const seen=new Set();
  const fetchFn=async (url,opts)=>{
    const key=url.split('?')[0];
    if(opts.method==='PUT'){
      if(seen.has(key))return {ok:false,status:422};
      seen.add(key);return {ok:true,status:201};
    }
    return {ok:seen.has(key),status:seen.has(key)?200:404};
  };
  const a=await claimUkrenergoNotice('2026-10-17',{...opts,fetchFn});
  const b=await claimUkrenergoNotice('2026-10-17',{...opts,fetchFn});
  assert.equal(a.claimed,true);
  assert.equal(b.claimed,false);
  assert.equal(seen.size,1);
  await assert.rejects(claimUkrenergoNotice('2026/10/17',{...opts,fetchFn}),/Unsafe/);
});
