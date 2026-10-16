import { upcomingTransition, renderTransitionTelegram } from './schedule.mjs';
import { claimReminder } from './reminder-claim.mjs';
import { emergencyAdvisory } from './emergency.mjs';

/**
 * Called by the *regular* verified cron-job.org -> GitHub workflow_dispatch.
 * At most one early reminder per confirmed half-hour transition.
 * Reserve before sending to avoid duplicate Telegram posts after state push races.
 */
export async function publishAdvanceReminder({
  state, date, minutesNow, todayGroups, tomorrowGroups,
  sender, save, channel = '@svitlo_kyivshchyna',
  claim = claimReminder, dryRun = false, logger = console
} = {}) {
  const upcoming = upcomingTransition(date, minutesNow, todayGroups, tomorrowGroups);
  if (!upcoming) return {status: 'none'};

  const hh = String(Math.floor(upcoming.minute / 60)).padStart(2, '0');
  const mm = String(upcoming.minute % 60).padStart(2, '0');
  const key = upcoming.date + '@' + hh + ':' + mm + '#pre30';
  const emergency = state.emergency?.status;
  const emergencyContextKey = JSON.stringify({
    active:!!emergency?.active,
    kind:emergency?.active ? emergency.kind : '',
    districts:emergency?.active ? emergency.districts : []
  });
  const message = renderTransitionTelegram(
    upcoming.date, upcoming.transition, channel, upcoming.leadMinutes
  ) + emergencyAdvisory(emergency);

  if (dryRun) {
    logger.log('Advance reminder preview for ' + key + ':\n' + message);
    return {status:'preview', key, leadMinutes:upcoming.leadMinutes, message};
  }

  state.events ??= {};
  if (state.events[key]) {
    logger.log('Advance reminder already recorded: ' + key);
    return {status:'already-sent',key};
  }

  // GitHub REST create-only reservation survives broken git state commits.
  const reservation = await claim(key);
  if (!reservation.claimed) {
    state.events[key] = {
      claimed:true, formatVersion:5, recoveredAt:new Date().toISOString()
    };
    await save(state);
    logger.log('Advance reminder already reserved remotely: ' + key);
    return {status:'already-reserved',key};
  }

  const messageId = await sender(message);
  state.events[key] = {
    messageId, leadMinutes:upcoming.leadMinutes, formatVersion:5,
    emergencyContextKey, publishedAt:new Date().toISOString()
  };
  await save(state);
  logger.log('Published advance reminder ' + key + ', ' +
    upcoming.leadMinutes + ' minutes early, Telegram message ID ' + messageId);
  return {status:'published',key,messageId,leadMinutes:upcoming.leadMinutes};
}
