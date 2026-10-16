import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DTEK_AJAX, DTEK_PAGE, parseDtekHtml, normalizeDtekData, fetchDtekDirect
} from '../src/dtek-direct.mjs';

const NOW = new Date('2026-10-16T06:10:00Z');
const START = Math.floor(Date.parse('2026-10-16T08:00:00+03:00') / 1000);
const groups = Array.from({length: 6}, (_, i) => [
  'GPV' + (i + 1) + '.1', 'GPV' + (i + 1) + '.2'
]).flat();
const hourSlots = () => Object.fromEntries(
  Array.from({length: 24}, (_, i) => [String(i + 1), i === 9 ? 'no' : 'yes'])
);
function fixture() {
  return {
    fact: {update:'16.10.2026 08:00',data: {
      [String(START)]: Object.fromEntries(groups.map(group => [group, hourSlots()]))
    }},
    preset: {data:{}}
  };
}
const jsonResponse = payload => ({
  ok: true, status: 200, text: async () => JSON.stringify(payload)
});

test('realistic AJAX response yields all 12 confirmed DTEK groups', async () => {
  const requested = [];
  const result = await fetchDtekDirect({
    now: NOW,
    fetchFn: async (url, config) => {
      requested.push({ url, config });
      return jsonResponse(fixture());
    }
  });
  assert.equal(result.via, 'ajax');
  assert.deepEqual(result.validDates, ['2026-10-16']);
  assert.equal(Object.keys(result.data.fact.data[String(START)]).length, 12);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, DTEK_AJAX);
  assert.match(requested[0].config.body, /checkDisconUpdate/);
});

test('AJAX failure falls back to direct embedded HTML on official website', async () => {
  const source = fixture();
  const html = '<html><body><script>DisconSchedule.fact = ' +
    JSON.stringify(source.fact) + '; DisconSchedule.preset = ' +
    JSON.stringify(source.preset) + ';</script></body></html>';
  const requests = [];
  const result = await fetchDtekDirect({
    now: NOW,
    fetchFn: async url => {
      requests.push(url);
      if (url === DTEK_AJAX) return { ok: false, status: 403 };
      return { ok: true, status: 200, text: async () => html };
    }
  });
  assert.equal(result.via, 'html');
  assert.deepEqual(result.validDates, ['2026-10-16']);
  assert.deepEqual(requests, [DTEK_AJAX, DTEK_PAGE]);
  assert.deepEqual(parseDtekHtml(html).fact, source.fact);
});

test('JSON extractor handles nested values and curly braces in quoted strings', () => {
  const source = fixture();
  source.fact.note = 'note with } braces and \\"quoted\\" values';
  const html = ' '.repeat(90) + '<script>DisconSchedule.fact = ' +
    JSON.stringify(source.fact) + '; DisconSchedule.preset = ' +
    JSON.stringify(source.preset) + ';</script>';
  assert.deepEqual(parseDtekHtml(html).fact, source.fact);
});

test('never evaluate arbitrary website scripts', () => {
  const attack = '<html>' + ' '.repeat(90) +
    '<script>DisconSchedule.fact = {data: (process.exit(123))};</script></html>';
  assert.throws(() => parseDtekHtml(attack), /JSON|Unexpected|property|Expected/i);
});

test('missing or incomplete confirmed groups are not published as valid', () => {
  const raw = fixture();
  const date = String(START);
  delete raw.fact.data[date]['GPV6.2'];
  assert.throws(
    () => normalizeDtekData(raw, NOW),
    /no complete confirmed schedule/
  );
});

test('old dates or weekly preset only cannot replace current confirmed schedules', () => {
  const raw = fixture();
  const old = String(Math.floor(Date.parse('2026-10-13T08:00:00+03:00') / 1000));
  raw.fact.data = {[old]: raw.fact.data[String(START)]};
  assert.throws(
    () => normalizeDtekData(raw, NOW),
    /no complete confirmed schedule/
  );
});

test('if both official DTEK routes are unavailable an explanatory error is thrown', async () => {
  await assert.rejects(
    fetchDtekDirect({
      now: NOW,
      fetchFn: async () => ({ok:false, status:403})
    }),
    /Direct DTEK temporarily unavailable/
  );
});
