const TZ = 'Europe/Kyiv';
const DISPLAY_WEEKDAYS = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
const GROUPS = Array.from({ length: 6 }, (_, i) => [String(i + 1) + '.1', String(i + 1) + '.2']).flat();
const OK_STATES = new Set(['yes', 'no', 'first', 'second', 'maybe', 'mfirst', 'msecond']);

export function kyivDate(instant = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(instant);
  const read = key => parts.find(p => p.type === key)?.value;
  return [read('year'), read('month'), read('day')].join('-');
}

export function addDays(date, count) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + count, 12)).toISOString().slice(0, 10);
}

export function weekdayIndex(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

export function formatDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = DISPLAY_WEEKDAYS[weekdayIndex(date)];
  return weekday + ', ' + String(d).padStart(2, '0') + '.' + String(m).padStart(2, '0') + '.' + y;
}

export function keyToKyivDate(timestampSeconds) {
  const seconds = Number(timestampSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid fact date timestamp');
  return kyivDate(new Date(seconds * 1000));
}

export function windowsFromHours(hours, isPreset = false) {
  if (!hours || typeof hours !== 'object') throw new Error('Missing hourly schedule');
  const halves = new Array(48).fill('on');
  for (let hour = 1; hour <= 24; hour++) {
    const state = hours[String(hour)];
    if (!OK_STATES.has(state)) throw new Error('Unknown/missing schedule state at hour ' + hour + ': ' + state);
    const start = (hour - 1) * 2;
    const mark = (slot, definite) => { halves[slot] = isPreset || !definite ? 'possible' : 'off'; };
    if (state === 'no' || state === 'maybe') {
      mark(start, state === 'no');
      mark(start + 1, state === 'no');
    } else if (state === 'first' || state === 'mfirst') {
      mark(start, state === 'first');
    } else if (state === 'second' || state === 'msecond') {
      mark(start + 1, state === 'second');
    }
  }
  const merge = kind => {
    const periods = [];
    for (let i = 0; i < 48;) {
      if (halves[i] !== kind) { i++; continue; }
      const start = i;
      while (i < 48 && halves[i] === kind) i++;
      periods.push({ start: start * 30, end: i * 30, minutes: (i - start) * 30 });
    }
    return periods;
  };
  return { confirmed: merge('off'), possible: merge('possible') };
}

export function resolveSchedule(document, date, group) {
  if (!GROUPS.includes(group)) throw new Error('Unsupported group');
  if (!document || document.regionId !== 'kyiv-region') throw new Error('Unexpected data region');
  const groupId = 'GPV' + group;
  const fact = document.fact?.data ?? {};
  for (const [timestamp, byGroup] of Object.entries(fact)) {
    if (keyToKyivDate(timestamp) === date && byGroup?.[groupId]) {
      return { mode: 'fact', ...windowsFromHours(byGroup[groupId], false) };
    }
  }
  const weekday = weekdayIndex(date) || 7;
  const preset = document.preset?.data?.[groupId]?.[String(weekday)];
  if (preset) return { mode: 'preset', ...windowsFromHours(preset, true) };
  return { mode: 'missing', confirmed: [], possible: [] };
}

function time(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function duration(minutes) {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace('.', ',');
}

function total(periods) {
  return duration(periods.reduce((sum, period) => sum + period.minutes, 0));
}

function renderPeriods(periods, marker) {
  return periods.map(p => marker + ' <b>' + time(p.start) + '–' + time(p.end) + '</b> · ' + duration(p.minutes) + ' год').join('\n');
}

function safe(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Only confirmed DTEK daily schedules are eligible for public posts. */
export function renderTelegram(date, dayLabel, byGroup, _document, groups = GROUPS) {
  if (groups.some(group => byGroup[group]?.mode !== 'fact')) {
    throw new Error('Only confirmed daily DTEK fact schedules can be published');
  }
  const lines = [
    '💡 <b>Оновлений графік відключення світла на ' + dayLabel + '</b>',
    '📆 <b>' + safe(formatDate(date)) + '</b>',
    '📍 Київська область',
    ''
  ];
  for (const group of groups) {
    const schedule = byGroup[group];
    lines.push('🔹 <b>Підгрупа ' + group + '</b>');
    if (schedule.confirmed.length) {
      lines.push(renderPeriods(schedule.confirmed, '🪫'));
      lines.push('⏳ <b>Разом без світла: ' + total(schedule.confirmed) + ' год</b>');
    } else {
      lines.push('✅ Підтверджених відключень за графіком немає.');
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function publicationFingerprint(date, byGroup, groups = GROUPS) {
  return JSON.stringify({
    date,
    groups: groups.map(group => ({ group, schedule: byGroup[group] }))
  });
}

export { GROUPS };

/** Usually all 12 confirmed groups fit in one Telegram message. */
export function renderDailyMessages(date, dayLabel, byGroup, document) {
  if (!GROUPS.every(group => byGroup[group]?.mode === 'fact')) return [];
  const maxLength = 3500;
  const full = renderTelegram(date, dayLabel, byGroup, document, GROUPS);
  if (full.length <= maxLength) {
    return [{
      key: date + '/' + dayLabel + '/all',
      fingerprint: publicationFingerprint(date, byGroup),
      message: full
    }];
  }
  // Only unusually long schedules are split to stay below the Telegram limit.
  const chunks = [];
  let current = [];
  for (const group of GROUPS) {
    const next = [...current, group];
    const text = renderTelegram(date, dayLabel, byGroup, document, next);
    if (text.length > maxLength && current.length) {
      chunks.push(current);
      current = [group];
    } else {
      if (text.length > maxLength) throw new Error('Single group exceeds safe Telegram limit');
      current = next;
    }
  }
  if (current.length) chunks.push(current);
  return chunks.map((groups, index) => {
    const text = renderTelegram(date, dayLabel, byGroup, document, groups);
    const message = text + '\n📄 Частина ' + (index + 1) + '/' + chunks.length;
    if (message.length > 3900) throw new Error('Telegram message is too long');
    return {
      key: date + '/' + dayLabel + '/' + groups[0] + '-' + groups[groups.length - 1],
      fingerprint: publicationFingerprint(date, byGroup, groups),
      message
    };
  });
}

export function kyivMinutes(instant = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit'
  }).formatToParts(instant);
  const read = key => Number(parts.find(p => p.type === key)?.value);
  return read('hour') * 60 + read('minute');
}

function inside(periods, minute) {
  return (periods || []).some(p => minute >= p.start && minute < p.end);
}

/** Never infer actual electricity status from a forecast; use confirmed fact only. */
export function buildTransition(byGroup, minute) {
  if (minute <= 0 || minute >= 1440 || minute % 30 !== 0) return null;
  const starting = [];
  const restored = [];
  const continuing = [];
  for (const group of GROUPS) {
    const schedule = byGroup[group];
    if (schedule?.mode !== 'fact') continue;
    const before = inside(schedule.confirmed, minute - 1);
    const after = inside(schedule.confirmed, minute);
    if (!before && after) starting.push(group);
    if (before && !after) restored.push(group);
    if (before && after) continuing.push(group);
  }
  if (!starting.length && !restored.length) return null;
  return { minute, starting, restored, continuing };
}

/**
 * Find the next half-hour boundary, up to 30 minutes in advance.
 * Never send reminders after a boundary has already passed.
 * GitHub Actions may run late: permit a reminder with 10–30 minutes'
 * notice and show the actual remaining lead time.
 */
export function upcomingTransition(date, nowMinute, byGroup, tomorrowGroups = null) {
  if (!Number.isFinite(nowMinute) || nowMinute < 0 || nowMinute >= 1440) return null;
  const nextMinute = Math.floor(nowMinute / 30) * 30 + 30;
  const leadMinutes = nextMinute - nowMinute;
  if (leadMinutes < 10 || leadMinutes > 30) return null;
  let eventDate = date;
  let eventMinute = nextMinute;
  let transition;
  if (nextMinute === 1440) {
    eventDate = addDays(date, 1);
    eventMinute = 0;
    if (!tomorrowGroups || !GROUPS.every(group =>
      byGroup[group]?.mode === 'fact' && tomorrowGroups[group]?.mode === 'fact'
    )) return null;
    const starting = [], restored = [], continuing = [];
    for (const group of GROUPS) {
      const wasOff = inside(byGroup[group].confirmed, 1439);
      const willBeOff = inside(tomorrowGroups[group].confirmed, 0);
      if (!wasOff && willBeOff) starting.push(group);
      if (wasOff && !willBeOff) restored.push(group);
      if (wasOff && willBeOff) continuing.push(group);
    }
    if (!starting.length && !restored.length) return null;
    transition = {minute: 0, starting, restored, continuing};
  } else {
    if (!GROUPS.every(group => byGroup[group]?.mode === 'fact')) return null;
    transition = buildTransition(byGroup, eventMinute);
    if (!transition) return null;
  }
  return {date: eventDate, minute: eventMinute, leadMinutes, transition};
}

export function renderTransitionTelegram(date, transition, channel = '', leadMinutes = null) {
  if (!transition) return null;
  const lines = [
    '⏰ <b>' + time(transition.minute) + '</b>'
  ];
  if (Number.isInteger(leadMinutes) && leadMinutes > 0) {
    lines.push('🔔 До планового часу: ' + leadMinutes + ' хв');
  }
  lines.push('');
  if (transition.starting.length) {
    lines.push('🔴 <b>Початок відключення:</b>');
    for (const group of transition.starting) lines.push('🪫 Підгрупа ' + group);
    lines.push('');
  }
  if (transition.restored.length) {
    lines.push('🟢 <b>Завершення планового відключення:</b>');
    for (const group of transition.restored) lines.push('🔋 Підгрупа ' + group);
    lines.push('');
  }
  if (transition.continuing.length) {
    lines.push('🌑 <b>За графіком залишаються без світла:</b>');
    for (const group of transition.continuing) lines.push('⚫️ Підгрупа ' + group);
    lines.push('');
  }
  const tag = String(channel).trim().replace(/^@/, '');
  if (/^[A-Za-z0-9_]{5,32}$/.test(tag)) {
    lines.push('📣 <a href="https://t.me/' + tag + '">Поширте графік та підпишіться на канал</a>');
  }
  return lines.join('\n').trim();
}
