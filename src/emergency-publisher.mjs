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
  const event = await fetchDtekEmergencies({fetchFn,now});
  if (!event) {
    logger.log('DTEK emergency: no fresh official Kyiv oblast bulletin');
    return {status:'none'};
  }

  const signature = emergencySignature(event);
  const previousId = state.emergency?.lastId || 0;
  if (previousId > event.id ||
      (previousId === event.id && state.emergency?.lastSignature === signature)) {
    return {status:'unchanged'};
  }
  const next = applyEmergencyStatus(state.emergency?.status, event);
  // Follow-up reminders of the SAME known status are not new incidents.
  const prior = state.emergency?.status;
  const noChange = !!prior && previousId !== 0 &&
    prior.active === next.active && prior.kind === next.kind &&
    prior.scope === next.scope &&
    JSON.stringify(prior.districts) === JSON.stringify(next.districts);
  if (dryRun) {
    logger.log('DTEK emergency preview: ' + renderEmergencyNotice(event,
      next.active ? next.districts : []));
    return {status:'preview', event, next};
  }

  const remember = async () => {
    state.emergency = {
      status: next, lastId: event.id, lastSignature: signature,
      lastSourceUrl:event.sourceUrl, lastObservedAt:now.toISOString(),
      lastSourcePublishedAt:event.publishedAt
    };
    await save(state);
  };

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
  await remember();
  logger.log('DTEK emergency: published ' + event.status + ' bulletin #' +
    event.id + ', Telegram #' + messageId);
  return {status:'published',event,next,messageId};
}
