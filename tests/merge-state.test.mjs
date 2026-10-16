import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeState} from '../src/merge-state.mjs';

test('three-way state merge preserves independent emergency, reminder and new schedule changes',()=>{
  const base={
    publications:{'today':{messageId:16,hash:'x'}},
    events:{'11:30':{messageId:14}},
    emergency:{status:{active:false},lastId:2}
  };
  const local=structuredClone(base);
  local.emergency={status:{active:true,districts:['Бучанський']},lastId:3};
  local.publications.today.emergencyContextKey='active';
  const remote=structuredClone(base);
  remote.events['18:00']={messageId:25};
  remote.publications.tomorrow={messageId:26,hash:'z'};
  const result=mergeState(base,local,remote);
  assert.equal(result.emergency.lastId,3);
  assert.equal(result.publications.today.emergencyContextKey,'active');
  assert.equal(result.publications.tomorrow.messageId,26);
  assert.equal(result.events['18:00'].messageId,25);
  assert.equal(result.events['11:30'].messageId,14);
});

test('remote update wins on conflict, local changed-only fields remain',()=>{
  const base={publications:{today:{messageId:16,hash:'old'}}};
  const local={publications:{today:{messageId:16,hash:'new-local',emergencyEditedAt:'today'}}};
  const remote={publications:{today:{messageId:17,hash:'new-remote'}}};
  const merged=mergeState(base,local,remote);
  assert.equal(merged.publications.today.messageId,17);
  assert.equal(merged.publications.today.hash,'new-remote');
  assert.equal(merged.publications.today.emergencyEditedAt,'today');
});

test('remote deletes are respected when local branch changed same entry',()=>{
  const base={events:{old:{messageId:9}}};
  const local={events:{old:{messageId:9,formatVersion:6}}};
  const remote={events:{}};
  assert.deepEqual(mergeState(base,local,remote),{events:{}});
});

test('local deletions respected if remote has not changed',()=>{
  const base={events:{old:{messageId:9},new:{messageId:20}}};
  const local={events:{new:{messageId:20}}};
  const remote=structuredClone(base);
  assert.deepEqual(mergeState(base,local,remote),local);
});
