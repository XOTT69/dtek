import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bot = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');

test('main publisher does not send scheduled HH:00/HH:30 or pre-30-minute reminders', () => {
  assert.doesNotMatch(bot, /\bupcomingTransition\s*\(/);
  assert.doesNotMatch(bot, /\bclaimReminder\s*\(/);
  assert.doesNotMatch(bot, /\breconcileEmergencyReminders\s*\(/);
  assert.doesNotMatch(bot, /\brenderTransitionTelegram\s*\(/);
  assert.match(bot, /updateReminders:\s*false/);
});

test('main publisher still posts changed full DTEK schedules and corrections', () => {
  assert.match(bot, /renderDailyMessages\(/);
  assert.match(bot, /claimScheduleUpdate\(/);
  assert.match(bot, /publishScheduleCorrection\(/);
  assert.match(bot, /publishEmergencyUpdate\(/);
  assert.match(bot, /publishTomorrowNotice\(/);
  assert.match(bot, /reconcileEmergencyDaily\(/);
});

test('GitHub-only scheduled polling remains, no Worker dispatch dependency', () => {
  assert.match(workflow, /cron: '\*\/5 \* \* \* \*'/);
  assert.match(workflow, /run: node src\/bot\.mjs/);
  assert.doesNotMatch(workflow, /Cloudflare|DTEK_GITHUB_TOKEN|botvoda/);
});
