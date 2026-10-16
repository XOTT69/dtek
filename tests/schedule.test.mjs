import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kyivDate, addDays, weekdayIndex, formatDate, keyToKyivDate,
  windowsFromHours, resolveSchedule, renderTelegram, renderDailyMessages, buildTransition,
  renderTransitionTelegram, kyivMinutes, GROUPS, publicationFingerprint
} from '../src/schedule.mjs';

function slots(defaultValue = 'yes') {
  return Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), defaultValue]));
}

test('half-hour codes combine into the correct outage interval', () => {
  const data = slots();
  data['10'] = 'second';
  data['11'] = 'no';
  data['12'] = 'first';
  assert.deepEqual(windowsFromHours(data).confirmed, [
    { start: 570, end: 690, minutes: 120 }
  ]);
});

test('group 2.2 sample is 09:00–11:30 and 18:00–22:00', () => {
  const data = slots();
  data['10'] = 'no'; data['11'] = 'no'; data['12'] = 'first';
  for (let i = 19; i <= 22; i++) data[String(i)] = 'no';
  const windows = windowsFromHours(data).confirmed;
  assert.deepEqual(windows, [
    { start: 540, end: 690, minutes: 150 },
    { start: 1080, end: 1320, minutes: 240 }
  ]);
});

test('half-hour forecast codes stay tentative', () => {
  const data = slots();
  data['1'] = 'mfirst';
  data['2'] = 'msecond';
  const result = windowsFromHours(data, true);
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.possible, [
    { start: 0, end: 30, minutes: 30 },
    { start: 90, end: 120, minutes: 30 }
  ]);
});

test('Ukraine local date and DST changes', () => {
  assert.equal(kyivDate(new Date('2026-10-15T21:00:00Z')), '2026-10-16');
  assert.equal(keyToKyivDate(1792098000), '2026-10-16');
  assert.equal(addDays('2026-10-24', 1), '2026-10-25');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekdayIndex('2026-10-16'), 5);
  assert.equal(formatDate('2026-10-16'), "П'ятниця, 16.10.2026");
});

test('actual daily fact overrides weekly forecast, tomorrow is tentative', () => {
  const fact = slots(); fact['10'] = 'no';
  const forecast = slots('maybe');
  const doc = {
    regionId: 'kyiv-region', lastUpdated: '2026-10-16T05:35:58Z',
    fact: { update: '16.10.2026 07:50', data: { '1792098000': { 'GPV1.2': fact, 'GPV2.2': fact } } },
    preset: { data: { 'GPV1.2': { '6': forecast }, 'GPV2.2': { '6': forecast } } }
  };
  const current = resolveSchedule(doc, '2026-10-16', '2.2');
  const next = resolveSchedule(doc, '2026-10-17', '2.2');
  assert.equal(current.mode, 'fact');
  assert.equal(current.confirmed[0].start, 540);
  assert.equal(next.mode, 'preset');
  assert.equal(next.confirmed.length, 0);
  assert.equal(next.possible[0].minutes, 1440);
  const message = renderTelegram('2026-10-17', 'завтра', { '1.2': next, '2.2': next }, doc);
  assert.match(message, /Можливі відключення/);
  assert.match(message, /Підгрупа 1\.2/);
  assert.match(message, /Підгрупа 2\.2/);
  assert.match(message, /24\.0 год/);
  assert.equal(publicationFingerprint('2026-10-17', { '1.2': next, '2.2': next }),
    publicationFingerprint('2026-10-17', { '1.2': next, '2.2': next }));
});

test('reject malformed or unknown states, never invent a confirmed plan', () => {
  const bad = slots(); bad['5'] = 'UNKNOWN';
  assert.throws(() => windowsFromHours(bad), /Unknown/);
  const doc = { regionId: 'kyiv-region', fact: { data: {} }, preset: { data: {} } };
  assert.equal(resolveSchedule(doc, '2026-10-17', '1.2').mode, 'missing');
});


test('all 12 groups are supported and announcements split safely', () => {
  assert.deepEqual(GROUPS, ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2',
    '4.1', '4.2', '5.1', '5.2', '6.1', '6.2']);
  const doc = { regionId: 'kyiv-region', fact: { update: '16.10.2026 09:00', data: {} }, preset: { data: {} } };
  const byGroup = Object.fromEntries(GROUPS.map(group => [
    group, { mode: 'fact', ...windowsFromHours(slots('no')) }
  ]));
  const messages = renderDailyMessages('2026-10-16', 'сьогодні', byGroup, doc);
  assert.equal(messages.length, 2);
  assert.ok(messages.every(p => p.message.length < 4096));
  assert.match(messages[0].message, /Підгрупа 1\.1/);
  assert.match(messages[1].message, /Підгрупа 6\.2/);
  assert.doesNotMatch(messages[0].message, /Підгрупа 6\.2/);
});

test('half-hour transition alerts distinguish start, end and still off', () => {
  const alwaysOn = slots();
  const starts = slots(); starts['10'] = 'second';
  const ends = slots(); ends['10'] = 'first';
  const continuing = slots(); continuing['10'] = 'no';
  const byGroup = Object.fromEntries(GROUPS.map(g => [g, {
    mode: 'fact', ...windowsFromHours(alwaysOn)
  }]));
  byGroup['1.2'] = { mode: 'fact', ...windowsFromHours(starts) };
  byGroup['2.2'] = { mode: 'fact', ...windowsFromHours(continuing) };
  byGroup['3.1'] = { mode: 'fact', ...windowsFromHours(ends) };
  const transition = buildTransition(byGroup, 570);
  assert.deepEqual(transition.starting, ['1.2']);
  assert.deepEqual(transition.continuing, ['2.2']);
  assert.deepEqual(transition.restored, ['3.1']);
  const message = renderTransitionTelegram('2026-10-16', transition, '@svitlo_kyivshchyna');
  assert.match(message, /09:30/);
  assert.match(message, /1\.2 підгрупа/);
  assert.match(message, /Завершення планового відключення/);
  assert.match(message, /залишаються без світла/);
  assert.match(message, /https:\/\/t.me\/svitlo_kyivshchyna/);
  assert.equal(buildTransition(byGroup, 0), null);
  assert.equal(buildTransition(byGroup, 585), null);
});

test('tentative forecast must never trigger half-hour change alerts', () => {
  const forecast = slots('maybe');
  const byGroup = Object.fromEntries(GROUPS.map(g => [g, {
    mode: 'preset', ...windowsFromHours(forecast, true)
  }]));
  assert.equal(buildTransition(byGroup, 570), null);
  assert.equal(kyivMinutes(new Date('2026-10-16T06:30:00Z')), 570);
});
