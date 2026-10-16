import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bot = readFileSync(new URL('../src/bot.mjs', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');

test('main publisher restores safe advance switching reminders', () => {
  assert.match(bot, /publishAdvanceReminder\(/);
  assert.match(bot, /reconcileEmergencyReminders\(/);
  assert.match(bot, /updateReminders:\s*process\.env\.ADVANCE_REMINDERS\s*!==\s*'off'/);
  assert.match(workflow, /ADVANCE_REMINDERS:\s*\$\{\{ vars\.ADVANCE_REMINDERS \}\}/);
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
