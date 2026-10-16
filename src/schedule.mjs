const TZ = 'Europe/Kyiv';
const DISPLAY_WEEKDAYS = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
const GROUPS = ['1.2', '2.2'];
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
  return (minutes / 60).toFixed(1);
}

function total(periods) {
  return duration(periods.reduce((sum, period) => sum + period.minutes, 0));
}

function renderPeriods(periods, marker) {
  return periods.map(p => marker + ' з ' + time(p.start) + ' до ' + time(p.end) + ' (' + duration(p.minutes) + ' год)').join('\n');
}

function safe(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderTelegram(date, dayLabel, byGroup, document) {
  const allModes = GROUPS.map(group => byGroup[group]?.mode);
  const preliminary = allModes.every(mode => mode === 'preset');
  const heading = preliminary
    ? '🔶 <b>Можливі відключення на ' + dayLabel + '</b>'
    : '💡 <b>Графік відключення світла на ' + dayLabel + '</b>';
  const lines = [heading, '📆 <b>' + safe(formatDate(date)) + '</b>', '📍 Київська область', ''];
  if (allModes.includes('preset')) {
    lines.push('⚠️ Помаранчеві періоди — лише можливі відключення за тижневим графіком.', '');
  }
  for (const group of GROUPS) {
    const schedule = byGroup[group];
    lines.push('💡 <b>Підгрупа ' + group + '</b>');
    if (schedule.mode === 'missing') {
      lines.push('ℹ️ Інформації на цю дату поки немає.');
    } else {
      if (schedule.confirmed.length) {
        lines.push(renderPeriods(schedule.confirmed, '❌'));
        lines.push('⚫ <b>Разом без світла: ' + total(schedule.confirmed) + ' год</b>');
      } else if (schedule.mode === 'fact') {
        lines.push('✅ Підтверджених відключень за графіком немає.');
      }
      if (schedule.possible.length) {
        lines.push(renderPeriods(schedule.possible, '🟠'));
        lines.push('🟠 Разом можливих: ' + total(schedule.possible) + ' год');
      } else if (schedule.mode === 'preset') {
        lines.push('✅ За тижневим шаблоном відключень немає.');
      }
    }
    lines.push('');
  }
  const updated = document.fact?.update || document.preset?.updateFact || document.lastUpdated;
  lines.push('🕒 Дані ДТЕК: ' + safe(updated || 'час не вказано'));
  lines.push('ℹ️ Графік не гарантує фактичну наявність електроенергії.');
  lines.push('🔗 <a href="https://github.com/Baskerville42/outage-data-ua">Джерело даних: outage-data-ua</a>');
  return lines.join('\n').trim();
}

export function publicationFingerprint(date, byGroup) {
  return JSON.stringify({
    date,
    groups: GROUPS.map(group => ({ group, schedule: byGroup[group] }))
  });
}

export { GROUPS };
