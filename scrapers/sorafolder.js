'use strict';
/**
 * SoraFolder resolver — PURE AXIOS (tanpa browser/Playwright).
 *
 * Hasil reverse-engineering flow situs:
 *   1. GET /d/<id>               → ambil `keyEncrypte` (JWT) dari HTML.
 *   2. POST /file-down {keyEncrypte} → JSON { url: "<AES-encrypted>" }.
 *   3. Decrypt `url` (format CryptoJS/OpenSSL "Salted__", AES-256-CBC, passphrase statik)
 *      → https://cdn.sorafolder.com/<jwt>.
 *   4. Return URL CDN (file di-stream langsung; signed-link berumur pendek → langsung unduh).
 *
 * Catatan: PASSPHRASE statik di JS SoraFolder. Kalau suatu saat diganti & dekripsi gagal,
 * ekstrak ulang dengan: node tools/soraSniff.js <url>  (lihat request /file-down + responsnya),
 * lalu cari passphrase via hook CryptoJS.AES.decrypt.
 */

const axios = require('axios');
const crypto = require('crypto');

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  ok: (m) => console.log(`\x1b[32m[OK]\x1b[0m    ${m}`),
  error: (m) => console.log(`\x1b[31m[ERROR]\x1b[0m ${m}`),
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Passphrase statik dari decryptLink() di JS SoraFolder (override via env kalau berganti).
const PASSPHRASE = process.env.SORAFOLDER_KEY || 'Ak7qrvvH4WKYxV2OgaeHAEg2a5eh16vE';

const http = axios.create({ headers: { 'User-Agent': UA }, timeout: 30000, validateStatus: () => true, maxRedirects: 5 });

/**
 * Dekripsi format OpenSSL "Salted__" (kompatibel CryptoJS.AES.decrypt(str, passphrase)).
 * KDF: EVP_BytesToKey dengan MD5, cipher AES-256-CBC.
 */
function decryptOpenSSL(b64, pass) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.slice(0, 8).toString('latin1') !== 'Salted__') throw new Error('format ciphertext tak dikenal');
  const salt = raw.slice(8, 16);
  const ct = raw.slice(16);
  let data = Buffer.alloc(0), prev = Buffer.alloc(0);
  while (data.length < 48) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(pass, 'utf8'), salt])).digest();
    data = Buffer.concat([data, prev]);
  }
  const dec = crypto.createDecipheriv('aes-256-cbc', data.slice(0, 32), data.slice(32, 48));
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}

/**
 * Resolve link halaman SoraFolder → direct CDN download URL.
 * @param {string} url  contoh https://sorafolder.com/d/xxxx
 * @returns {Promise<{url: string, filename: string|null}>}
 */
async function getDirectLink(url) {
  // 1) Ambil halaman + keyEncrypte
  const pg = await http.get(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } });
  if (pg.status !== 200) throw new Error(`SoraFolder page HTTP ${pg.status}`);
  const html = String(pg.data);
  if (/file not found|was removed|does not exist/i.test(html) && !/keyEncrypte|Download Your File/i.test(html)) {
    throw new Error('File SoraFolder sudah dihapus / tidak ditemukan (404). Coba sumber lain.');
  }
  const jwt = (html.match(/keyEncrypte\s*=\s*['"]([^'"]+)['"]/) || [])[1];
  if (!jwt) throw new Error('keyEncrypte tidak ditemukan (struktur SoraFolder berubah).');

  // Nama file asli (untuk ekstensi arsip) dari payload JWT.
  let filename = null;
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    filename = payload.file_name || null;
  } catch (_) { /* abaikan */ }

  // 2) POST /file-down → JSON { url: <encrypted> }
  const res = await http.post('https://sorafolder.com/file-down', { keyEncrypte: jwt }, {
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': url,
      'Origin': 'https://sorafolder.com',
      'X-Requested-With': 'XMLHttpRequest',
      'sec-ch-ua': '"Chromium";v="124", "Not:A-Brand";v="8"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  if (res.status !== 200) {
    const msg = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
    throw new Error(`SoraFolder /file-down HTTP ${res.status}: ${msg.slice(0, 160)}`);
  }
  const enc = res.data && res.data.url;
  if (!enc) throw new Error('SoraFolder tidak mengembalikan url terenkripsi: ' + JSON.stringify(res.data).slice(0, 160));

  // 3) Dekripsi → direct CDN URL
  let link;
  try {
    link = decryptOpenSSL(enc, PASSPHRASE).trim();
  } catch (e) {
    throw new Error('Gagal dekripsi link SoraFolder (passphrase mungkin berganti): ' + e.message);
  }
  if (!/^https?:\/\//.test(link)) throw new Error('Hasil dekripsi bukan URL valid.');

  log.ok(`[SoraFolder] direct link: ${link.slice(0, 80)} (file: ${filename || '?'})`);
  return { url: link, filename };
}

module.exports = { getDirectLink };
