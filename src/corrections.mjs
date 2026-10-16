import { GROUPS, formatDate } from './schedule.mjs';

// Compact, serializable schedule state. Only confirmed daily facts are stored.
export function snapshotGroups(byGroup) {
  if (!GROUPS.every(group => byGroup?.[group]?.mode === 'fact')) return null;
  return Object.fromEntries(GROUPS.map(group => [
    group, byGroup[group].confirmed.map(p => [p.start, p.end])
  ]));
}

export function sameSnapshot(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function off(periods, minute) {
  return (periods || []).some(([start, end]) => minute >= start && minute < end);
}

function hhmm(minute) {
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' +
    String(minute % 60).padStart(2, '0');
}

// At one timetable boundary, show all groups, not only the group which
// changed its daily timetable. This mirrors DTEK transition posts.
export function correctionAt(date, current, minute, changed) {
  if (!current || minute < 0 || minute > 1440 || minute % 30) return null;
  const starting = [], restored = [], continuing = [];
  for (const group of GROUPS) {
    const before = off(current[group], minute - 1);
    const after = off(current[group], minute);
    if (!before && after) starting.push(group);
    if (before && !after) restored.push(group);
    if (after && before) continuing.push(group);
  }
  return { date, minute, starting, restored, continuing, changed };
}

/**
 * Choose a meaningful boundary affected by updated confirmed DTEK intervals.
 * Upcoming in the next hour is the priority, then a just-passed boundary
 * (up to 45 min), then the next later boundary. Old times are not announced.
 */
export function selectCorrection(date, previous, current, nowMinute) {
  if (!previous || !current || sameSnapshot(previous, current)) return null;
  const changed = GROUPS.filter(group =>
    JSON.stringify(previous[group]) !== JSON.stringify(current[group]));
  if (!changed.length) return null;
  const minutes = new Set();
  for (const group of changed) {
    for (const [start, end] of [...(previous[group] || []), ...(current[group] || [])]) {
      if (start >= 0 && start <= 1440 && start % 30 === 0) minutes.add(start);
      if (end >= 0 && end <= 1440 && end % 30 === 0) minutes.add(end);
    }
  }
  const boundaries = [...minutes].filter(t => t > 0 && t < 1440)
    .filter(t => changed.some(group =>
      off(previous[group], t) !== off(current[group], t) ||
      off(previous[group], t - 1) !== off(current[group], t - 1)))
    .sort((a, b) => a - b);
  if (!boundaries.length) return null;

  let selected = boundaries.find(t => t >= nowMinute && t <= nowMinute + 60);
  if (selected === undefined) {
    selected = [...boundaries].reverse().find(t => t < nowMinute && t >= nowMinute - 45);
  }
  if (selected === undefined) selected = boundaries.find(t => t > nowMinute);
  if (selected === undefined) return null;
  return correctionAt(date, current, selected, changed);
}

export function renderCorrectionTelegram(correction) {
  if (!correction) return null;
  const lines = [
    '⚠️ <b>Коригування</b>',
    '💡 <b>За оновленим графіком о ' + hhmm(correction.minute) + '</b>',
    '📆 ' + formatDate(correction.date),
    ''
  ];
  if (correction.starting.length) {
    lines.push('🪫 <b>За графіком вимикаються:</b>');
    for (const group of correction.starting) lines.push('❌ Підгрупа ' + group);
    lines.push('');
  }
  if (correction.restored.length) {
    lines.push('🟢 <b>За графіком вмикаються:</b>');
    for (const group of correction.restored) lines.push('🔋 Підгрупа ' + group);
    lines.push('');
  }
  if (correction.continuing.length) {
    lines.push('🌑 <b>Залишаються без світла за графіком:</b>');
    for (const group of correction.continuing) lines.push('⚠️ Підгрупа ' + group);
    lines.push('');
  }
  lines.push('🔄 Змінено підгрупи: ' + correction.changed.join(', '));
  return lines.join('\n').trim();
}

// A nearby schedule correction takes the place of the ordinary half-hour
// reminder. One text contains both the correction and the useful countdown.
export function renderCombinedCorrection(correction, leadMinutes) {
  if (!correction || !Number.isInteger(leadMinutes) ||
      leadMinutes < 10 || leadMinutes > 30) return null;
  const lines = [
    '⚠️ <b>Коригування графіка на ' + hhmm(correction.minute) + '</b>',
    '🔔 До планового часу: ' + leadMinutes + ' хв',
    '📆 ' + formatDate(correction.date),
    ''
  ];
  if (!correction.starting.length && !correction.restored.length) {
    lines.push('🔄 Раніше заплановане перемикання на цей час скасовано або перенесено.');
    lines.push('');
  }
  if (correction.starting.length) {
    lines.push('🔴 <b>За графіком вимикаємо світло:</b>');
    for (const group of correction.starting) lines.push('🪫 Підгрупа ' + group);
    lines.push('');
  }
  if (correction.restored.length) {
    lines.push('🟢 <b>За графіком вмикаємо світло:</b>');
    for (const group of correction.restored) lines.push('🔋 Підгрупа ' + group);
    lines.push('');
  }
  if (correction.continuing.length) {
    lines.push('🌑 <b>Залишаються без світла:</b>');
    for (const group of correction.continuing) lines.push('⚫️ Підгрупа ' + group);
    lines.push('');
  }
  lines.push('🔄 Змінено підгрупи: ' + correction.changed.join(', '));
  return lines.join('\n').trim();
}

export function renderCancelledReminder(date, minute) {
  return [
    '⚠️ <b>Коригування графіка</b>',
    '⏰ <b>' + hhmm(minute) + '</b>',
    '📆 ' + formatDate(date),
    '',
    '🔄 Раніше оголошені планові зміни на цей час скасовано або перенесено.',
    '💡 Дивіться оновлений денний графік у каналі.'
  ].join('\n');
}
