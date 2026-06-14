'use strict';

/**
 * Health ping untuk cron: cek semua sumber, kalau ada yang DOWN (status 'error')
 * kirim alert ke Telegram admin. Sumber 'warn' (rate-limit) diabaikan biar tidak berisik.
 *
 * Pakai:
 *   node tools/healthPing.js
 * Cron (tiap jam):
 *   0 * * * * cd /root/CosTeleBot && node tools/healthPing.js >> health.log 2>&1
 *
 * Chat tujuan: DEPLOY_NOTIFY_CHAT, fallback ke ADMIN_IDS pertama.
 */

require('dotenv').config();
const path = require('path');
const healthcheck = require(path.join(__dirname, '..', 'utils', 'healthcheck'));

function sendTelegram(token, chatId, text) {
  const body = new URLSearchParams({ chat_id: String(chatId), text }).toString();
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }).catch(() => { });
}

(async () => {
  try {
    const results = await healthcheck.checkAllSources();
    const down = results.filter(r => r.status === 'error');

    if (down.length === 0) {
      console.log(`[healthPing] ${new Date().toISOString()} — semua sehat (${results.length} sumber)`);
      return;
    }

    const lines = down.map(r => `• ${r.name}: ${r.note}`).join('\n');
    const msg = `⚠️ CosTeleBot health-check: ${down.length}/${results.length} sumber bermasalah\n${lines}`;
    console.log(msg);

    const token = process.env.BOT_TOKEN;
    const chat = (process.env.DEPLOY_NOTIFY_CHAT || (process.env.ADMIN_IDS || '').split(',')[0] || '').trim();
    if (token && chat) await sendTelegram(token, chat, msg);
  } catch (e) {
    console.error(`[healthPing] error: ${e.message}`);
  }
})();
