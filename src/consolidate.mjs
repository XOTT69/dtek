/**
 * When switching to one full-day message, reuse the first legacy Telegram post.
 * Save the new state before deleting the spare part so this is safe to retry.
 */
export async function consolidateLegacyPost({state, fragment, hash, sender, save, log = console}) {
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
    await sender.edit(old.messageId, fragment.message);
    state.publications[fragment.key] = {
      hash, messageId: old.messageId, formatVersion: 3, editedAt: new Date().toISOString()
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
