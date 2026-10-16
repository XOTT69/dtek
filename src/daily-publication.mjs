/**
 * Distinguish a real confirmed day revision from metadata-only noise.
 *
 * Full schedule posts use one revision counter per DATE (across the
 * "tomorrow" and "today" views); only a new revision merits a new
 * Telegram announcement. An existing post with the same revision is edited
 * in place if its markup, emergency caveat or incidental source metadata
 * differs. Legacy records predate the revision field and count as revision 0.
 */
export function decideDailyPublication(previous, hash, revision, headingState) {
  if (!previous?.messageId) return 'publish';
  const oldRevision = Number.isInteger(previous.revision) ?
    previous.revision : 0;
  if (revision > oldRevision) return 'publish';
  if (previous.hash !== hash || (previous.formatVersion || 1) < 7 ||
      previous.headingState !== headingState) return 'edit';
  return 'unchanged';
}
