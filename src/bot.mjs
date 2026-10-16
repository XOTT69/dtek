import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { addDays, kyivDate, kyivMinutes, resolveSchedule, renderDailyMessages, buildTransition, renderTransitionTelegram, GROUPS } from './schedule.mjs';
import { fetchSourceJson, validateSource } from './source.mjs';
import { createTelegramSender } from './telegram.mjs';
import { consolidateLegacyPost } from './consolidate.mjs';

const DATA_URL = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv-region.json';
const STATE_FILE = 'state/publications.json';
const DRY_RUN = process.env.DRY_RUN === '1';

async function loadDocument() {
  const raw = await fetchSourceJson(DATA_URL);
  const snapshot = validateSource(raw);
  if (snapshot.isFallback) {
    console.warn('⚠️ Upstream DTEK parser is temporarily failing. Using previously parsed snapshot (' +
      snapshot.ageMinutes + ' minutes old; ' + snapshot.snapshotUpdatedAt + ').');
  } else {
    console.log('✅ Outage source OK; snapshot age: ' + snapshot.ageMinutes + ' minutes.');
  }
  return snapshot.data;
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

const sendTelegram = createTelegramSender({
  token: process.env.TELEGRAM_BOT_TOKEN,
  configuredChatId: process.env.TELEGRAM_CHAT_ID
});

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

  // Refresh only very recent announcements after a display format upgrade.
  // Edit them in place; never publish a second copy of an already sent alert.
  if (!DRY_RUN) {
    for (const [eventKey, event] of Object.entries(state.events)) {
      if ((event.formatVersion || 1) >= 2 || !event.messageId) continue;
      const match = /^(\d{4}-\d{2}-\d{2})@(\d{2}):(\d{2})$/.exec(eventKey);
      if (!match || match[1] !== today) continue;
      const eventMinute = Number(match[2]) * 60 + Number(match[3]);
      if (minutesNow < eventMinute || minutesNow - eventMinute > 120) continue;
      const transition = buildTransition(todayGroups, eventMinute);
      if (!transition) continue;
      const channel = process.env.TELEGRAM_CHANNEL_USERNAME || '@svitlo_kyivshchyna';
      try {
        await sendTelegram.edit(event.messageId, renderTransitionTelegram(today, transition, channel));
        event.formatVersion = 2;
        event.editedAt = new Date().toISOString();
        await saveState(state);
        console.log('Updated recent alert styling without reposting: ' + eventKey);
      } catch (error) {
        console.warn('Unable to update old Telegram alert ' + eventKey + ': ' + String(error?.message || error));
      }
    }
  }

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
      // Upgrade existing two-part posts in place before deciding to send.
      if (!DRY_RUN && key.endsWith('/all')) {
        await consolidateLegacyPost({
          state, fragment, hash, sender: sendTelegram, save: saveState
        });
      }
      if (state.publications[key]?.hash === hash && !DRY_RUN) {
        const previous = state.publications[key];
        if ((previous.formatVersion || 1) < 2 && previous.messageId) {
          // Formatting-only change: remove unwanted footers in place.
          // No new post, no duplicate Telegram notification.
          await sendTelegram.edit(previous.messageId, fragment.message);
          previous.formatVersion = 2;
          previous.editedAt = new Date().toISOString();
          await saveState(state);
          console.log('Edited published message without reposting: ' + key);
        } else {
          console.log('Unchanged: ' + key);
        }
        continue;
      }
      if (DRY_RUN) {
        console.log('\n=== ' + key + ' ===\n' + fragment.message + '\n');
        continue;
      }
      const messageId = await sendTelegram(fragment.message);
      state.publications[key] = { hash, messageId, formatVersion: 2, publishedAt: new Date().toISOString() };
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
