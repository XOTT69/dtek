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
/**
 * A DTEK daily schedule can be posted again when its hash truly changes,
 * but duplicate workers must never post the same hash twice.
 */
export async function claimScheduleUpdate(key, hash, options = {}) {
  const m = /^(\d{4}-\d{2}-\d{2})\/(сьогодні|завтра)\/([\d.\-a-z]+)$/.exec(key);
  if (!m || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('Unsafe schedule publication claim');
  }
  const day = m[2] === 'сьогодні' ? 'today' : 'tomorrow';
  const path = 'state/schedule-claims/' + m[1] + '/' + day + '-' +
    m[3] + '-' + hash + '.json';
  return reserveOnce(path, 'DTEK schedule ' + key, { key, hash }, options);
}

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
  return reserveOnce(path, 'outage reminder ' + key, { key }, {
    token, repo, branch, fetchFn, now
  });
}

async function reserveOnce(path, label, data, {
  token = process.env.GITHUB_TOKEN,
  repo = process.env.GITHUB_REPOSITORY,
  branch = 'main',
  fetchFn = fetch,
  now = new Date()
} = {}) {
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('Missing GitHub credentials for atomic publication deduplication; skipping send');
  }
  const url = 'https://api.github.com/repos/' + repo + '/contents/' + path;
  const content = Buffer.from(JSON.stringify({ ...data, reservedAt: now.toISOString() }, null, 2) + '\n').toString('base64');
  const response = await fetchFn(url, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: 'chore: reserve ' + label + ' [skip ci]', content, branch
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (response.status === 201) return { claimed: true, path };
  if (response.status === 409 || response.status === 422) {
    const found = await fetchFn(url + '?ref=' + encodeURIComponent(branch), {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (found.ok) return { claimed: false, path };
    throw new Error('GitHub reservation conflict without existing claim: HTTP ' + found.status);
  }
  throw new Error('Could not reserve Telegram publication, refusing to repost: GitHub HTTP ' + response.status);
}
