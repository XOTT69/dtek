import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kyivDate, addDays, weekdayIndex, formatDate, keyToKyivDate,
  windowsFromHours, resolveSchedule, renderTelegram, renderDailyMessages, buildTransition, upcomingTransition,
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

test('forecast can be parsed but is NEVER eligible for publishing', () => {
  const fact = slots(); fact['10'] = 'no';
  const forecast = slots('maybe');
  const doc = {
    regionId: 'kyiv-region', lastUpdated: '2026-10-16T05:35:58Z',
    fact: { update: '16.10.2026 07:50', data: {
      '1792098000': Object.fromEntries(GROUPS.map(group => ['GPV' + group, fact]))
    } },
    preset: { data: Object.fromEntries(GROUPS.map(group => ['GPV' + group, { '6': forecast }])) }
  };
  const todayGroups = Object.fromEntries(GROUPS.map(group => [group, resolveSchedule(doc, '2026-10-16', group)]));
  const tomorrowGroups = Object.fromEntries(GROUPS.map(group => [group, resolveSchedule(doc, '2026-10-17', group)]));
  assert.equal(todayGroups['1.2'].mode, 'fact');
  assert.equal(tomorrowGroups['1.2'].mode, 'preset');
  assert.deepEqual(renderDailyMessages('2026-10-17', 'завтра', tomorrowGroups, doc), []);
  assert.throws(() => renderTelegram('2026-10-17', 'завтра', tomorrowGroups, doc), /Only confirmed/);
  assert.equal(renderDailyMessages('2026-10-16', 'сьогодні', todayGroups, doc).length, 1);
});

test('confirmed post contains only schedules without source/footer/disclaimer', () => {
  const hours = slots('yes');
  hours['10'] = 'no';
  const byGroup = Object.fromEntries(GROUPS.map(group => [
    group, { mode: 'fact', ...windowsFromHours(hours) }
  ]));
  const messages = renderDailyMessages('2026-10-16', 'сьогодні', byGroup, {});
  assert.equal(messages.length, 1);
  for (const fragment of messages) {
    assert.match(fragment.message, /Оновлений графік/);
    assert.match(fragment.message, /Разом без світла/);
    assert.match(fragment.message, /💡<b>Підгрупа 1\.1 відключення:<\/b>/);
    assert.match(fragment.message, /❌з 09:00 до 10:00 \(1\.0 год\)/);
    assert.match(fragment.message, /⚫ <b>Разом без світла: 1\.0 год<\/b>/);
    assert.doesNotMatch(fragment.message, /🪫 |🔹 |⏳ |1,0 год/);
    assert.doesNotMatch(fragment.message, /Можливі відключення|Разом можливих|🟠/);
    assert.doesNotMatch(fragment.message, /Дані ДТЕК:|Графік не гарантує|Джерело даних:|outage-data-ua/);
  }
  assert.equal(publicationFingerprint('2026-10-16', byGroup),
    publicationFingerprint('2026-10-16', byGroup));
});

