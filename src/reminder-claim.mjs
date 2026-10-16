/**
 * Atomic at-most-once claim for Telegram reminders.
 *
 * GitHub Actions may publish a Telegram message and then fail to push
 * state/publications.json. Every next run would repost the same alert.
 * Create a unique file on the remote repository FIRST using GitHub's
 * create-only Contents API (no SHA = no overwrite). Only the run that
 * successfully creates it may send the message.
 *
 * This intentionally favors no duplicates over delivery after a crash
 * between the claim and the Telegram API call. An operator can remove
 * a specific claim manually if a proven failed delivery needs retrying.
 */
export async function claimReminder(
  key,
  {
    token = process.env.GITHUB_TOKEN,
    repo = process.env.GITHUB_REPOSITORY,
    branch = 'main',
    fetchFn = fetch,
    now = new Date()
  } = {}
) {
  const match = /^(\d{4}-\d{2}-\d{2})@(\d{2}):(\d{2})#pre30$/.exec(key);
  if (!match) throw new Error('Unsafe or unsupported reminder claim key');
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('Missing GitHub credentials for atomic reminder deduplication; skipping send');
  }
  const path = 'state/reminder-claims/' + match[1] + '/' + match[2] + '-' + match[3] + '.json';
  const url = 'https://api.github.com/repos/' + repo + '/contents/' + path;
  const content = Buffer.from(JSON.stringify({key, reservedAt: now.toISOString()}, null, 2) + '\n').toString('base64');
  const response = await fetchFn(url, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: 'chore: reserve outage reminder ' + key + ' [skip ci]',
      content, branch
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 201) return {claimed: true, path};
  if (response.status === 409 || response.status === 422) {
    // GitHub returns 422 when the file already exists without SHA. To
    // distinguish from validation failures, verify that it really exists.
    const found = await fetchFn(url + '?ref=' + encodeURIComponent(branch), {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (found.ok) return {claimed: false, path};
    throw new Error('GitHub reservation conflict without existing claim: HTTP ' + found.status);
  }
  throw new Error('Could not reserve Telegram reminder, refusing to repost: GitHub HTTP ' + response.status);
}
