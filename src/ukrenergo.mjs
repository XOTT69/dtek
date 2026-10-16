/**
 * Conservative reader for the publicly accessible posts of the official
 * @Ukrenergo Telegram channel. No private Telegram API token is involved.
 *
 * Ukrenergo announces national consumption restrictions, not the timetable
 * for individual Kyiv oblast subgroups. Keep these concepts separate.
 */
import { addDays, kyivDate } from './schedule.mjs';

export const UKRENERGO_FEED = 'https://t.me/s/Ukrenergo';

const MONTHS = new Map([
  ['січня', 1], ['лютого', 2], ['березня', 3], ['квітня', 4],
  ['травня', 5], ['червня', 6], ['липня', 7], ['серпня', 8],
  ['вересня', 9], ['жовтня', 10], ['листопада', 11], ['грудня', 12]
]);

function decodeHtml(html) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    nbsp: ' ', ndash: '–', mdash: '—', laquo: '«', raquo: '»'
  };
  return String(html)
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|li|blockquote|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (_, value) => {
      if (value.startsWith('#')) {
        const isHex = value[1]?.toLowerCase() === 'x';
        const n = Number.parseInt(value.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
      }
      return named[value.toLowerCase()] ?? '&' + value + ';';
    })
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractOfficialPosts(html) {
  if (typeof html !== 'string') throw new Error('Official Telegram feed did not return HTML');
  const markers = [...html.matchAll(/data-post=["']Ukrenergo\/(\d+)["']/gi)];
  if (!markers.length) throw new Error('Official Telegram posts are missing; layout or access may have changed');
  const posts = [];
  for (let i = 0; i < markers.length; i++) {
    const section = html.slice(markers[i].index, markers[i + 1]?.index ?? html.length);
    const date = section.match(/<time\b[^>]*datetime=["']([^"']+)["']/i);
    const body = section.match(/<div\b[^>]*class=["'][^"']*\btgme_widget_message_text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    if (!date || !body) continue;
    const stamp = new Date(date[1]);
    if (!Number.isFinite(stamp.getTime())) continue;
    const id = Number(markers[i][1]);
    if (!Number.isSafeInteger(id)) continue;
    const text = decodeHtml(body[1]);
    if (!text) continue;
    posts.push({
      id, text, publishedAt: stamp,
      url: 'https://t.me/Ukrenergo/' + id
    });
  }
  if (!posts.length) throw new Error('Official Telegram posts have no readable timestamps/text');
  return posts;
}

const HOUR_RANGE = /\b([01]\d|2[0-4]):([0-5]\d)\s*(?:[–—−-]|до)\s*([01]\d|2[0-4]):([0-5]\d)\b/gi;

function hourlyWindows(text) {
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const result = [];
  const hourly = /(?:графік[а-яіїєґ]*\s+погодинн[а-яіїєґ]*\s+відключен[а-яіїєґ]*|\bГПВ\b)/i;
  const unrelatedHeader = /графік[а-яіїєґ]*\s+обмежен[а-яіїєґ]*\s+потужност/i;

  for (let i = 0; i < lines.length; i++) {
    if (!hourly.test(lines[i])) continue;
    // A title such as "ГРАФІКИ ПОГОДИННИХ ВІДКЛЮЧЕНЬ" is often followed
    // by one or more bullet lines containing the actual hours.
    const candidates = [lines[i]];
    if (![...lines[i].matchAll(HOUR_RANGE)].length) {
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (unrelatedHeader.test(lines[j])) break;
        if (hourly.test(lines[j]) && j !== i) break;
        candidates.push(lines[j]);
        if ([...lines[j].matchAll(HOUR_RANGE)].length) break;
      }
    }
    for (const line of candidates) {
      for (const match of line.matchAll(HOUR_RANGE)) {
        const start = Number(match[1]) * 60 + Number(match[2]);
        const end = Number(match[3]) * 60 + Number(match[4]);
        if (start >= end || end > 1440 || start >= 1440) continue;
        const time = match[1] + ':' + match[2] + '–' + match[3] + ':' + match[4];
        if (!result.includes(time)) result.push(time);
      }
    }
  }
  return result.slice(0, 4);
}

function scopeOf(text) {
  // A Kyiv city mention does not imply Kyiv *oblast*.
  const oblast = /київськ(?:ій|ої|а|у|их)\s+област|київщин[а-яіїєґ]*/i;
  const allRegions = /(?:в|у)\s+усіх\s+(?:регіонах|областях)|(?:в|у)\s+всіх\s+(?:регіонах|областях)|по\s+всій\s+україн|на\s+всій\s+території\s+україн/i;
  const exclusion = /крім[^.\n]{0,100}(?:київськ[а-яіїєґ]*\s+област|київщин[а-яіїєґ]*)/i;
  if (allRegions.test(text) && !exclusion.test(text)) return 'national';
  if (oblast.test(text) && !exclusion.test(text)) return 'kyiv';
  if (/(?:частин[іиа]|деяких|окремих|більшост[іи])\s+(?:регіонів|областей)|(?:окремих|деяких)\s+регіонах|(?:окремих|деяких)\s+областях/i.test(text)) {
    return 'partial';
  }
  return 'unknown';
}

/**
 * Announcement is eligible only on the day it is issued, for *tomorrow*.
 * Also ensure the calendar date in its body matches tomorrow exactly.
 */
export function parseTomorrowNotice(post, now = new Date()) {
  const posted = post?.publishedAt;
  if (!(posted instanceof Date) || !Number.isFinite(posted.getTime())) return null;
  const age = now.getTime() - posted.getTime();
  if (age < -5 * 60000 || age > 30 * 3600000) return null;
  if (kyivDate(posted) !== kyivDate(now)) return null;

  const raw = post.text;
  if (typeof raw !== 'string') return null;
  const match = raw.match(/завтра\s*[,:\s–—-]*([0-3]?\d)\s+([а-яіїєґ]+)/i);
  if (!match) return null;
  const month = MONTHS.get(match[2].toLowerCase());
  if (!month) return null;
  const tomorrow = addDays(kyivDate(now), 1);
  const [, calendarMonth, calendarDay] = tomorrow.split('-').map(Number);
  if (Number(match[1]) !== calendarDay || month !== calendarMonth) return null;

  const windows = hourlyWindows(raw);
  if (!windows.length) return null;
  const scope = scopeOf(raw);
  if (scope === 'unknown') return null;
  return {
    date: tomorrow, scope, windows,
    sourcePostId: post.id,
    sourceUrl: post.url
  };
}

export function pickLatestTomorrowNotice(posts, now = new Date()) {
  const candidates = posts
    .map(post => parseTomorrowNotice(post, now))
    .filter(Boolean)
    .sort((a, b) => b.sourcePostId - a.sourcePostId);
  return candidates[0] ?? null;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderUkrenergoNotice(notice) {
  const [, mm, dd] = notice.date.split('-');
  const heading = '⚡️ <b>Завтра, ' + Number(dd) + '.' + mm + ', можливі погодинні відключення</b>';
  const lines = [heading, '🕒 <b>' + notice.windows.join(', ') + '</b>', ''];
  if (notice.scope === 'national') {
    lines.push('📍 У всіх регіонах України, включно з Київською областю.');
  } else if (notice.scope === 'kyiv') {
    lines.push('📍 Київська область згадана в оголошенні.');
  } else {
    lines.push('📍 У частині регіонів України.');
  }
  lines.push('', '💡 Точні години для підгруп 1.1–6.2 повідомимо після публікації графіка ДТЕК.');
  lines.push('📢 <a href="' + escapeHtml(notice.sourceUrl) + '">Офіційне повідомлення Укренерго</a>');
  return lines.join('\n');
}

export async function fetchTomorrowNotice({fetchFn = fetch, now = new Date()} = {}) {
  const response = await fetchFn(UKRENERGO_FEED, {
    headers: {Accept: 'text/html', 'Cache-Control': 'no-cache'},
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('Ukrenergo official channel HTTP ' + response.status);
  const html = await response.text();
  return pickLatestTomorrowNotice(extractOfficialPosts(html), now);
}
