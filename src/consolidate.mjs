import { createHash } from 'node:crypto';
/**
 * When switching to one full-day message, reuse the first legacy Telegram post.
 * Save the new state before deleting the spare part so this is safe to retry.
 */
export async function consolidateLegacyPost({
  state, fragment, hash, sender, save, log = console,
  revision = 0, headingState = 'initial', advisory = '',
  emergencyContextKey = null
}) {
  if (!fragment.key.endsWith('/all')) return false;
  state.publications ??= {};
  const prefix = fragment.key.slice(0, -3);
  const oldEntries = () => Object.entries(state.publications)
    .filter(([key, value]) => key.startsWith(prefix) && key !== fragment.key
      && /\/\d+\.\d+-\d+\.\d+$/.test(key) && Number.isSafeInteger(value?.messageId))
    .sort(([a], [b]) => a.localeCompare(b, 'en'));

  if (!state.publications[fragment.key]) {
    const legacy = oldEntries();
    if (!legacy.length) return false;
    const [oldKey, old] = legacy[0];
    // Reuse the old post as the canonical full timetable. Store the
    // current revision as already published so the main loop doesn't
    // subsequently create a second, duplicate full timetable post.
    await sender.edit(old.messageId, fragment.message + advisory);
    state.publications[fragment.key] = {
      ...old, hash, messageId: old.messageId,
      revision, formatVersion: 7, headingState,
      ...(emergencyContextKey !== null ? {emergencyContextKey} : {}),
      editedAt: new Date().toISOString()
    };
    delete state.publications[oldKey];
    await save(state);
    log.log('Edited original split post into all-group post: ' + fragment.key);
  }

  for (const [oldKey, old] of oldEntries()) {
    try {
      await sender.delete(old.messageId);
      delete state.publications[oldKey];
      await save(state);
      log.log('Deleted redundant previous part: ' + oldKey);
    } catch (error) {
      log.warn('Could not delete old Telegram message #' + old.messageId + ': ' +
        String(error?.message || error));
    }
  }
  return true;
}


/**
 * Mirror operation: if a timetable becomes too long for one Telegram post,
 * reuse its existing full-day message for the FIRST split fragment.
 * Publish only the additional fragments through the normal claim-protected
 * workflow. This prevents leaving a stale full-day message in the channel
 * and avoids an unnecessary duplicate of the first split fragment.
 */
export async function expandFullPostToSplit({
  state, fragments, sender, save, revision = 0,
  headingState = 'initial', advisory = '', emergencyContextKey = null,
  log = console
}) {
  if (!Array.isArray(fragments) || fragments.length < 2 ||
      fragments.some(f=>typeof f?.key!=='string'||f.key.endsWith('/all'))) {
    return false;
  }
  const first=fragments[0];
  const prefix=first.key.slice(0,first.key.lastIndexOf('/')+1);
  if(!fragments.every(f=>f.key.startsWith(prefix) &&
      /^.+\/\d+\.\d+-\d+\.\d+$/.test(f.key)))return false;

  state.publications ??= {};
  const fullKey=prefix+'all';
  const old=state.publications[fullKey];
  if(!Number.isSafeInteger(old?.messageId) || old.messageId<1 ||
      state.publications[first.key])return false;

  await sender.edit(old.messageId, first.message + advisory);
  const hash=createHash('sha256').update(first.fingerprint).digest('hex');
  state.publications[first.key]={
    ...old,hash,messageId:old.messageId,revision,formatVersion:7,
    headingState,
    ...(emergencyContextKey!==null?{emergencyContextKey}:{}),
    editedAt:new Date().toISOString()
  };
  delete state.publications[fullKey];
  await save(state);
  log.log('Migrated existing full-day post to first split part: '+first.key);
  return true;
}