test('incomplete confirmed data do not produce partial or misleading broadcasts', () => {
  const hours = slots();
  const byGroup = Object.fromEntries(GROUPS.map(group => [
    group, { mode: 'fact', ...windowsFromHours(hours) }
  ]));
  byGroup['6.2'] = { mode: 'preset', ...windowsFromHours(slots('maybe'), true) };
  assert.deepEqual(renderDailyMessages('2026-10-17', 'завтра', byGroup, {}), []);
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
  assert.equal(messages.length, 1);
  assert.ok(messages.every(p => p.message.length < 4096));
  assert.match(messages[0].message, /Підгрупа 1\.1/);
  assert.match(messages[0].message, /Підгрупа 6\.2/);
  assert.equal(messages[0].key, '2026-10-16/сьогодні/all');
  assert.doesNotMatch(messages[0].message, /Частина 1\/2|Частина 2\/2/);
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
  assert.match(message, /🪫 Підгрупа 1\.2/);
  assert.match(message, /🔋 Підгрупа 3\.1/);
  assert.match(message, /🟢 <b>За графіком вмикаємо світло:<\/b>/);
  assert.match(message, /⚫️ Підгрупа 2\.2/);
  assert.match(message, /🌑 <b>Залишаються без світла:<\/b>/);
  assert.match(message, /^⏰ <b>09:30<\/b>/);
  assert.doesNotMatch(message, /Зміни за графіком|📅|📍/);
  assert.doesNotMatch(message, /Це плановий графік|фактичного стану мережі|ℹ️/);
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

test('only extreme confirmed schedules require the Telegram fallback split', () => {
  const hourly = slots('yes');
  for (let h = 1; h <= 24; h += 2) hourly[String(h)] = 'no';
  const byGroup = Object.fromEntries(GROUPS.map(group => [
    group, { mode: 'fact', ...windowsFromHours(hourly) }
  ]));
  const messages = renderDailyMessages('2026-10-16', 'сьогодні', byGroup, {});
  assert.ok(messages.length > 1);
  assert.ok(messages.every(x => x.message.length < 4096));
  const combined = messages.map(x => x.message).join('\n');
  for (const group of GROUPS) {
    assert.equal(combined.split('<b>Підгрупа ' + group + ' відключення:</b>').length - 1, 1);
  }
});

test('transition layout contains only relevant blocks and never adds removed disclaimer', () => {
  const entry = { minute: 600, starting: ['1.2'], restored: [], continuing: [] };
  const rendered = renderTransitionTelegram('2026-10-16', entry);
  assert.match(rendered, /^⏰ <b>10:00<\/b>/);
  assert.match(rendered, /🔴 <b>За графіком вимикаємо світло:/);
  assert.match(rendered, /🪫 Підгрупа 1\.2/);
  assert.doesNotMatch(rendered, /За графіком вмикаємо світло|Залишаються без світла/);
  assert.doesNotMatch(rendered, /Це плановий графік|фактичного стану мережі|ℹ️/);
  assert.doesNotMatch(rendered, /Поширте графік/);
});

test('botvoda-compatible durations always use dot decimal with one digit', () => {
  const data = slots('yes');
  data['10'] = 'no'; data['11'] = 'first';
  const byGroup = Object.fromEntries(GROUPS.map(group => [
    group, { mode: 'fact', ...windowsFromHours(data) }
  ]));
  const post = renderDailyMessages('2026-10-16', 'сьогодні', byGroup, {})[0].message;
  assert.match(post, /❌з 09:00 до 10:30 \(1\.5 год\)/);
  assert.match(post, /⚫ <b>Разом без світла: 1\.5 год<\/b>/);
  assert.doesNotMatch(post, /1,5 год|🪫|\d\d:\d\d–\d\d:\d\d/);
});

test('30-minute early warning includes starts, endings and continuing outages', () => {
  const empty = slots();
  const starts = slots(); starts['10'] = 'second'; // turns off at 09:30
  const ends = slots(); ends['10'] = 'first'; // turns on at 09:30
  const continued = slots(); continued['10'] = 'no';
  const groups = Object.fromEntries(GROUPS.map(group => [group, {
    mode: 'fact', ...windowsFromHours(empty)
  }]));
  groups['1.1'] = {mode: 'fact', ...windowsFromHours(starts)};
  groups['2.2'] = {mode: 'fact', ...windowsFromHours(ends)};
  groups['3.1'] = {mode: 'fact', ...windowsFromHours(continued)};
  const advance = upcomingTransition('2026-10-16', 540, groups);
  assert.equal(advance.minute, 570);
  assert.equal(advance.date, '2026-10-16');
  assert.equal(advance.leadMinutes, 30);
  assert.deepEqual(advance.transition.starting, ['1.1']);
  assert.deepEqual(advance.transition.restored, ['2.2']);
  assert.deepEqual(advance.transition.continuing, ['3.1']);
  const preview = renderTransitionTelegram(advance.date, advance.transition, '', advance.leadMinutes);
  assert.match(preview, /^⏰ <b>09:30<\/b>/);
  assert.match(preview, /До планового часу: 30 хв/);
  assert.match(preview, /🪫 Підгрупа 1\.1/);
  assert.match(preview, /🔋 Підгрупа 2\.2/);
  assert.match(preview, /⚫️ Підгрупа 3\.1/);
});

test('late cron execution never sends at or after schedule boundary', () => {
  const starts = slots(); starts['10'] = 'second';
  const groups = Object.fromEntries(GROUPS.map(group => [
    group, {mode:'fact', ...windowsFromHours(starts)}
  ]));
  const onTime = upcomingTransition('2026-10-16', 547, groups);
  assert.equal(onTime.leadMinutes, 23);
  assert.equal(onTime.minute, 570);
  assert.match(renderTransitionTelegram(onTime.date, onTime.transition, '', onTime.leadMinutes), /23 хв/);
  assert.equal(upcomingTransition('2026-10-16', 562, groups), null); // 8 minutes too late
  assert.equal(upcomingTransition('2026-10-16', 570, groups)?.minute, 600); // at 09:30 only warn for 10:00
});

test("pre-warning for midnight compares today's last minute with tomorrow", () => {
  const old = slots(); old['24'] = 'second';
  const clear = slots('yes');
  const today = Object.fromEntries(GROUPS.map(group => [
    group, {mode:'fact',...windowsFromHours(clear)}
  ]));
  const tomorrow = Object.fromEntries(GROUPS.map(group => [
    group, {mode:'fact',...windowsFromHours(clear)}
  ]));
  today['1.2'] = {mode:'fact', ...windowsFromHours(old)};
  const reminder = upcomingTransition('2026-10-16', 1410, today, tomorrow);
  assert.equal(reminder.date, '2026-10-17');
  assert.equal(reminder.minute, 0);
  assert.equal(reminder.leadMinutes, 30);
  assert.deepEqual(reminder.transition.restored, ['1.2']);
  assert.equal(upcomingTransition('2026-10-16', 1410, today), null);
});

test('no early warning from tentative or incomplete DTEK schedules', () => {
  const starts = slots(); starts['10'] = 'second';
  const groups = Object.fromEntries(GROUPS.map(group => [
    group, {mode:'fact', ...windowsFromHours(starts)}
  ]));
  groups['6.2'] = {mode:'preset', ...windowsFromHours(starts,true)};
  assert.equal(upcomingTransition('2026-10-16', 540, groups), null);
});

test('water bot can read both 1.2 and 2.2 sections from the daily Telegram text', () => {
  const on = slots();
  const group12 = slots(); group12['10'] = 'second'; group12['11'] = 'no';
  const group22 = slots();
  group22['10'] = 'no'; group22['11'] = 'no'; group22['12'] = 'no';
  group22['13'] = 'no'; group22['14'] = 'no'; group22['15'] = 'no';
  for (let h = 19; h <= 22; h++) group22[String(h)] = 'no';
  const byGroup = Object.fromEntries(GROUPS.map(group => [
    group, {mode:'fact', ...windowsFromHours(on)}
  ]));
  byGroup['1.2'] = {mode:'fact', ...windowsFromHours(group12)};
  byGroup['2.2'] = {mode:'fact', ...windowsFromHours(group22)};
  const posts = renderDailyMessages('2026-10-16','сьогодні',byGroup,{});
  assert.equal(posts.length, 1, 'all groups must be in the forwarded Telegram post');
  const plain = posts[0].message.replace(/<[^>]*>/g, '');
  assert.match(plain, /^💡Оновлений графік відключення світла на сьогодні\./);
  assert.match(plain, /📆П'ятниця, 16\.10\.2026/);
  assert.match(plain, /💡Підгрупа 2\.2 відключення:\n❌з 09:00 до 15:00 \(6\.0 год\)\n❌з 18:00 до 22:00 \(4\.0 год\)\n⚫ Разом без світла: 10\.0 год/);

  // Match the *actual structure* used by XOTT69/botvoda/src/lib.js.
  const waterSections = [...plain.matchAll(/підгрупа\s+(\d\.\d)[^\n]*:[\s\S]*?(?=(?:\n\s*💡?\s*підгрупа\s+\d\.\d)|$)/giu)];
  const map = Object.fromEntries(waterSections.map(match => [match[1], match[0]]));
  assert.equal(waterSections.length, 12);
  assert.match(map['1.2'], /❌з 09:30 до 11:00/);
  assert.match(map['2.2'], /❌з 09:00 до 15:00/);
  const intervals = [...map['2.2'].matchAll(/(?:з\s*)?(\d{1,2})[:.](\d{2})\s*(?:до|[-–—])\s*(\d{1,2})[:.](\d{2})/giu)];
  assert.deepEqual(intervals.map(m => [m[1] + ':' + m[2], m[3] + ':' + m[4]]),
    [['09:00','15:00'],['18:00','22:00']]);
});
