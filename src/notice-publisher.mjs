import { createHash } from 'node:crypto';
import { fetchTomorrowNotice, renderUkrenergoNotice } from './ukrenergo.mjs';
import { claimUkrenergoNotice } from './reminder-claim.mjs';

function fingerprint(notice) {
  // Source-post ID is intentionally excluded. A repost with the same
  // date/coverage/hours must not trigger another Telegram notification.
  return createHash('sha256')
    .update(JSON.stringify({date: notice.date, scope: notice.scope, windows: notice.windows}))
    .digest('hex');
}

export async function publishTomorrowNotice({
  state, sender, save, now = new Date(), fetchFn = fetch,
  dryRun = false, logger = console, claim = claimUkrenergoNotice
} = {}) {
  const notice = await fetchTomorrowNotice({now, fetchFn});
  if (!notice) {
    logger.log('Ukrenergo: no eligible fresh tomorrow announcement in the official feed.');
    return {status: 'none'};
  }
  const text = renderUkrenergoNotice(notice);
  const hash = fingerprint(notice);
  const previous = state.announcements?.[notice.date];
  if (previous && previous.sourcePostId > notice.sourcePostId) {
    logger.log('Ukrenergo: older announcement ignored for ' + notice.date);
    return {status: 'older'};
  }
  if (previous?.hash === hash) {
    // Formatting-only release: replace the previous multi-line message
    // in place, keeping the same Telegram ID and fact fingerprint.
    // Never create a new notification just to change the wording.
    if (previous.messageId && (previous.formatVersion || 1) < 2) {
      if (dryRun) return {status:'dry-run',notice};
      await sender.edit(previous.messageId,text);
      previous.formatVersion=2;
      await save(state);
      logger.log('Ukrenergo: compacted existing announcement in place for '+notice.date);
      return {status:'restyled',notice,messageId:previous.messageId};
    }
    logger.log('Ukrenergo: unchanged notice for ' + notice.date);
    return {status: 'unchanged'};
  }
  if (dryRun) {
    logger.log('Ukrenergo preview (' + notice.sourceUrl + '):\n' + text);
    return {status: 'dry-run', notice};
  }

  // Publishing must occur before state is marked complete. If editing
  // fails, don't publish a duplicate: retry edit at the next Actions run.
  let messageId;
  if (previous?.messageId) {
    await sender.edit(previous.messageId, text);
    messageId = previous.messageId;
    logger.log('Ukrenergo: edited tomorrow announcement in place for ' + notice.date);
  } else {
    // Fail closed if the previous send succeeded but GitHub could not
    // persist its message ID: never post a duplicate announcement.
    const reserved = await claim(notice.date);
    if (!reserved.claimed) {
      logger.warn('Ukrenergo: announcement already reserved; no duplicate for ' + notice.date);
      return {status: 'already-reserved', notice};
    }
    messageId = await sender(text);
    logger.log('Ukrenergo: published tomorrow announcement for ' + notice.date);
  }
  state.announcements ??= {};
  state.announcements[notice.date] = {
    hash, messageId, formatVersion:2,
    sourcePostId: notice.sourcePostId,
    sourceUrl: notice.sourceUrl,
    publishedAt: new Date().toISOString()
  };
  for (const date of Object.keys(state.announcements)) {
    if (date < notice.date && Date.parse(date) < Date.parse(notice.date) - 14 * 86400000) {
      delete state.announcements[date];
    }
  }
  await save(state);
  return {status: previous?.messageId ? 'edited' : 'published', notice, messageId};
}
