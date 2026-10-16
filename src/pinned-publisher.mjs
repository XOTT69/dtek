import {createHash} from 'node:crypto';
import {
  hasConfirmedGraphic, graphicFingerprint, renderPinnedGraphicPng,
  pinnedPhotoCaption, PINNED_GRAPHIC_VERSION
} from './pinned-graphic.mjs';
import {claimPinnedPhoto} from './reminder-claim.mjs';

/**
 * One permanent pinned photo in the channel:
 * - sendPhoto and pin once;
 * - editMessageMedia on every confirmed timetable/date/emergency change;
 * - never publish a second photo merely because its content changed.
 * Text posts and ordinary reminders are handled independently.
 */
export async function publishPinnedGraphic({
  state, date, byGroup, sender, save, dryRun=false,
  claim=claimPinnedPhoto, renderPng=renderPinnedGraphicPng,
  logger=console
}={}) {
  const emergency=state.emergency?.status || null;
  const confirmed=hasConfirmedGraphic(byGroup);
  const fingerprint=graphicFingerprint(date,byGroup,emergency);
  const hash=createHash('sha256').update(fingerprint).digest('hex');
  const caption=pinnedPhotoCaption(date,confirmed,emergency);
  const previous=state.pinnedGraphic;
  if(previous?.messageId &&
    previous.hash===hash && previous.formatVersion===PINNED_GRAPHIC_VERSION &&
    previous.pinned===true) return {status:'unchanged',messageId:previous.messageId};
  if(dryRun) {
    logger.log('Pinned schedule image preview: '+date+' confirmed='+confirmed+
      ' next='+(previous?.messageId?'editMessageMedia':'sendPhoto')+
      ', SHA='+hash);
    return {status:'preview',hash,date,confirmed};
  }
  if(!sender?.photo || !sender?.editPhoto || !sender?.pin) {
    throw new Error('Telegram image and pin methods are not configured');
  }

  // A partially finished prior run may have sent/edited the picture but
  // lost the pin rights. Retry pinning it, not publishing a new image.
  if(previous?.messageId && previous.hash===hash &&
    previous.formatVersion===PINNED_GRAPHIC_VERSION) {
    if(!previous.pinned) {
      await sender.pin(previous.messageId);
      previous.pinned=true;
      previous.pinnedAt=new Date().toISOString();
      await save(state);
      return {status:'pinned',messageId:previous.messageId};
    }
  }
  const png=await renderPng(date,byGroup,emergency);
  if(previous?.messageId) {
    // Fail closed if the original photo was manually deleted or can no
    // longer be edited. Never flood the channel with replacement pins.
    await sender.editPhoto(previous.messageId,png,caption);
    state.pinnedGraphic={
      ...previous, messageId:previous.messageId, date, hash,
      formatVersion:PINNED_GRAPHIC_VERSION, editedAt:new Date().toISOString()
    };
    await save(state);
    if(!state.pinnedGraphic.pinned) {
      await sender.pin(previous.messageId);
      state.pinnedGraphic.pinned=true;
      await save(state);
    }
    logger.log('Edited pinned schedule photo #'+previous.messageId+' for '+date);
    return {status:'edited',messageId:previous.messageId};
  }

  // A fixed GitHub create-only reservation prevents a duplicate pinned
  // message if Telegram succeeded and a subsequent state push failed.
  const reservation=await claim();
  if(!reservation.claimed) {
    logger.warn('Pinned photo already reserved on GitHub; refusing a duplicate send');
    return {status:'already-reserved'};
  }
  const messageId=await sender.photo(png,caption);
  state.pinnedGraphic={
    messageId,date,hash,formatVersion:PINNED_GRAPHIC_VERSION,
    pinned:false,publishedAt:new Date().toISOString()
  };
  await save(state); // Record ID BEFORE trying the pin, for safe retries.
  await sender.pin(messageId);
  state.pinnedGraphic.pinned=true;
  state.pinnedGraphic.pinnedAt=new Date().toISOString();
  await save(state);
  logger.log('Published and pinned the permanent schedule image #'+messageId);
  return {status:'published',messageId};
}
