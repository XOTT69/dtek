import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UKRENERGO_FEED, extractOfficialPosts, parseTomorrowNotice,
  pickLatestTomorrowNotice, renderUkrenergoNotice, fetchTomorrowNotice
} from '../src/ukrenergo.mjs';

const NOW = new Date('2026-10-15T14:00:00Z'); // 17:00 Kyiv Oct 15
const POSTED = new Date('2026-10-15T13:10:00Z');
const BASE = [
  'УВАГА! ІНФОРМАЦІЯ ПРО ВІДКЛЮЧЕННЯ',
  'Завтра, 16 ЖОВТНЯ, у частині регіонів України вимушено будуть застосовуватись заходи обмеження споживання:',
  '• 06:00 – 23:59 – графіки обмеження потужності для промисловості та бізнесу',
  '• 06:00 – 23:59 – графіки погодинних відключень для всіх категорій споживачів (обсягом від 0,5 до 2 черг)'
].join('\n');

function post(id, text = BASE, publishedAt = POSTED) {
  return {id, text, publishedAt, url: 'https://t.me/Ukrenergo/' + id};
}

function htmlPost(id, message = BASE, iso = POSTED.toISOString()) {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br/>');
  return '<div class="tgme_widget_message_wrap js-widget_message_wrap">' +
    '<div class="tgme_widget_message js-widget_message" data-post="Ukrenergo/' + id + '">' +
    '<div class="tgme_widget_message_text js-message_text" dir="auto">' + safe + '</div>' +
    '<a class="tgme_widget_message_date" href="https://t.me/Ukrenergo/' + id + '">' +
    '<time datetime="' + iso + '"></time></a></div></div>';
}

test('reads exact official channel posts, dates, hours and source links', () => {
  const posts = extractOfficialPosts(htmlPost(101) + htmlPost(102));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, 101);
  assert.match(posts[0].text, /06:00 – 23:59 – графіки погодинних відключень/);
  assert.equal(posts[0].url, 'https://t.me/Ukrenergo/101');
  const result = parseTomorrowNotice(posts[0], NOW);
  assert.deepEqual(result, {
    date: '2026-10-16',
    scope: 'partial',
    windows: ['06:00–23:59'],
    sourcePostId: 101,
    sourceUrl: 'https://t.me/Ukrenergo/101'
  });
});

test('part-of-regions announcement never claims Kyiv oblast confirmed', () => {
  const notice = parseTomorrowNotice(post(200), NOW);
  const rendered = renderUkrenergoNotice(notice);
  assert.equal(rendered,
    '💡<b>Завтра, 16 жовтня, у частині регіонів України будуть діяти графіки погодинних відключень світла з 06:00 до 23:59.</b>');
  assert.doesNotMatch(rendered, /Київськ|<a href|Точні години|📍|⚡️/);
});

test('all-regions announcement includes Kyiv oblast', () => {
  const content = BASE.replace('у частині регіонів України', 'в усіх регіонах України');
  const notice = parseTomorrowNotice(post(201, content), NOW);
  assert.equal(notice.scope, 'national');
  assert.equal(renderUkrenergoNotice(notice),
    '💡<b>Завтра, 16 жовтня, будуть діяти графіки погодинних відключень світла з 06:00 до 23:59.</b>');
  assert.equal(renderUkrenergoNotice(notice).split('\\n').length,1);
});

test('only Kyiv city is not mistakenly treated as Kyiv oblast', () => {
  const text = BASE.replace('у частині регіонів України', 'у Києві');
  assert.equal(parseTomorrowNotice(post(202, text), NOW), null);
  const oblast = BASE.replace('у частині регіонів України', 'у Київській області');
  assert.equal(parseTomorrowNotice(post(203, oblast), NOW).scope, 'kyiv');
});

test('ignore wrong calendar day, old posts, absent tomorrow, industrial-only restrictions', () => {
  assert.equal(parseTomorrowNotice(post(100, BASE.replace('16 ЖОВТНЯ', '17 ЖОВТНЯ')), NOW), null);
  assert.equal(parseTomorrowNotice(post(100, BASE, new Date('2026-10-14T12:10:00Z')), NOW), null);
  assert.equal(parseTomorrowNotice(post(100, BASE.replace('Завтра', 'Сьогодні')), NOW), null);
  assert.equal(parseTomorrowNotice(post(100, BASE.replace(
    /• 06:00 – 23:59 – графіки погодинних відключень.*$/, ''
  )), NOW), null);
});

test('separate heading followed by time is supported', () => {
  const text = [
    'Завтра, 16 ЖОВТНЯ, у всіх регіонах України діятимуть обмеження.',
    'ГРАФІКИ ПОГОДИННИХ ВІДКЛЮЧЕНЬ',
    '• з 08:00 до 22:00 – обсягом від 0,5 до 2 черг',
    'ГРАФІКИ ОБМЕЖЕННЯ ПОТУЖНОСТІ',
    '• з 00:00 до 23:59 – для бізнесу'
  ].join('\n');
  assert.deepEqual(parseTomorrowNotice(post(300, text), NOW).windows, ['08:00–22:00']);
});

test('newest eligible official announcement wins, not stale cached repost', () => {
  const items = [post(20, BASE), post(30, BASE.replace('06:00 – 23:59 – графіки погодинних',
    '07:00 – 21:00 – графіки погодинних'))];
  const result = pickLatestTomorrowNotice(items, NOW);
  assert.equal(result.sourcePostId, 30);
  assert.deepEqual(result.windows, ['07:00–21:00']);
});

test('html reader refuses missing timestamp or fabricated wrong channel', () => {
  assert.throws(() => extractOfficialPosts('<html>empty</html>'), /missing/);
  assert.throws(() => extractOfficialPosts(htmlPost(11).replace(/Ukrenergo\/11/g, 'Other\/11')), /missing/);
});

test('fetches tomorrow notice from public channel with no secrets', async () => {
  let called = 0;
  const result = await fetchTomorrowNotice({
    now: NOW,
    fetchFn: async (url, options) => {
      called++;
      assert.equal(url, UKRENERGO_FEED);
      assert.equal(options.headers.Accept, 'text/html');
      return {ok:true, text:async () => htmlPost(215)};
    }
  });
  assert.equal(called, 1);
  assert.equal(result.date, '2026-10-16');
});

test('requested 18 October format and explicit Kyiv oblast remain concise',()=>{
  const national={
    date:'2026-10-18',scope:'national',windows:['06:00–23:59'],
    sourcePostId:5554,sourceUrl:'https://t.me/Ukrenergo/5554'
  };
  assert.equal(renderUkrenergoNotice(national),
    '💡<b>Завтра, 18 жовтня, будуть діяти графіки погодинних відключень світла з 06:00 до 23:59.</b>');
  assert.equal(renderUkrenergoNotice({...national,scope:'kyiv'}),
    '💡<b>Завтра, 18 жовтня, у Київській області будуть діяти графіки погодинних відключень світла з 06:00 до 23:59.</b>');
});

test('several time windows retain every interval within a single Telegram line',()=>{
  const result=renderUkrenergoNotice({
    date:'2026-12-01',scope:'national',windows:['06:00–10:00','16:00–23:59']
  });
  assert.equal(result,'💡<b>Завтра, 1 грудня, будуть діяти графіки погодинних відключень світла з 06:00 до 10:00 та з 16:00 до 23:59.</b>');
});
