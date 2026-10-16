import { createHash } from 'node:crypto';
import { GROUPS, buildTransition, renderTransitionTelegram } from './schedule.mjs';
import {
  snapshotGroups, sameSnapshot, selectCorrection, renderCorrectionTelegram,
  renderCombinedCorrection, renderCancelledReminder
} from './corrections.mjs';
import { claimCorrection, claimReminder } from './reminder-claim.mjs';
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
  claim = claimCorrection, claimAdvance = claimReminder,
  dryRun = false, logger = console,
  updateReminders = true, mergeNearby = false
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

  const correction = selectCorrection(date, previous, current, nowMinute);
  const lead = correction?.minute - nowMinute;
  // Tomorrow's graph passes nowMinute=0 as a placeholder: only allow a
  // current-day correction to absorb a 10–30 minute reminder.
  const nearby = mergeNearby && Number.isInteger(lead) && lead >= 10 && lead <= 30;
  const mergedEventKey = nearby ?
    date + '@' + String(Math.floor(correction.minute / 60)).padStart(2,'0') +
      ':' + String(correction.minute % 60).padStart(2,'0') + '#pre30' : null;

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
    // The matching upcoming reminder is edited ONCE into a combined
    // correction below, rather than also producing a normal edit.
    if (nearby && eventKey === mergedEventKey) continue;
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

  if (!correction) {
    if (!dryRun) {
      state.scheduleSnapshots[date] = current;
      await save(state);
    }
    logger.log('Updated DTEK schedule has no relevant upcoming correction slot: ' + date);
    return {status: 'no-nearby-transition'};
  }
  const status = emergencyAdvisory(state.emergency?.status);
  const correctionKey = date + '@' + correction.minute;
  const hash = digest({date, current, minute: correction.minute});
  const combinedBase = nearby ? renderCombinedCorrection(correction,lead) : null;
  const text = (combinedBase || renderCorrectionTelegram(correction)) + status;
  if (dryRun) {
    logger.log('Correction preview:\n' + text);
    return {status:'preview',correction,merged:nearby};
  }

  const reserved = await claim(date, correction.minute, hash);
  if (!reserved.claimed) {
    state.scheduleSnapshots[date] = current;
    await save(state);
    logger.log('Correction already reserved by another publisher: ' +
      date + ' ' + correction.minute);
    return {status:'already-reserved',correction};
  }

  state.corrections ??= {};
  if (nearby) {
    state.events ??= {};
    const existingReminder = state.events[mergedEventKey];
    const existingCorrection = state.corrections[correctionKey];
    // If the early reminder was sent first, edit THAT message, rather
    // than posting the whole list of groups again.
    const existingId = existingReminder?.messageId || existingCorrection?.messageId;
    let messageId = existingId;
    if (existingId) {
      await sender.edit(existingId,text);
    } else {
      // Reserve the ordinary reminder key before sending the combined post.
      // This protects against retries even if Git fails to save the ID.
      const reminderReservation = await claimAdvance(mergedEventKey);
      if (!reminderReservation.claimed) {
        state.events[mergedEventKey] = {
          ...(existingReminder || {}), claimed:true, formatVersion:6,
          recoveredAt:new Date().toISOString()
        };
        state.scheduleSnapshots[date] = current;
        await save(state);
        logger.log('Merged correction reminder already reserved: ' + mergedEventKey);
        return {status:'already-reserved',correction};
      }
      messageId = await sender(text);
    }
    const emergency = state.emergency?.status;
    state.events[mergedEventKey] = {
      ...(existingReminder || {}),
      messageId, leadMinutes:lead, formatVersion:6,
      combinedCorrectionHash:hash, combinedBaseText:combinedBase,
      emergencyContextKey:JSON.stringify({
        active:!!emergency?.active,
        kind:emergency?.active ? emergency.kind : '',
        districts:emergency?.active ? emergency.districts : []
      }),
      editedAt:new Date().toISOString()
    };
    state.corrections[correctionKey] = {
      messageId, hash, combined:true, updatedAt:new Date().toISOString()
    };
    state.scheduleSnapshots[date] = current;
    await save(state);
    logger.log((existingId ? 'Merged into existing post #' : 'Published combined post #') +
      messageId + ' for ' + mergedEventKey);
    return {status:existingId ? 'merged' : 'published',messageId,correction,merged:true};
  }

  const messageId = await sender(text);
  state.corrections[correctionKey] = {
    messageId, hash, updatedAt:new Date().toISOString()
  };
  state.scheduleSnapshots[date] = current;
  await save(state);
  logger.log('Published DTEK correction ' + correctionKey +
    ', Telegram message ID ' + messageId);
  return {status:'published',messageId,correction};

}
