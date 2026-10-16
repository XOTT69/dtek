/**
 * outage-data-ua intentionally preserves the last successful fact/preset when
 * an upstream DTEK request fails. Do not reject that usable snapshot only
 * because lastUpdateStatus.ok is false.
 *
 * Stale data are still rejected: we must not send old schedules as current.
 */
export function validateSource(data, now = new Date(), maxAgeHours = 12) {
  if (data?.regionId !== 'kyiv-region' || !data.fact?.data || !data.preset?.data) {
    throw new Error('Unexpected or incomplete Kyiv region JSON');
  }
  const updatedAt = Date.parse(data.lastUpdated);
  if (!Number.isFinite(updatedAt)) throw new Error('Source lastUpdated missing or invalid');
  const ageMs = now.getTime() - updatedAt;
  if (ageMs < -10 * 60 * 1000) {
    throw new Error('Source timestamp lies in the future');
  }
  if (ageMs > maxAgeHours * 60 * 60 * 1000) {
    throw new Error('Source snapshot is stale (' + (ageMs / 3600000).toFixed(1) + 'h old). No outdated schedule will be posted.');
  }
  if (!Object.keys(data.fact.data).length && !Object.keys(data.preset.data).length) {
    throw new Error('No usable outage schedules in JSON');
  }
  return {
    data,
    isFallback: data.lastUpdateStatus?.ok === false,
    snapshotUpdatedAt: data.lastUpdated,
    ageMinutes: Math.max(0, Math.round(ageMs / 60000))
  };
}

/** Transient GitHub CDN/network errors should not abort the first attempt. */
export async function fetchSourceJson(url, fetchFn = fetch, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchFn(url, {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    }
  }
  throw new Error('Unable to read outage JSON after ' + attempts + ' attempts: ' + String(lastError?.message || lastError));
}
