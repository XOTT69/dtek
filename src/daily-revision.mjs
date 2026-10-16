import { createHash } from 'node:crypto';
import { confirmedDayForSync } from './confirmed-feed.mjs';

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
    state.dailyRevisions[date] = { hash, revision: 0 };
    return { eligible: true, updated: false, changed: true, revision: 0 };
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
