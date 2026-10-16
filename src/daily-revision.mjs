import { createHash } from 'node:crypto';
import { confirmedDayForSync } from './confirmed-feed.mjs';

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hasComparableSnapshot(state, date, confirmed) {
  const previous=state.scheduleSnapshots?.[date];
  if (!previous || typeof previous !== 'object' || Array.isArray(previous))
    return false;
  return Object.keys(confirmed).every(group =>
    Array.isArray(previous[group]) &&
    previous[group].every(p => Array.isArray(p) && p.length===2 &&
      Number.isInteger(p[0]) && Number.isInteger(p[1])));
}

function hasPublishedDate(state, date) {
  return Object.entries(state.publications || {}).some(([key, value]) =>
    key.startsWith(date + '/') && Number.isSafeInteger(value?.messageId));
}

/**
 * Record REAL changes to a full confirmed timetable, not poll timestamps,
 * emergency status, rendering changes or a day-label rollover.
 *
 * One date uses the same revision history for "завтра" and "сьогодні".
 * If the first Telegram delivery has not happened, the next confirmed
 * source replaces the initial baseline rather than claiming an update.
 */
export function trackDailyRevision(state, date, byGroup) {
  const confirmed = confirmedDayForSync(byGroup);
  if (!confirmed) return { eligible: false, updated: false, changed: false };

  const hash = digest(confirmed);
  state.dailyRevisions ??= {};
  const previous = state.dailyRevisions[date];
  if (!previous) {
    // Upgrade old installations safely: they can already have a
    // confirmed published schedule, plus a complete old baseline.
    // If the live DTEK intervals truly differ from that baseline,
    // don't mislabel the new schedule as its first announcement.
    const oldFacts=state.scheduleSnapshots?.[date];
    const revised=hasPublishedDate(state,date) &&
      hasComparableSnapshot(state,date,confirmed) &&
      digest(oldFacts)!==hash;
    const revision=revised?1:0;
    state.dailyRevisions[date] = { hash, revision };
    return { eligible: true, updated: revised, changed: true, revision };
  }
  if (previous.hash === hash) {
    return { eligible: true, updated: previous.revision > 0,
      changed: false, revision: previous.revision };
  }
  const revision = hasPublishedDate(state, date) ? previous.revision + 1 : 0;
  state.dailyRevisions[date] = { hash, revision };
  return { eligible: true, updated: revision > 0, changed: true, revision };
}

export function dailyIsUpdated(state, date) {
  return Number(state.dailyRevisions?.[date]?.revision || 0) > 0;
}
