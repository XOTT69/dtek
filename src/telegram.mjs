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

  const sendTelegram = async function sendTelegram(message) {
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
          // The request may have reached Telegram even if the response was
          // lost. Retrying sendMessage could publish identical channel posts.
          // Fail closed; the reservation token already prevents another run
          // from blindly reposting an ambiguous delivery.
          throw new Error('Telegram delivery unknown; refusing a duplicate retry: ' +
            String(error?.message || error));
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
        if (status !== 429) {
          // Explicit rate-limit rejection is safe to retry; a 5xx response,
          // malformed 200, or other unknown error is not proof of no post.
          throw new Error('Telegram delivery not confirmed (HTTP ' + status + '): ' +
            lastError + '. Refusing a duplicate retry.');
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

  // Edit an existing message after copy/layout updates without creating
  // another Telegram notification. Only messages from our own bot are edited.
  sendTelegram.edit = async (messageId, text) => {
    await verifyBot();
    if (!Number.isSafeInteger(messageId) || messageId < 1) {
      throw new Error('Invalid Telegram message ID for edit');
    }
    let previousError = '';
    for (const chatId of [CHANNEL_ID, CHANNEL_USERNAME]) {
      try {
        const { status, body } = await api('editMessageText', {
          chat_id: chatId, message_id: messageId, text,
          parse_mode: 'HTML', disable_web_page_preview: true
        });
        if (status === 200 && body?.ok) return true;
        const error = String(body?.description || 'unknown error');
        if (/message is not modified/i.test(error)) return true;
        previousError = 'HTTP ' + status + ': ' + error;
        if (status === 400 && /chat not found/i.test(error)) continue;
        throw new Error(previousError);
      } catch (error) {
        previousError = String(error?.message || error);
        if (chatId === CHANNEL_ID) continue;
      }
    }
    throw new Error('Telegram editMessageText failed for #' + messageId + ': ' + previousError);
  };

  sendTelegram.delete = async (messageId) => {
    await verifyBot();
    if (!Number.isSafeInteger(messageId) || messageId < 1) {
      throw new Error('Invalid Telegram message ID for deletion');
    }
    let previousError = '';
    for (const chatId of [CHANNEL_ID, CHANNEL_USERNAME]) {
      try {
        const { status, body } = await api('deleteMessage', {
          chat_id: chatId, message_id: messageId
        });
        if (status === 200 && body?.ok) return true;
        const problem = String(body?.description || 'unknown');
        if (/message to delete not found/i.test(problem)) return true;
        previousError = 'HTTP ' + status + ': ' + problem;
      } catch (error) {
        previousError = String(error?.message || error);
      }
    }
    throw new Error('Unable to delete old Telegram message #' + messageId + ': ' + previousError);
  };

  return sendTelegram;
}
