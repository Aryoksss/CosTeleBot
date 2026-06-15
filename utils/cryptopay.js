'use strict';

/**
 * Crypto Pay (CryptoBot) client — pembayaran crypto anonim untuk fitur Premium.
 *
 * Setup: chat @CryptoBot → Crypto Pay → Create App → salin API Token ke .env:
 *   CRYPTOPAY_TOKEN=12345:AA....
 *   CRYPTOPAY_ASSET=USDT          (opsional, default USDT)
 *   CRYPTOPAY_TESTNET=0           (1 = pakai testnet @CryptoTestnetBot)
 *
 * Dok: https://help.crypt.bot/crypto-pay-api
 * Auth: header `Crypto-Pay-API-Token`.
 */

const axios = require('axios');

const log = {
  info: (m) => console.log(`\x1b[36m[CryptoPay]\x1b[0m ${m}`),
  warn: (m) => console.log(`\x1b[33m[CryptoPay]\x1b[0m ${m}`),
  err: (m) => console.error(`\x1b[31m[CryptoPay]\x1b[0m ${m}`),
};

function token() { return process.env.CRYPTOPAY_TOKEN || ''; }
function isEnabled() { return !!token(); }
function baseUrl() {
  return process.env.CRYPTOPAY_TESTNET === '1'
    ? 'https://testnet-pay.crypt.bot/api'
    : 'https://pay.crypt.bot/api';
}
function asset() { return process.env.CRYPTOPAY_ASSET || 'USDT'; }

async function _call(method, params = {}) {
  if (!isEnabled()) throw new Error('CRYPTOPAY_TOKEN belum di-set');
  const res = await axios.post(`${baseUrl()}/${method}`, params, {
    headers: { 'Crypto-Pay-API-Token': token(), 'Content-Type': 'application/json' },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (res.status !== 200 || !res.data || res.data.ok !== true) {
    const errName = res.data?.error?.name || `HTTP ${res.status}`;
    throw new Error(`Crypto Pay ${method} gagal: ${errName}`);
  }
  return res.data.result;
}

/**
 * Buat invoice. Return { invoice_id, status, pay_url, amount, asset, ... }.
 * @param {number} amount  jumlah dalam asset (mis. 2 = 2 USDT)
 * @param {string} description
 * @param {string} payload  data internal (mis. "chatId:days"), dikembalikan saat cek status
 */
async function createInvoice(amount, description, payload) {
  const result = await _call('createInvoice', {
    asset: asset(),
    amount: String(amount),
    description: String(description).slice(0, 1024),
    payload: String(payload).slice(0, 4096),
    allow_comments: false,
    allow_anonymous: true,
    expires_in: 3600, // 1 jam
  });
  log.info(`invoice #${result.invoice_id} ${amount} ${asset()} dibuat`);
  return result;
}

/** Ambil 1 invoice by id → object invoice atau null. */
async function getInvoice(invoiceId) {
  const result = await _call('getInvoices', { invoice_ids: String(invoiceId) });
  const items = result.items || [];
  return items[0] || null;
}

/** Cek apakah invoice sudah dibayar. */
async function isPaid(invoiceId) {
  const inv = await getInvoice(invoiceId);
  return inv && inv.status === 'paid';
}

/** Info app (buat verifikasi token saat startup). */
async function getMe() {
  return _call('getMe', {});
}

module.exports = { isEnabled, createInvoice, getInvoice, isPaid, getMe, asset };
