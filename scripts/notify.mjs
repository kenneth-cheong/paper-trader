// Sends the AI fund's alerts to Telegram (see alerts.js). Runs after the fund's steps, before the
// funds are saved, because it records what it has sent in each fund (fund.notified).
// Usage: node scripts/notify.mjs <ai-fund.json>     send new alerts
//        node scripts/notify.mjs --setup            find your chat and send a test message
// Environment: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (both GitHub secrets), APP_URL (the site's address).
// Alerts can contain your trades, so nothing about them is printed to the (public) Actions log.

import { readFile, writeFile } from 'node:fs/promises';
import { collectAllAlerts, formatMessage } from '../alerts.js';
import { loadFunds } from '../funds.js';

const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId, APP_URL: appUrl } = process.env;
const api = async (method, body) => {
  const res = await fetch(`${process.env.TELEGRAM_API || 'https://api.telegram.org'}/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? `HTTP ${res.status}`}`);
  return json.result;
};
const send = (chat, text) => api('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });

if (process.argv[2] === '--setup') {
  if (!token) throw new Error('Add the TELEGRAM_BOT_TOKEN secret first (see README → Telegram alerts).');
  if (chatId) {
    await send(chatId, '✅ Paper Trader alerts are set up. You\'ll get a message here when trades need your approval, orders fill, stop-losses trigger, and after each trading day.');
    console.log('Sent a test message to your chat. Alerts are ready.');
  } else {
    const updates = await api('getUpdates', {});
    const chat = updates.map((u) => u.message?.chat ?? u.my_chat_member?.chat).filter(Boolean).at(-1);
    if (!chat) {
      console.log('No messages found. In Telegram, open your bot, press Start (or send it any message), then run this again.');
      process.exit(1);
    }
    await send(chat.id, `👋 Paper Trader found this chat. To get alerts here, add a GitHub repository secret named <b>TELEGRAM_CHAT_ID</b> with this value:\n\n<code>${chat.id}</code>\n\nThen run "Set up Telegram alerts" again for a test message.`);
    console.log('Found your chat and sent it its chat id. Add it as the TELEGRAM_CHAT_ID secret, then run this again.');
  }
  process.exit(0);
}

const file = process.argv[2];
let c;
try { c = loadFunds(JSON.parse(await readFile(file, 'utf8'))); } catch { process.exit(0); }
let prices = null;
try { prices = JSON.parse(await readFile('data/prices.json', 'utf8')); } catch { /* summary needs prices; alerts don't */ }

if (!token || !chatId) {
  console.log('Telegram alerts are off (add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to turn them on).');
  process.exit(0);
}
const texts = collectAllAlerts(c, { prices });
try {
  if (texts.length) await send(chatId, formatMessage(texts, appUrl));
  await writeFile(file, JSON.stringify(c));
  console.log(`Telegram: ${texts.length} alert(s) sent.`);
} catch (err) {
  // Not saved as sent, so they go out next run.
  console.warn(`! Telegram alerts not sent (will retry next run): ${err.message}`);
}
