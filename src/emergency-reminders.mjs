import { addDays, buildTransition, buildMidnightTransition, kyivDate, kyivMinutes,
  renderTransitionTelegram } from './schedule.mjs';
import { emergencyAdvisory } from './emergency.mjs';
import { renderCancelledReminder } from './corrections.mjs';
import { renderDailyMessages } from './schedule.mjs';
import { createHash } from 'node:crypto';
import { dailyIsUpdated } from './daily-revision.mjs';

/**
 * Emergency alerts invalidate confident reliance on planned switching times.
 * Edit previously sent *future* reminders in place to add/remove a district-
 * scoped caveat. Never imply that an actual residence has power.
 */
export async function reconcileEmergencyReminders({
  state, source, allGroups, sender, save, now = new Date(),
  dryRun = false, logger = console
} = {}) {
  const today = kyivDate(now), tomorrow = addDays(today, 1);
  const minuteNow = kyivMinutes(now);
  const status = state.emergency?.status;
  const advisory = emergencyAdvisory(status);
  const contextKey = JSON.stringify({
    active:!!status?.active, kind:status?.active ? status.kind : '',
    districts:status?.active ? status.districts : []
  });
  let edited = 0;
  for (const [key,event] of Object.entries(state.events ?? {})) {
    const m = /^(\d{4}-\d{2}-\d{2})@(\d{2}):(\d{2})#pre30$/.exec(key);
    if (!m || !event?.messageId) continue;
    const date=m[1],minute=Number(m[2])*60+Number(m[3]);
    if (!Number.isInteger(minute) || minute >= 1440) continue;
    if (date !== today && date !== tomorrow) continue;
    const remaining = date === today ? minute - minuteNow : 1440 - minuteNow + minute;
    if (remaining <= 0 || remaining > 120) continue;
    // No need to rewrite a reminder unless the emergency status changed.
    if (!advisory && !event.emergencyContextKey) continue;
    if (event.emergencyContextKey === contextKey) continue;
    const groups = allGroups(source,date);
    // A 00:00 event compares two dates; buildTransition() intentionally
    // rejects minute zero. Do not falsely call a real midnight switch cancelled.
    const transition = minute === 0 ?
      buildMidnightTransition(allGroups(source,addDays(date,-1)),groups) :
      buildTransition(groups,minute);
    if (minute === 0 && !transition) continue;
    // Keep the merged correction header/group list when an emergency
    // starts or ends. Replacing it with a plain reminder would undo the
    // one-post design and could hide the important schedule change.
    const text = event.combinedBaseText ?
      event.combinedBaseText + advisory :
      (transition ?
        renderTransitionTelegram(date,transition,'@svitlo_kyivshchyna',remaining) :
        renderCancelledReminder(date,minute)) + advisory;
    if (dryRun) {
      logger.log('Emergency reminder preview: '+key+' '+text);
      continue;
    }
    await sender.edit(event.messageId,text);
    event.emergencyContextKey=contextKey;
    event.emergencyEditedAt=now.toISOString();
    await save(state);
    edited++;
    logger.log('Adjusted scheduled reminder for emergency conditions: '+key);
  }
  return edited;
}

/**
 * Annotate the *existing* confirmed daily schedule during a local emergency.
 * Do not alter the water bot's established "💡Підгрупа ... / ❌з ..." syntax.
 * If the emergency is officially cancelled, edit the old schedule to remove
 * the warning. Do not re-publish the whole schedule or reset its content hash.
 */
export async function reconcileEmergencyDaily({
  state, source, allGroups, sender, save,
  now = new Date(), dryRun = false, logger = console
} = {}) {
  const day = kyivDate(now);
  const groups = allGroups(source,day);
  const fragments = renderDailyMessages(day,'сьогодні',groups,source,
    {updated: dailyIsUpdated(state, day)});
  const notice = emergencyAdvisory(state.emergency?.status);
  const context = JSON.stringify({
    active:!!state.emergency?.status?.active,
    kind:state.emergency?.status?.active ? state.emergency.status.kind : '',
    districts:state.emergency?.status?.active ? state.emergency.status.districts : []
  });
  let edited = 0;
  for (const fragment of fragments) {
    const existing = state.publications?.[fragment.key];
    if (!existing?.messageId) continue;
    // A source change may have been reserved but not yet posted. Never
    // overwrite a newer/older schedule with unrelated text.
    const hash = createHash('sha256').update(fragment.fingerprint).digest('hex');
    if (existing.hash !== hash) continue;
    if (!notice && !existing.emergencyContextKey) continue;
    if (existing.emergencyContextKey === context) continue;
    const text = fragment.message + notice;
    if (text.length > 4096) {
      logger.warn('DTEK emergency schedule annotation too long: ' + fragment.key);
      continue;
    }
    if (dryRun) {
      logger.log('Daily emergency annotation preview: ' + fragment.key);
      continue;
    }
    await sender.edit(existing.messageId,text);
    existing.emergencyContextKey = context;
    existing.emergencyEditedAt = now.toISOString();
    await save(state);
    edited++;
    logger.log('Updated existing DTEK daily schedule for emergency state: ' + fragment.key);
  }
  return edited;
}
