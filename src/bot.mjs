import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { addDays, kyivDate, kyivMinutes, resolveSchedule, renderDailyMessages, buildTransition, renderTransitionTelegram, GROUPS } from './schedule.mjs';

const DATA_URL = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv-region.json';
const STATE_FILE = 'state/publications.json';
const DRY_RUN = process.env.DRY_RUN === '1';

async function loadDocument() {
  const response = await fetch(DATA_URL, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('Source HTTP ' + response.status);
  const data = await response.json();
  if (data?.regionId !== 'kyiv-region' || !data.fact?.data || !data.preset?.data) {
    throw new Error('Unexpected source JSON schema');
  }
  if (data.lastUpdateStatus?.ok === false) {
    throw new Error('Upstream parser reports failure; publishing is paused');
  }
  const time = Date.parse(data.lastUpdated);
  if (!Number.isFinite(time)) throw new Error('Missing source lastUpdated');
  const age = Date.now() - time;
  if (age > 48 * 3600 * 1000 || age < -10 * 60 * 1000) {
    throw new Error('Source data is too old or has an invalid future timestamp');
  }
  return data;
}

async function loadState() {
  try {
    const data = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    if (!data || typeof data !== 'object' || !data.publications) return { publications: {} };
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { publications: {} };
    throw error;
  }
}

async function saveState(state) {
  await fs.mkdir('state', { recursive: true });
  const target = STATE_FILE + '.tmp';
  await fs.writeFile(target, JSON.stringify(state, null, 2) + '\n');
  await fs.rename(target, STATE_FILE);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Actions secrets');
  for (let attempt = 1; attempt <= 4; attempt++) {
    let response;
    let body;
    try {
      response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, text: message, parse_mode: 'HTML',
          disable_web_page_preview: true, disable_notification: false
        }),
        signal: AbortSignal.timeout(20000)
      });
      body = await response.json();
    } catch (error) {
      if (attempt === 4) throw new Error('Telegram connection failed: ' + error.message);
      await sleep(1000 * attempt);
      continue;
    }
    if (response.ok && body.ok && body.result?.message_id) return body.result.message_id;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 4) {
      throw new Error('Telegram API HTTP ' + response.status + ': ' + String(body?.description || 'unknown error'));
    }
    await sleep(Math.min(30000, Math.max(1000 * attempt, Number(body?.parameters?.retry_after || 0) * 1000)));
  }
  throw new Error('Unable to publish Telegram message');
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function allGroups(document, date) {
  return Object.fromEntries(GROUPS.map(group => [group, resolveSchedule(document, date, group)]));
}

function cleanOldState(state, today) {
  for (const key of Object.keys(state.publications)) {
    const oldDate = key.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(oldDate) && oldDate < addDays(today, -7)) {
      delete state.publications[key];
    }
  }
  for (const key of Object.keys(state.events)) {
    const oldDate = key.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(oldDate) && oldDate < addDays(today, -2)) {
      delete state.events[key];
    }
  }
}

async function main() {
  const source = await loadDocument();
  const state = await loadState();
  state.events ??= {};
  const now = new Date();
  const today = kyivDate(now);
  const minutesNow = kyivMinutes(now);
  const todayGroups = allGroups(source, today);
  let sent = 0;

  // An hourly/half-hour alert is sent only near the transition time, never
  // based on tentative preset. No retrospective backlog when starting a bot.
  const slotStart = Math.floor(minutesNow / 30) * 30;
  const delayMinutes = minutesNow - slotStart;
  if (slotStart > 0 && delayMinutes <= 17) {
    const transition = buildTransition(todayGroups, slotStart);
    if (transition) {
      const key = today + '@' + String(Math.floor(slotStart / 60)).padStart(2, '0') +
        ':' + String(slotStart % 60).padStart(2, '0');
      const channel = process.env.TELEGRAM_CHANNEL_USERNAME ||
        (process.env.TELEGRAM_CHAT_ID?.startsWith('@') ? process.env.TELEGRAM_CHAT_ID : '');
      const message = renderTransitionTelegram(today, transition, channel);
      if (DRY_RUN) {
        console.log('\n=== EVENT ' + key + ' ===\n' + message + '\n');
      } else if (!state.events[key]) {
        const messageId = await sendTelegram(message);
        state.events[key] = { messageId, publishedAt: new Date().toISOString() };
        await saveState(state);
        console.log('Published transition ' + key + ', message ID ' + messageId);
        sent++;
      } else {
        console.log('Transition already sent: ' + key);
      }
    }
  }

  const dates = [
    { date: today, day: 'сьогодні', byGroup: todayGroups },
    { date: addDays(today, 1), day: 'завтра', byGroup: null }
  ];
  for (const item of dates) {
    const byGroup = item.byGroup || allGroups(source, item.date);
    const messages = renderDailyMessages(item.date, item.day, byGroup, source);
    for (const fragment of messages) {
      const key = fragment.key;
      const hash = hashText(fragment.fingerprint);
      if (state.publications[key]?.hash === hash && !DRY_RUN) {
        console.log('Unchanged: ' + key);
        continue;
      }
      if (DRY_RUN) {
        console.log('\n=== ' + key + ' ===\n' + fragment.message + '\n');
        continue;
      }
      const messageId = await sendTelegram(fragment.message);
      state.publications[key] = { hash, messageId, publishedAt: new Date().toISOString() };
      cleanOldState(state, today);
      await saveState(state);
      console.log('Published ' + key + ', Telegram message ID ' + messageId);
      sent++;
    }
  }
  console.log('Finished. New messages: ' + sent);
}

main().catch(error => {
  console.error('Schedule publication failed: ' + error.message);
  process.exitCode = 1;
});
