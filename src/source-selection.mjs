import {addDays, kyivDate, resolveSchedule, GROUPS} from './schedule.mjs';

/** Only the actual DTEK fact update time is comparable across sources.
 * HTTP fetch timestamps / lastUpdated are not evidence of a changed schedule.
 */
export function factUpdateKey(doc) {
  const raw = String(doc?.fact?.update || doc?.fact?.updateFact || '').trim();
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/.exec(raw);
  if (!match) return null;
  const [day, month, year, hour, minute] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  return year * 100000000 + month * 1000000 + day * 10000 + hour * 100 + minute;
}

function confirmedDay(doc, date) {
  try {
    return GROUPS.every(group => resolveSchedule(doc, date, group).mode === 'fact');
  } catch {
    return false;
  }
}

export function selectBestDtekSource(direct, backup, now = new Date()) {
  if (!direct) return {kind: 'backup', data: backup, reason: 'Direct DTEK unavailable'};
  if (!backup) return {kind: 'direct', data: direct, reason: 'Backup unavailable'};
  const directKey = factUpdateKey(direct);
  const backupKey = factUpdateKey(backup);
  if (directKey !== null && backupKey !== null && backupKey > directKey) {
    return {kind: 'backup', data: backup, reason: 'Backup contains a newer DTEK fact update timestamp'};
  }
  const tomorrow = addDays(kyivDate(now), 1);
  if (confirmedDay(backup, tomorrow) && !confirmedDay(direct, tomorrow) &&
    (directKey === null || backupKey === null || backupKey >= directKey)) {
    return {kind: 'backup', data: backup, reason: 'Backup contains a confirmed tomorrow schedule not available directly'};
  }
  return {kind: 'direct', data: direct, reason: 'Direct DTEK primary is current'};
}
