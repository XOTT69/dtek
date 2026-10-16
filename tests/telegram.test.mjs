import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramSender, CHANNEL_ID, CHANNEL_USERNAME } from '../src/telegram.mjs';

const ok = (result, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => result });

test('sendMessage uses the confirmed channel ID regardless of a misconfigured secret', async () => {
  const requests = [];
  const sender = createTelegramSender({
    token: 'dummy',
    configuredChatId: '@svitlo_kyivshchyna_bot',
    logger: { log() {}, warn() {} },
    fetchFn: async (url, options) => {
      if (url.endsWith('/getMe')) return ok({ ok: true, result: { username: 'svitlo_kyivshchyna_bot' } });
      const body = JSON.parse(options.body);
      requests.push(body);
      return ok({ ok: true, result: { message_id: 42 } });
    }
  });
  assert.equal(await sender('hello'), 42);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].chat_id, CHANNEL_ID);
});

test('fallback to public channel username when numeric ID is not found', async () => {
  const ids = [];
  const sender = createTelegramSender({
    token: 'dummy',
    logger: { log() {}, warn() {} },
    fetchFn: async (url, options) => {
      if (url.endsWith('/getMe')) return ok({ ok: true, result: { username: 'svitlo_kyivshchyna_bot' } });
      const id = JSON.parse(options.body).chat_id;
      ids.push(id);
      return id === CHANNEL_ID
        ? ok({ ok: false, description: 'Bad Request: chat not found' }, 400)
        : ok({ ok: true, result: { message_id: 9 } });
    }
  });
  assert.equal(await sender('hello'), 9);
  assert.deepEqual(ids, [CHANNEL_ID, CHANNEL_USERNAME]);
});

test('wrong Telegram bot token fails safely before publishing', async () => {
  let sendAttempts = 0;
  const sender = createTelegramSender({
    token: 'dummy',
    logger: { log() {}, warn() {} },
    fetchFn: async url => {
      if (url.endsWith('/getMe')) return ok({ ok: true, result: { username: 'not_our_bot' } });
      sendAttempts++;
      return ok({ ok: true, result: { message_id: 1 } });
    }
  });
  await assert.rejects(sender('hello'), /belongs to/);
  assert.equal(sendAttempts, 0);
});
