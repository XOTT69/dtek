/**
 * Read DTEK Kyiv Regional Networks directly (no intermediary repository).
 * DTEK does not publish a documented public API. First try the AJAX request
 * used by its own site, then the public schedule page's embedded JSON.
 * On a block / schema change, caller must safely use the existing fallback.
 */
import { addDays, kyivDate, resolveSchedule, GROUPS } from './schedule.mjs';

export const DTEK_PAGE = 'https://www.dtek-krem.com.ua/ua/shutdowns';
export const DTEK_AJAX = 'https://www.dtek-krem.com.ua/ua/ajax';

const ajaxHeaders = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'uk,en;q=0.8',
  Origin: 'https://www.dtek-krem.com.ua',
  Referer: DTEK_PAGE
};

function parseResponseObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DTEK response was not an object');
  }
  // Some AJAX handlers wrap the response in a data field.
  const candidates = [value, value.data, value.result].filter(
    part => part && typeof part === 'object' && !Array.isArray(part)
  );
  const result = candidates.find(part => part.fact?.data && typeof part.fact.data === 'object');
  if (!result) throw new Error('DTEK did not provide daily fact.data');
  return { fact: result.fact, preset: result.preset ?? {data: {}} };
}

function extractJsonAssignment(html, key) {
  const marker = new RegExp('DisconSchedule\\s*\\.\\s*' + key + '\\s*=\\s*', 'g');
  const match = marker.exec(html);
  if (!match) throw new Error('Missing direct DTEK ' + key + ' assignment');
  const start = match.index + match[0].length;
  if (html[start] !== '{') throw new Error('Expected JSON object for DTEK ' + key);
  let curly = 0, square = 0, quote = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') { quote = true; continue; }
    if (c === '{') curly++;
    if (c === '}') curly--;
    if (c === '[') square++;
    if (c === ']') square--;
    if (curly < 0 || square < 0) throw new Error('Malformed direct DTEK ' + key + ' data');
    if (curly === 0 && square === 0) {
      // Strict JSON only: do not evaluate source-site JavaScript.
      return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('Incomplete direct DTEK ' + key + ' data');
}

export function parseDtekHtml(html) {
  if (typeof html !== 'string' || html.length < 80) throw new Error('No full DTEK HTML page');
  const fact = extractJsonAssignment(html, 'fact');
  let preset = { data: {} };
  try { preset = extractJsonAssignment(html, 'preset'); }
  catch { /* optional: only confirmed fact schedules are published */ }
  return { fact, preset };
}

export function normalizeDtekData(raw, now = new Date()) {
  const { fact, preset } = parseResponseObject(raw);
  const data = {
    regionId: 'kyiv-region',
    lastUpdated: now.toISOString(), // Fetch time, NOT a claim that the DTEK schedule changed now.
    fact,
    preset,
    lastUpdateStatus: { ok: true, status: 'direct' }
  };
  // We only publish confirmed fact, never 'possible' weekly preset.
  // Refuse any upstream response missing a complete 12-group schedule for
  // at least today or tomorrow, or with bad slot values.
  const today = kyivDate(now);
  const dates = [today, addDays(today, 1)];
  const validDates = [];
  for (const date of dates) {
    try {
      if (GROUPS.every(group => resolveSchedule(data, date, group).mode === 'fact')) {
        validDates.push(date);
      }
    } catch {
      // Some upstream formats can change without warning. Ignore bad dates.
    }
  }
  if (!validDates.length) {
    throw new Error('Direct DTEK data has no complete confirmed schedule for today/tomorrow');
  }
  return { data, validDates };
}

export async function fetchDtekDirect({
  fetchFn = fetch,
  now = new Date(),
  timeoutMs = 11000
} = {}) {
  const errors = [];
  try {
    const response = await fetchFn(DTEK_AJAX, {
      method: 'POST',
      headers: ajaxHeaders,
      body: new URLSearchParams({method: 'checkDisconUpdate', update: '01.01.2000 00:00'}).toString(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error('AJAX HTTP ' + response.status);
    const text = await response.text();
    const result = normalizeDtekData(JSON.parse(text), now);
    return { ...result, via: 'ajax' };
  } catch (error) {
    errors.push('AJAX: ' + String(error?.message || error));
  }
  try {
    const response = await fetchFn(DTEK_PAGE, {
      headers: { Accept: 'text/html', 'Accept-Language': 'uk-UA,uk;q=0.9', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error('page HTTP ' + response.status);
    const text = await response.text();
    const result = normalizeDtekData(parseDtekHtml(text), now);
    return { ...result, via: 'html' };
  } catch (error) {
    errors.push('HTML: ' + String(error?.message || error));
  }
  throw new Error('Direct DTEK temporarily unavailable (' + errors.join('; ') + ')');
}
