import test from 'node:test';
import assert from 'node:assert/strict';
import { decideDailyPublication } from '../src/daily-publication.mjs';
import { publicationFingerprint, GROUPS, windowsFromHours } from '../src/schedule.mjs';

const msg = {messageId:45,hash:'a',revision:0,headingState:'initial',formatVersion:7};

test('the first confirmed graph is a normal initial publication',()=>{
  assert.equal(decideDailyPublication(null,'a',0,'initial'),'publish');
  assert.equal(decideDailyPublication(undefined,'a',0,'initial'),'publish');
});

test('same graph checked every five minutes does not create new messages',()=>{
  assert.equal(decideDailyPublication(msg,'a',0,'initial'),'unchanged');
  assert.equal(decideDailyPublication({...msg,hash:'old-metadata-hash'},'a',0,'initial'),'edit');
});

test('migration fixes a wrongly labelled old message IN PLACE',()=>{
  const old={messageId:27,hash:'a',formatVersion:6};
  assert.equal(decideDailyPublication(old,'a',0,'initial'),'edit');
});

test('only a later real fact revision deserves a new schedule announcement',()=>{
  assert.equal(decideDailyPublication(msg,'b',1,'updated'),'publish');
  assert.equal(decideDailyPublication({...msg,revision:1,headingState:'updated',hash:'b'},
    'b',1,'updated'),'unchanged');
  assert.equal(decideDailyPublication({...msg,revision:1,headingState:'updated',hash:'b'},
    'b',2,'updated'),'publish');
});

test('text formatting and emergency annotations are not a source revision',()=>{
  const existing={messageId:22,hash:'h',revision:2,
    headingState:'updated',formatVersion:7};
  assert.equal(decideDailyPublication(existing,'metadata-changed',2,'updated'),'edit');
  assert.equal(decideDailyPublication(existing,'h',2,'initial'),'edit');
});

test('publication fingerprint uses confirmed visible times only',()=>{
  const on = Object.fromEntries(Array.from({length:24},(_,i)=>[String(i+1),'yes']));
  const off = {...on,'18':'no'};
  const base=Object.fromEntries(GROUPS.map(g=>[
    g,{mode:'fact',...windowsFromHours(g==='1.2'?off:on)}
  ]));
  const copy=structuredClone(base);
  copy['1.2'].possible.push({start:420,end:480,minutes:60});
  copy['3.1'].mode='temporary-provider-metadata';
  copy['3.1'].providerLastUpdated='2026-10-17T18:07:00Z';
  assert.equal(publicationFingerprint('2026-10-17',base),
    publicationFingerprint('2026-10-17',copy));
  copy['1.2'].confirmed[0]={start:1050,end:1080,minutes:30};
  assert.notEqual(publicationFingerprint('2026-10-17',base),
    publicationFingerprint('2026-10-17',copy));
});

test('midnight changes only the day label, not the revision number',()=>{
  const yesterday={messageId:4,hash:'x',revision:0,
    headingState:'initial',formatVersion:7};
  assert.equal(decideDailyPublication(yesterday,'x',0,'initial'),'unchanged');
  assert.equal(decideDailyPublication(yesterday,'x',0,'updated'),'edit');
});
