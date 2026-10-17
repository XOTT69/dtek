import { createHash } from 'node:crypto';
import { fetchDtekEmergencies, renderEmergencyNotice,
  applyEmergencyStatus } from './emergency.mjs';
import { claimEmergency } from './reminder-claim.mjs';

export function emergencySignature(event) {
  return createHash('sha256').update(JSON.stringify({
    status:event.status, kind:event.kind, scope:event.scope,
    districts:event.districts, returnToPlan:event.explicitReturnToPlan
  })).digest('hex');
}

export async function publishEmergencyUpdate({
  state, sender, save, fetchFn = fetch, now = new Date(),
  claim = claimEmergency, dryRun = false, logger = console
} = {}) {
  const observed = await fetchDtekEmergencies({fetchFn,now});
  if (!observed) {
    logger.log('DTEK emergency: no fresh official Kyiv oblast bulletin');
    return {status:'none'};
  }
  // A generic "hourly schedules resumed" bulletin does not distinguish
  // emergency from аварійні. Keep the type of the PREVIOUS incident.
  const prior = state.emergency?.status;
  const event = observed.status==='cancelled' && !observed.kind ?
    {...observed,kind:prior?.kind || 'екстрені'} : observed;

  const signature = emergencySignature(event);
  const previousId = state.emergency?.lastId || 0;
  if (previousId > event.id) return {status:'unchanged'};
  if (previousId === event.id && state.emergency?.lastSignature === signature) {
    // Formatting upgrades edit the already-published post, never send
    // another emergency bulletin or a duplicate notification.
    if (!dryRun && state.emergency?.messageId &&
        (state.emergency.formatVersion || 1) < 2) {
      await sender.edit(state.emergency.messageId, renderEmergencyNotice(event));
      state.emergency.formatVersion = 2;
      await save(state);
      logger.log('DTEK emergency: restyled existing Telegram message #' +
        state.emergency.messageId);
      return {status:'restyled',event};
    }
    return {status:'unchanged'};
  }
  const next = applyEmergencyStatus(prior, event);
  // No new broadcast if an unrelated district's cancellation leaves the
  // tracked status unchanged; also avoid retroactive "cancelled" notices.
  const noChange = !!prior && previousId !== 0 &&
    prior.active === next.active && prior.kind === next.kind &&
    prior.scope === next.scope &&
    JSON.stringify(prior.districts) === JSON.stringify(next.districts);
  if (dryRun) {
    logger.log('DTEK emergency preview: ' + renderEmergencyNotice(event,
      next.active ? next.districts : []));
    return {status:'preview', event, next};
  }

  const remember = async (messageId = state.emergency?.messageId) => {
    state.emergency = {
      status: next, lastId: event.id, lastSignature: signature,
      lastSourceUrl:event.sourceUrl, lastObservedAt:now.toISOString(),
      lastSourcePublishedAt:event.publishedAt,
      ...(messageId ? {messageId} : {}),
      formatVersion:2
    };
    await save(state);
  };

  if (event.status === 'cancelled' && !prior?.active) {
    // A normal plan announcement is not proof that this bot previously
    // reported an emergency; remember the bulletin without a fake alert.
    await remember();
    logger.log('DTEK emergency: return to plan observed with no tracked active incident');
    return {status:'already-clear',event,next};
  }

  if (noChange) {
    await remember();
    logger.log('DTEK emergency: official reminder with unchanged area/state, no duplicate');
    return {status:'unchanged-content',event,next};
  }

  const reserved = await claim(event.id,event.status,signature);
  if (!reserved.claimed) {
    await remember();
    logger.log('DTEK emergency: previously reserved bulletin ' + event.id);
    return {status:'already-reserved',event,next};
  }

  const text = renderEmergencyNotice(event,
    event.status === 'cancelled' && next.active ? next.districts : []);
  const messageId = await sender(text);
  await remember(messageId);
  logger.log('DTEK emergency: published ' + event.status + ' bulletin #' +
    event.id + ', Telegram #' + messageId);
  return {status:'published',event,next,messageId};
}
