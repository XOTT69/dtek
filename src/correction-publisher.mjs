import { createHash } from 'node:crypto';
import { GROUPS, buildTransition, renderTransitionTelegram } from './schedule.mjs';
import {
  snapshotGroups, sameSnapshot, selectCorrection, renderCorrectionTelegram,
  renderCancelledReminder
} from './corrections.mjs';
import { claimCorrection } from './reminder-claim.mjs';
import { emergencyAdvisory } from './emergency.mjs';

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function confirmedGroupSet(snapshot) {
  return Object.fromEntries(GROUPS.map(group => [
    group,
    {mode: 'fact', confirmed: (snapshot[group] || []).map(([start, end]) =>
      ({start, end, minutes: end - start}))}
  ]));
}

/**
 * After publishing the updated full schedule, compare the previous complete
 * confirmed timetable to the new one. A full-graph change is not always a
 * nearby transition change, so no extra correction is sent in that case.
 *
 * A brand-new day has no baseline: record it without spuriously claiming
 * that an existing schedule has "changed."
 */
export async function publishScheduleCorrection({
  state, date, byGroup, nowMinute, sender, save,
  claim = claimCorrection, dryRun = false, logger = console,
  updateReminders = true
}) {
  const current = snapshotGroups(byGroup);
  if (!current) return {status: 'unconfirmed'};
  state.scheduleSnapshots ??= {};
  const previous = state.scheduleSnapshots[date] ?? null;

  if (!previous) {
    if (!dryRun) {
      state.scheduleSnapshots[date] = current;
      await save(state);
    }
    logger.log('Correction baseline recorded for ' + date);
    return {status: 'baseline'};
  }
  if (sameSnapshot(previous, current)) return {status: 'unchanged'};

  // Correct already-published early reminders whenever their announced
  // switching groups have changed. Never create a second advance reminder.
  for (const [eventKey, event] of Object.entries(updateReminders ? (state.events ?? {}) : {})) {
    const m = /^(\d{4}-\d{2}-\d{2})@(\d{2}):(\d{2})#pre30$/.exec(eventKey);
    if (!m || m[1] !== date || !event?.messageId) continue;
    const minute = Number(m[2]) * 60 + Number(m[3]);
    // An update may arrive shortly AFTER the scheduled switch. Correct
    // recently passed announcements as well as upcoming ones so old
    // "will switch" notices do not remain misleading in the channel.
    if (minute < nowMinute - 45 || minute > nowMinute + 120) continue;
    const previousTransition = buildTransition(confirmedGroupSet(previous), minute);
    const nextTransition = buildTransition(byGroup, minute);
    const transitionSignature = transition => transition ? JSON.stringify({
      starting: transition.starting,
      restored: transition.restored,
      continuing: transition.continuing
    }) : null;
    if (transitionSignature(previousTransition) === transitionSignature(nextTransition)) continue;
    const fingerprint = digest({date, minute, transition: transitionSignature(nextTransition)});
    if (event.correctedHash === fingerprint) continue;

    const text = nextTransition ?
      (minute <= nowMinute ? '⚠️ <b>Уточнення після зміни графіка</b>\n' : '') +
      renderTransitionTelegram(date, nextTransition, '@svitlo_kyivshchyna',
        minute > nowMinute ? minute - nowMinute : null) :
      renderCancelledReminder(date, minute);
    const annotatedText = text + emergencyAdvisory(state.emergency?.status);
    if (dryRun) {
      logger.log('Correction preview for old reminder ' + eventKey + ':\n' + annotatedText);
    } else {
      // If Telegram edit fails, do not mark the snapshot complete: retry safely.
      await sender.edit(event.messageId, annotatedText);
      event.correctedHash = fingerprint;
      event.editedAt = new Date().toISOString();
      await save(state);
      logger.log('Corrected outdated early reminder in place: ' + eventKey);
    }
  }

  const correction = selectCorrection(date, previous, current, nowMinute);
  if (!correction) {
    if (!dryRun) {
      state.scheduleSnapshots[date] = current;
      await save(state);
    }
    logger.log('Updated DTEK schedule has no relevant upcoming correction slot: ' + date);
    return {status: 'no-nearby-transition'};
  }
  const text = renderCorrectionTelegram(correction);
  const hash = digest({date, current, minute: correction.minute});
  if (dryRun) {
    logger.log('Correction preview:\n' + text);
    return {status: 'preview', correction};
  }

  const reserved = await claim(date, correction.minute, hash);
  if (!reserved.claimed) {
    state.scheduleSnapshots[date] = current;
    await save(state);
    logger.log('Correction already reserved by another publisher: ' + date + ' ' +
      correction.minute);
    return {status: 'already-reserved', correction};
  }

  const messageId = await sender(text);
  state.corrections ??= {};
  const key = date + '@' + correction.minute;
  state.corrections[key] = {
    messageId, hash, updatedAt: new Date().toISOString()
  };
  state.scheduleSnapshots[date] = current;
  await save(state);
  logger.log('Published DTEK correction ' + key + ', Telegram message ID ' + messageId);
  return {status: 'published', messageId, correction};
}
