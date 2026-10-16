import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSource, fetchSourceJson } from '../src/source.mjs';

const NOW = new Date('2026-10-16T06:10:00.000Z');

function fixture(updated, statusOk = true) {
  return {
    regionId: 'kyiv-region',
    lastUpdated: updated,
    fact: { update: '16.10.2026 07:50', data: { '1792098000': { GPV1_2: {} } } },
    preset: { data: { 'GPV1.2': {} } },
    lastUpdateStatus: { status: statusOk ? 'parsed' : 'error', ok: statusOk }
  };
}

test('A transient parser error does not erase retained recent schedules', () => {
  const raw = fixture('2026-10-16T05:56:00Z', false);
  const result = validateSource(raw, NOW);
  assert.equal(result.isFallback, true);
  assert.equal(result.ageMinutes, 14);
  assert.equal(result.data, raw);
});

test('Freshly parsed source works unchanged', () => {
  const result = validateSource(fixture('2026-10-16T06:00:00Z'), NOW);
  assert.equal(result.isFallback, false);
  assert.equal(result.ageMinutes, 10);
});

test('Never publish stale saved schedules', () => {
  assert.throws(
    () => validateSource(fixture('2026-10-15T06:00:00Z', false), NOW),
    /stale/
  );
});

test('Reject missing and malformed data, including future timestamps', () => {
  assert.throws(() => validateSource({}, NOW), /incomplete/);
  assert.throws(() => validateSource(fixture('not-a-date'), NOW), /invalid/);
  assert.throws(() => validateSource(fixture('2026-10-17T06:00:00Z'), NOW), /future/);
  const empty = fixture('2026-10-16T06:00:00Z');
  empty.fact.data = {};
  empty.preset.data = {};
  assert.throws(() => validateSource(empty, NOW), /No usable/);
});

test('Fetch source JSON with valid response and retries transient failure', async () => {
  let attempts = 0;
  const doc = fixture('2026-10-16T06:00:00Z');
  const fetchFn = async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary connection reset');
    return { ok: true, json: async () => doc };
  };
  const result = await fetchSourceJson('https://example.test/kyiv-region.json', fetchFn, 2);
  assert.equal(attempts, 2);
  assert.deepEqual(result, doc);
});
