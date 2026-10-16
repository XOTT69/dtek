import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS } from '../src/schedule.mjs';
import { confirmedDayForSync, recordConfirmedDay } from '../src/confirmed-feed.mjs';

const make=(mode='fact')=>Object.fromEntries(GROUPS.map((group,i)=>[
  group,{mode,confirmed: i===1?[{start:60,end:90,minutes:30}]:
    i===3?[{start:540,end:600,minutes:60}]:[]}
]));

test('verified public DTEK feed contains all 12 groups, including 1.2 and 2.2',()=>{
  const s=confirmedDayForSync(make());
  assert.deepEqual(Object.keys(s),GROUPS);
  assert.deepEqual(s['1.2'],[[60,90]]);
  assert.deepEqual(s['2.2'],[[540,600]]);
  assert.deepEqual(s['3.2'],[]);
});

test('fact-only feed refuses tentative, partial or malformed schedules',()=>{
  const maybe=make();maybe['1.2'].mode='preset';
  assert.equal(confirmedDayForSync(maybe),null);
  const partial=make();delete partial['4.1'];
  assert.equal(confirmedDayForSync(partial),null);
  const invalid=make();invalid['2.2'].confirmed=[{start:500,end:600}];
  assert.equal(confirmedDayForSync(invalid),null);
  const overlaps=make();overlaps['2.2'].confirmed=[
    {start:540,end:630},{start:600,end:660}];
  assert.equal(confirmedDayForSync(overlaps),null);
});

test('unchanged confirmed facts do not rewrite public feed; tomorrow stored independently',()=>{
  const state={publications:{},scheduleSnapshots:{}};
  const today='2026-10-17',tomorrow='2026-10-18';
  assert.equal(recordConfirmedDay(state,today,make()),true);
  assert.equal(recordConfirmedDay(state,today,make()),false);
  assert.equal(recordConfirmedDay(state,tomorrow,make('preset')),false);
  assert.equal(state.confirmedSchedules[tomorrow],undefined);
  const revised=make();revised['1.2'].confirmed=[{start:120,end:180}];
  assert.equal(recordConfirmedDay(state,tomorrow,revised),true);
  assert.deepEqual(state.confirmedSchedules[tomorrow]['1.2'],[[120,180]]);
  assert.deepEqual(state.confirmedSchedules[today]['1.2'],[[60,90]]);
});
