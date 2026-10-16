import test from 'node:test';
import assert from 'node:assert/strict';
import {factUpdateKey,selectBestDtekSource} from '../src/source-selection.mjs';
const NOW=new Date('2026-10-16T08:15:00Z');
const hours=Object.fromEntries(Array.from({length:24},(_,i)=>[String(i+1),'yes']));
const names=Array.from({length:6},(_,i)=>['GPV'+(i+1)+'.1','GPV'+(i+1)+'.2']).flat();
function doc(update, tomorrow=false) {
  const fact={update,data:{}};
  const today=String(Date.parse('2026-10-16T08:00:00+03:00')/1000);
  fact.data[today]=Object.fromEntries(names.map(name=>[name,hours]));
  if(tomorrow) {
    const next=String(Date.parse('2026-10-17T08:00:00+03:00')/1000);
    fact.data[next]=Object.fromEntries(names.map(name=>[name,hours]));
  }
  return {regionId:'kyiv-region',fact,preset:{data:{}}};
}
test('compare only real DTEK fact.update times, not data retrieval timestamps',()=>{
  const direct=doc('16.10.2026 08:00');
  direct.lastUpdated=NOW.toISOString();
  const backup=doc('16.10.2026 10:30');
  backup.lastUpdated='2026-10-16T07:40:00Z';
  assert.ok(factUpdateKey(backup)>factUpdateKey(direct));
  assert.equal(selectBestDtekSource(direct,backup,NOW).kind,'backup');
});
test('direct remains primary for equal or newer actual schedule times',()=>{
  assert.equal(selectBestDtekSource(doc('16.10.2026 10:30'),doc('16.10.2026 10:30'),NOW).kind,'direct');
  assert.equal(selectBestDtekSource(doc('16.10.2026 10:30'),doc('16.10.2026 10:20'),NOW).kind,'direct');
});
test('newer tomorrow schedule in backup is not missed',()=>{
  const result=selectBestDtekSource(doc('16.10.2026 10:00'),doc('16.10.2026 10:00',true),NOW);
  assert.equal(result.kind,'backup');
  assert.match(result.reason,/tomorrow/);
});
test('one unavailable feed does not interrupt use of the other',()=>{
  assert.equal(selectBestDtekSource(null,doc('16.10.2026 10:00'),NOW).kind,'backup');
  assert.equal(selectBestDtekSource(doc('16.10.2026 10:00'),null,NOW).kind,'direct');
});
test('malformed upstream timestamps are never considered newer',()=>{
  assert.equal(factUpdateKey(doc('not a timestamp')),null);
  assert.equal(factUpdateKey(doc('32.10.2026 08:00')),null);
  assert.equal(factUpdateKey(doc('16.13.2026 08:00')),null);
  assert.equal(selectBestDtekSource(doc('bad'),doc('16.10.2026 10:30'),NOW).kind,'direct');
});
