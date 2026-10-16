import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { addDays, kyivDate, kyivMinutes, resolveSchedule, renderDailyMessages, buildTransition, upcomingTransition, renderTransitionTelegram, GROUPS } from './schedule.mjs';
import { fetchSourceJson, validateSource } from './source.mjs';
import { fetchDtekDirect } from './dtek-direct.mjs';
import { selectBestDtekSource, factUpdateKey } from './source-selection.mjs';
import { createTelegramSender } from './telegram.mjs';
import { consolidateLegacyPost } from './consolidate.mjs';
import { publishTomorrowNotice } from './notice-publisher.mjs';
import { claimReminder } from './reminder-claim.mjs';

const DATA_URL = 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv-region.json';
const STATE_FILE = 'state/publications.json';
const DRY_RUN = process.env.DRY_RUN === '1';

async function loadDocument() {
  const mode = process.env.SOURCE_MODE || 'auto';
  let direct = null;
  let backup = null;
  let directError = null, backupError = null;

  // Check both sources concurrently: an updated third-party JSON should not
  // be ignored just because the direct site still exposes an older schedule.
  const tasks = [];
  if (mode !== 'fallback') {
    tasks.push((async () => {
      try {
        const response = await fetchDtekDirect();
        direct = response.data;
        console.log('✅ DIRECT DTEK (' + response.via + '): dates ' +
          response.validDates.join(', ') + '; fact update ' +
          (direct.fact?.update || direct.fact?.updateFact || 'not provided'));
      } catch (error) {
        directError = error;
        console.warn('⚠️ Direct DTEK unavailable: ' + String(error?.message || error));
      }
    })());
  }
  if (mode !== 'direct') {
    tasks.push((async () => {
      try {
        const raw = await fetchSourceJson(DATA_URL);
        const response = validateSource(raw);
        backup = response.data;
        console.log('✅ BACKUP outage-data-ua: snapshot age ' +
          response.ageMinutes + ' min; fact update ' +
          (backup.fact?.update || backup.fact?.updateFact || 'not provided'));
      } catch (error) {
        backupError = error;
        console.warn('⚠️ Backup data unavailable: ' + String(error?.message || error));
      }
    })());
  }
  await Promise.all(tasks);
  if (!direct && !backup) {
    throw new Error('Both schedule sources unavailable: direct=' +
      String(directError?.message || 'disabled') + '; backup=' +
      String(backupError?.message || 'disabled'));
  }
  const chosen = selectBestDtekSource(direct, backup);
  console.log('📊 Selected ' + chosen.kind + ': ' + chosen.reason + '. Fact update key: ' +
    (factUpdateKey(chosen.data) ?? 'unknown'));
  return chosen.data;
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
  const state = await loadState();
  state.events ??= {};
  const now = new Date();
  const today = kyivDate(now);
  const minutesNow = kyivMinutes(now);
  let sent = 0;

  // Official Ukrenergo announces national/region-wide restrictions.
  // Keep this separate from DTEK's subgroup schedules: the two sources
  // represent different facts and have independent deduplication state.
  if (process.env.UKRENERGO_NOTICES !== 'off') {
    try {
      const result = await publishTomorrowNotice({
        state, sender: sendTelegram, save: saveState, now, dryRun: DRY_RUN
      });
      if (result.status === 'published') sent++;
    } catch (error) {
      // Official Telegram's public web layout may change; never allow a
      // fetch/parsing issue to stop the main DTEK schedules.
      console.warn('Ukrenergo notice skipped (main DTEK bot unaffected): ' +
        String(error?.message || error));
    }
  }

  const source = await loadDocument();
  const todayGroups = allGroups(source, today);

  // Refresh only very recent announcements after a display format upgrade.
  // Edit them in place; never publish a second copy of an already sent alert.
  if (!DRY_RUN) {
    for (const [eventKey, event] of Object.entries(state.events)) {
      if ((event.formatVersion || 1) >= 3 || !event.messageId) continue;
      const match = /^(\d{4}-\d{2}-\d{2})@(\d{2}):(\d{2})$/.exec(eventKey);
      if (!match || match[1] !== today) continue;
      const eventMinute = Number(match[2]) * 60 + Number(match[3]);
      if (minutesNow < eventMinute || minutesNow - eventMinute > 120) continue;
      const transition = buildTransition(todayGroups, eventMinute);
      if (!transition) continue;
      const channel = process.env.TELEGRAM_CHANNEL_USERNAME || '@svitlo_kyivshchyna';
      try {
        await sendTelegram.edit(event.messageId, renderTransitionTelegram(today, transition, channel));
        event.formatVersion = 3;
        event.editedAt = new Date().toISOString();
        await saveState(state);
        console.log('Updated recent alert styling without reposting: ' + eventKey);
      } catch (error) {
        console.warn('Unable to update old Telegram alert ' + eventKey + ': ' + String(error?.message || error));
      }
    }
  }

  // Alerts go out BEFORE the scheduled switching time, never at/after it.
  // The lead time depends on GitHub Actions launch delay (10-30 min).
  const tomorrow = addDays(today, 1);
  const tomorrowGroups = allGroups(source, tomorrow);
  const upcoming = upcomingTransition(today, minutesNow, todayGroups, tomorrowGroups);
  if (upcoming) {
    const eventHour = String(Math.floor(upcoming.minute / 60)).padStart(2, '0');
    const eventMinute = String(upcoming.minute % 60).padStart(2, '0');
    const key = upcoming.date + '@' + eventHour + ':' + eventMinute + '#pre30';
    const channel = process.env.TELEGRAM_CHANNEL_USERNAME || '@svitlo_kyivshchyna';
    const message = renderTransitionTelegram(
      upcoming.date, upcoming.transition, channel, upcoming.leadMinutes
    );
    if (DRY_RUN) {
      console.log('\n=== UPCOMING EVENT ' + key + ' ===\n' + message + '\n');
    } else if (!state.events[key]) {
      // State from this checkout can be stale if an earlier run sent
      // a message but failed to push its state. The remote claim is atomic.
      const claim = await claimReminder(key);
      if (!claim.claimed) {
        console.log('Advance reminder already reserved on GitHub, skipping duplicate: ' + key);
        state.events[key] = {
          claimed: true, formatVersion: 5,
          recoveredAt: new Date().toISOString()
        };
        await saveState(state);
      } else {
        const messageId = await sendTelegram(message);
        state.events[key] = {
          messageId, leadMinutes: upcoming.leadMinutes, formatVersion: 5,
          publishedAt: new Date().toISOString()
        };
        await saveState(state);
        console.log('Published advance reminder ' + key + ', ' +
          upcoming.leadMinutes + ' minutes early, message ID ' + messageId);
        sent++;
      }
    } else {
      console.log('Advance reminder already sent: ' + key);
    }
  }

  const dates = [
    { date: today, day: 'сьогодні', byGroup: todayGroups },
    { date: tomorrow, day: 'завтра', byGroup: tomorrowGroups }
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
        if ((previous.formatVersion || 1) < 4 && previous.messageId) {
          // Formatting-only change: update an existing graph in place without notifying again.
          // No new post, no duplicate Telegram notification.
          await sendTelegram.edit(previous.messageId, fragment.message);
          previous.formatVersion = 4;
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
      state.publications[key] = { hash, messageId, formatVersion: 4, publishedAt: new Date().toISOString() };
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
