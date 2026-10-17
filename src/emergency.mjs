import { extractOfficialPosts } from './ukrenergo.mjs';

export const DTEK_ALERT_FEED = 'https://t.me/s/dtek_ua';

// Administrative districts of Kyiv oblast, never confuse the city of Kyiv
// with the surrounding oblast (they have separate DTEK companies).
const DISTRICTS = [
  ['Білоцерківський', /білоцерківськ[а-яіїєґʼ'’]*/iu],
  ['Бориспільський', /бориспільськ[а-яіїєґʼ'’]*/iu],
  ['Броварський', /броварськ[а-яіїєґʼ'’]*/iu],
  ['Бучанський', /бучанськ[а-яіїєґʼ'’]*/iu],
  ['Вишгородський', /вишгородськ[а-яіїєґʼ'’]*/iu],
  ['Обухівський', /обухівськ[а-яіїєґʼ'’]*/iu],
  ['Фастівський', /фастівськ[а-яіїєґʼ'’]*/iu]
];

// Scope and type must be explicitly supplied by the official source.
export function parseDtekEmergency(post, now = new Date()) {
  if (!post || typeof post.text !== 'string' || !Number.isSafeInteger(post.id) ||
      !(post.publishedAt instanceof Date)) return null;
  const age = now.getTime() - post.publishedAt.getTime();
  if (age < -5 * 60000 || age > 36 * 3600000) return null;
  const text = post.text.replace(/\u00a0/g, ' ');
  // "Київ" alone means the city, not the oblast.
  if (!/(?:київщин|київськ[а-яіїєґ]*\s+област)/iu.test(text)) return null;
  const hasEmergency = /(?:екстрен[а-яіїєґ]*|аварійн[а-яіїєґ]*)\s+відключен|відключен[а-яіїєґ]*\s+(?:через\s+)?аварі/iu.test(text);
  // DTEK also announces the END of an emergency by explicitly resuming
  // hourly outages, e.g. official post 4643 on 17.10.2026:
  // "Київщина: за командою Укренерго застосовано графіки відключень".
  // Ordinary day-ahead schedules ("графіки на завтра") must NOT clear alerts.
  const officialReturn = /(?:повертаємось|повертаємося|повернулись|повернулися)\s+до\s+графік|(?:відновлен|відновил)[а-яіїєґ]*\s+(?:планов[а-яіїєґ]*\s+)?графік/iu.test(text);
  const scheduleActivated = /(?:застосовано|застосовуються|запроваджено|відновлено|введено)\s+(?:погодинні\s+|стабілізаційні\s+)?графік[а-яіїєґ]*\s+(?:(?:погодинн[а-яіїєґ]*|стабілізаційн[а-яіїєґ]*)\s+)?відключен[а-яіїєґ]*/iu.test(text);
  const negated = /(?:не|досі\s+не|поки\s+не)\s+(?:застосовано|застосовуються|запроваджено|відновлено|введено)\s+графік/iu.test(text);
  const dayAhead = /(?:завтра|на\s+наступн[а-яіїєґ]*\s+день)/iu.test(text);
  const excludedAreas = /(?:крім|окрім|за\s+винятком)/iu.test(text);
  const partialWithoutDistricts = /(?:частин[іиа]|деяких|окремих|не\s+(?:у|на)\s+всій)/iu.test(text) &&
    !DISTRICTS.some(([,re])=>re.test(text));
  const resumedSchedules = scheduleActivated && !negated && !dayAhead &&
    !excludedAreas && !partialWithoutDistricts && !/графік[а-яіїєґ]*\s+не\s+діють/iu.test(text);
  const returnToPlan = officialReturn || resumedSchedules;
  if (!hasEmergency && !returnToPlan) return null;
  const districts = DISTRICTS.filter(([, re]) => re.test(text)).map(([name]) => name);
  const cancellation = /(?:відключен[^.!?\n]{0,40}(?:скасован|скасуван|припинен|завершен)|скасован[а-яіїєґ]*\s+(?:екстрен|аварійн)|скасуван[а-яіїєґ]*\s+(?:екстрен|аварійн)|екстрен[а-яіїєґ]*\s+відключен[а-яіїєґ]*\s+(?:більше\s+не|не\s+діють))/iu.test(text) ||
    returnToPlan;
  const introduction = /(?:застосов|запроваджен|введен|діють|тривають|фіксують|фіксуються|відбуваються|наявн[а-яіїєґ]*|залишаються)/iu.test(text) ||
    /(?:через\s+атак|внаслідок\s+атак|через\s+аварі)/iu.test(text);
  if (!cancellation && (!hasEmergency || !introduction)) return null;
  // The "hourly schedules resumed" bulletin does not name the previous
  // outage type. The publisher resolves it from the known active incident.
  const kind = /екстрен/iu.test(text) ? 'екстрені' :
    /аварійн/iu.test(text) ? 'аварійні' : null;
  // Some DTEK posts include Kyiv city *and* specific oblast districts.
  // A bare "Київщина" statement is NOT silently interpreted as every district.
  const scope = districts.length ? 'districts' : 'oblast-unspecified';
  const status = cancellation ? 'cancelled' : 'active';
  return {
    id: post.id, status, kind, districts, scope,
    sourceUrl: 'https://t.me/dtek_ua/' + post.id,
    sourceText: text, publishedAt: post.publishedAt.toISOString(),
    explicitReturnToPlan: returnToPlan,
    explicitSchedulesSuspended: /графік[а-яіїєґ]*\s+(?:не\s+діють|тимчасово\s+не\s+діють)/iu.test(text)
  };
}

export function selectLatestDtekEmergency(posts, now = new Date()) {
  return posts.map(post => parseDtekEmergency(post, now)).filter(Boolean)
    .sort((a, b) => b.id - a.id)[0] ?? null;
}

function names(districts) {
  if (!districts?.length) return 'Окремі території Київської області';
  return districts.map(x => x + ' район').join(', ');
}

export function renderEmergencyNotice(event, remaining = []) {
  const emergency = event.kind === 'екстрені';
  const lines = [];
  if (event.status === 'active') {
    lines.push('🚨 <b>' + (emergency ? 'Екстрені' : 'Аварійні') +
      ' відключення на Київщині</b>');
    lines.push('📍 ' + names(event.districts));
    if (emergency || event.explicitSchedulesSuspended) {
      lines.push('⚠️ Погодинні графіки тимчасово не діють.');
    } else {
      lines.push('⚠️ Можливі відключення поза графіком.');
    }
    lines.push('🕒 Точний час відновлення невідомий.');
  } else {
    lines.push('✅ <b>Скасування ' + (emergency ? 'екстрених' : 'аварійних') +
      ' відключень на Київщині</b>');
    lines.push('📍 ' + names(event.districts));
    // Only claim the return to hourly schedules when DTEK says so.
    lines.push(event.explicitReturnToPlan ?
      '💡Повертаємося до погодинних графіків.' :
      '💡Обмеження скасовано. Перевіряйте актуальний графік ДТЕК.');
    if (remaining.length) {
      lines.push('⚠️ В інших районах обмеження ще діють: ' + names(remaining));
    }
  }
  lines.push('🔗 <a href="' + event.sourceUrl + '">Офіційне повідомлення ДТЕК</a>');
  return lines.join('\n');
}

export function applyEmergencyStatus(previous, event) {
  if (event.status === 'active') {
    return {active: true, kind: event.kind, scope: event.scope,
      districts: event.districts, sourceUrl: event.sourceUrl};
  }
  if (event.scope === 'oblast-unspecified') {
    // "у частині Київщини" is not evidence that emergency restrictions were
    // lifted everywhere. Only a non-qualified oblast-wide cancellation is.
    const partial = /(?:частин[іиа]|деяких|окремих)\s+(?:район[а-яіїєґ]*|територі[а-яіїєґ]*|київщин[а-яіїєґ]*)/iu.test(event.sourceText);
    if (partial && previous?.active) return {...previous};
    return {active: false, kind: previous?.kind || event.kind || 'екстрені', scope: 'oblast-unspecified',
      districts: [], sourceUrl: event.sourceUrl};
  }
  if (previous?.scope === 'oblast-unspecified' && previous.active) {
    // We don't know the initial district list: a district-only cancellation
    // cannot prove that the rest of Kyiv oblast is restored.
    return {...previous};
  }
  const remaining = (previous?.districts || []).filter(d => !event.districts.includes(d));
  return {active: remaining.length > 0, kind: previous?.kind || event.kind,
    scope: 'districts', districts: remaining, sourceUrl: event.sourceUrl};
}

export function emergencyAdvisory(status) {
  if (!status?.active) return '';
  const kind = status.kind === 'екстрені' ? 'екстрені' : 'аварійні';
  return '\n\n⚠️ <b>Увага:</b> на Київщині діють ' + kind +
    ' відключення (' + names(status.districts) + '). ' +
    (kind === 'екстрені' ? 'Графіки не діють.' :
      'Можливі відключення поза графіком.');
}

export async function fetchDtekEmergencies({fetchFn = fetch, now = new Date()} = {}) {
  const response = await fetchFn(DTEK_ALERT_FEED, {
    headers: {Accept:'text/html','Cache-Control':'no-cache'},
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('DTEK Telegram HTTP ' + response.status);
  const html = await response.text();
  return selectLatestDtekEmergency(extractOfficialPosts(html, 'dtek_ua'), now);
}
