// This project publishes ONLY to the verified channel supplied by its owner.
// The public channel ID is not a secret. Never print the Telegram bot token.
export const CHANNEL_ID = '-1004349528132';
export const CHANNEL_USERNAME = '@svitlo_kyivshchyna';
export const EXPECTED_BOT = 'svitlo_kyivshchyna_bot';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createTelegramSender({ token, configuredChatId, fetchFn = fetch, logger = console } = {}) {
  const raw = String(configuredChatId || '').trim().replace(/^['"]|['"]$/g, '');
  if (raw && raw !== CHANNEL_ID && raw.toLowerCase() !== CHANNEL_USERNAME.toLowerCase()) {
    logger.warn('⚠️ TELEGRAM_CHAT_ID does not match the confirmed channel. Using verified ID ' + CHANNEL_ID + ' instead.');
  }
  let botChecked = false;

  async function api(method, payload) {
    const options = { signal: AbortSignal.timeout(20000) };
    if (payload) {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(payload);
    }
    const response = await fetchFn('https://api.telegram.org/bot' + token + '/' + method, options);
    const body = await response.json();
    return { status: response.status, body };
  }

  async function verifyBot() {
    if (botChecked) return;
    if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN GitHub Actions secret.');
    const { status, body } = await api('getMe');
    if (status !== 200 || !body?.ok) {
      throw new Error('Telegram getMe failed (HTTP ' + status + '): check TELEGRAM_BOT_TOKEN.');
    }
    const username = String(body.result?.username || '').toLowerCase();
    if (username !== EXPECTED_BOT) {
      throw new Error('Configured token belongs to @' + username + ', but this channel uses @' + EXPECTED_BOT + '. Update TELEGRAM_BOT_TOKEN.');
    }
    botChecked = true;
    logger.log('✅ Telegram bot identity verified: @' + username);
  }

  return async function sendTelegram(message) {
    await verifyBot();
    let lastError = '';
    for (const chatId of [CHANNEL_ID, CHANNEL_USERNAME]) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        let result;
        try {
          result = await api('sendMessage', {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            disable_notification: false
          });
        } catch (error) {
          lastError = 'Network error: ' + String(error?.message || error);
          if (attempt < 3) { await wait(attempt * 1200); continue; }
          break;
        }
        const { status, body } = result;
        if (status === 200 && body?.ok && body.result?.message_id) {
          return body.result.message_id;
        }
        lastError = String(body?.description || 'Unknown Telegram API error');
        if (status === 400 && /chat not found/i.test(lastError)) {
          logger.warn('⚠️ Telegram cannot access channel via ' + chatId + '; trying verified alternative.');
          break;
        }
        if (status !== 429 && status < 500) {
          throw new Error('Telegram HTTP ' + status + ': ' + lastError +
            '. Check that @' + EXPECTED_BOT + ' is a channel administrator with post rights.');
        }
        if (attempt < 3) {
          const retryAfter = Number(body?.parameters?.retry_after || 0);
          await wait(Math.min(30000, Math.max(attempt * 1200, retryAfter * 1000)));
        }
      }
    }
    throw new Error('Telegram cannot publish to ' + CHANNEL_ID + ' / ' + CHANNEL_USERNAME +
      ': ' + lastError + '. Check @' + EXPECTED_BOT + ' is an administrator of the channel with permission to post.');
  };
}
