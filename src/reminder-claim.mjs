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
  const revision = options.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > 10000) {
    throw new Error('Unsafe DTEK schedule revision');
  }
  const day = m[2] === 'сьогодні' ? 'today' : 'tomorrow';
  // Keep the legacy revision-zero path stable. For real later timetable
  // revisions include the monotonic number so A->B->A can be announced
  // again without bypassing atomic duplicate suppression.
  const suffix = revision ? '-r' + revision : '';
  const path = 'state/schedule-claims/' + m[1] + '/' + day + '-' +
    m[3] + '-' + hash + suffix + '.json';
  return reserveOnce(path, 'DTEK schedule ' + key,
    { key, hash, revision }, options);
}

// Every published timetable revision has its own immutable correction claim.
// A failed Git state push cannot cause that correction to be sent again.
export async function claimCorrection(date, minute, hash, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isInteger(minute) || minute <= 0 || minute >= 1440 ||
      minute % 30 !== 0 || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('Unsafe correction reservation');
  }
  const time = String(Math.floor(minute / 60)).padStart(2, '0') + '-' +
    String(minute % 60).padStart(2, '0');
  const path = 'state/correction-claims/' + date + '/' + time + '-' + hash + '.json';
  return reserveOnce(path, 'DTEK correction ' + date + '@' + time,
    {date, minute, hash}, options);
}

// Only one initial general announcement per calendar day; later changes
// must edit the recorded Telegram message instead of creating a new one.
export async function claimUkrenergoNotice(date, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Unsafe Ukrenergo announcement date');
  }
  const path = 'state/ukrenergo-claims/' + date + '.json';
  return reserveOnce(path, 'Ukrenergo notice ' + date, {date}, options);
}

// Each official announcement or correction is published at most once,
 // even if Telegram accepted it and GitHub failed to persist the message ID.
export async function claimEmergency(sourceId, status, fingerprint, options = {}) {
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0 ||
      !['active','cancelled'].includes(status) ||
      !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('Unsafe emergency claim');
  }
  return reserveOnce('state/emergency-claims/dtek_ua/' + sourceId +
    '-' + status + '-' + fingerprint + '.json',
    'DTEK emergency ' + sourceId + ' ' + status,
    {sourceId,status,fingerprint},options);
}

// One permanent image for the channel, independent of timetable revisions.
// Reserve creation ONCE so a lost state push cannot create multiple pinned photos.
export async function claimPinnedPhoto(options = {}) {
  return reserveOnce('state/pinned-photo-claims/permanent.json',
    'permanent pinned timetable image', {purpose:'pinned-schedule'}, options);
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
