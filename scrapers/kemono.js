// kemono.js — PURE-AXIOS (tanpa Playwright)
//
// Reverse-engineered dari kemono.cr JSON API:
//   - Situs memberi petunjuk sendiri: API butuh header `Accept: text/css`
//     (kalau Accept JSON/HTML → 403 "DDG does not like SPA and JSON").
//   - Profile  : GET /api/v1/<service>/user/<id>/profile        → { post_count }
//   - List     : GET /api/v1/<service>/user/<id>/posts?o=<off>  → [ {id,title,file,attachments} ]
//   - Detail   : GET /api/v1/<service>/user/<id>/post/<postId>  → { post:{file,attachments}, attachments, previews, videos }
//   - Media    : https://<host>/data<path>?f=<name>  (302 → CDN node nX.<host>)
//
// Kontrak ekspor dipertahankan agar telegram-bot.js tidak perlu diubah:
//   getRandomKemonoPost(creatorUrl, chatId) → { title, href }
//   getKemonoPostMedia(postUrl)             → { links: [], inlineImgs: [] }

const axios = require('axios');

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  ok: (m) => console.log(`\x1b[32m[OK]\x1b[0m    ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
  error: (m) => console.log(`\x1b[31m[ERROR]\x1b[0m ${m}`),
};

const PAGE_SIZE = 50; // kemono melayani 50 post per halaman
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Header WAJIB untuk hit JSON API kemono (lihat catatan di atas).
const apiHeaders = (host) => ({
  'accept': 'text/css',
  'user-agent': UA,
  'referer': `https://${host}/`,
});

/**
 * Pecah URL kreator/post kemono → { host, service, id, postId? }
 * Contoh:
 *   https://kemono.cr/patreon/user/3295915
 *   https://kemono.cr/patreon/user/3295915/post/151907256
 */
function parseKemonoUrl(url) {
  const host = (url.match(/^https?:\/\/([^/]+)/i) || [])[1] || 'kemono.cr';
  const m = url.match(/\/([^/]+)\/user\/([^/?#]+)(?:\/post\/([^/?#]+))?/i);
  if (!m) throw new Error(`URL kemono tidak dikenali: ${url}`);
  return { host, service: m[1], id: m[2], postId: m[3] || null };
}

async function apiGet(host, pathAndQuery, retries = 2) {
  const url = `https://${host}${pathAndQuery}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: apiHeaders(host),
        timeout: 25000,
        validateStatus: (s) => s >= 200 && s < 500,
      });
      if (res.status === 200) return res.data;
      lastErr = new Error(`HTTP ${res.status} di ${pathAndQuery}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
  }
  throw lastErr || new Error('Permintaan API kemono gagal');
}

/** Bangun URL unduhan media kanonik (akan 302 ke CDN node). */
function buildMediaUrl(host, file) {
  if (!file || !file.path) return null;
  const name = file.name ? `?f=${encodeURIComponent(file.name)}` : '';
  return `https://${host}/data${file.path}${name}`;
}

/**
 * Ambil satu post acak dari kreator kemono (anti-repeat via history).
 */
async function getRandomKemonoPost(creatorUrl, chatId) {
  const { host, service, id } = parseKemonoUrl(creatorUrl);

  // 1) Total post → untuk offset acak yang merata ke seluruh arsip.
  let totalPosts = PAGE_SIZE;
  try {
    const profile = await apiGet(host, `/api/v1/${service}/user/${id}/profile`);
    if (profile && Number.isFinite(profile.post_count) && profile.post_count > 0) {
      totalPosts = profile.post_count;
    }
  } catch (e) {
    log.warn(`[Kemono] Gagal ambil profile (${e.message}), pakai fallback offset 0.`);
  }
  log.info(`[Kemono] ${service}/${id} → ${totalPosts} post.`);

  // 2) Pilih offset acak (kelipatan PAGE_SIZE).
  const randomIdx = Math.floor(Math.random() * totalPosts);
  const offset = Math.floor(randomIdx / PAGE_SIZE) * PAGE_SIZE;
  log.info(`[Kemono] Mengambil halaman offset ${offset}...`);

  const posts = await apiGet(host, `/api/v1/${service}/user/${id}/posts?o=${offset}`);
  if (!Array.isArray(posts) || posts.length === 0) {
    throw new Error('Tidak ada post yang ditemukan untuk kreator ini.');
  }

  const mapped = posts.map(p => ({
    title: (p.title || 'Untitled').trim(),
    href: `https://${host}/${service}/user/${id}/post/${p.id}`,
  }));

  // 3) Anti-repeat: prioritaskan post yang belum pernah dilihat user.
  const historyTracker = require('../history');
  const unseen = mapped.filter(p => !historyTracker.hasSeen(chatId, 'kemono', p.href));
  const pool = unseen.length > 0 ? unseen : mapped;
  const selected = pool[Math.floor(Math.random() * pool.length)];

  historyTracker.markSeen(chatId, 'kemono', selected.href);
  log.ok(`[Kemono] Post gacha: ${selected.title}`);
  return selected;
}

/**
 * Ekstrak seluruh URL media dari sebuah post kemono.
 * Mengembalikan { links, inlineImgs } supaya kompatibel dengan pemanggil lama
 * (bot menggabung keduanya lalu memfilter ekstensi).
 */
async function getKemonoPostMedia(postUrl) {
  const { host, service, id, postId } = parseKemonoUrl(postUrl);
  if (!postId) throw new Error(`URL post kemono tidak punya postId: ${postUrl}`);

  log.info(`[Kemono] Mengambil media post ${postId} via API...`);
  const detail = await apiGet(host, `/api/v1/${service}/user/${id}/post/${postId}`);

  const post = (detail && detail.post) || {};
  const files = [];
  if (post.file && post.file.path) files.push(post.file);
  if (Array.isArray(post.attachments)) files.push(...post.attachments);
  if (Array.isArray(detail.attachments)) files.push(...detail.attachments);
  // `previews`/`videos` berisi path yang sama; cukup pakai file+attachments.

  const urls = files
    .map(f => buildMediaUrl(host, f))
    .filter(Boolean);

  const dedup = [...new Set(urls)];

  // Pisahkan kasar: gambar → inlineImgs, sisanya (video/zip/lain) → links.
  const isImg = (u) => /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u);
  const inlineImgs = dedup.filter(isImg);
  const links = dedup.filter(u => !isImg(u));

  log.info(`[Kemono] ${inlineImgs.length} gambar + ${links.length} attachment lain.`);
  return { links, inlineImgs };
}

/** Mirror host kemono (urutan prioritas). Semua berbagi backend /data/ yang sama. */
const MIRRORS = ['kemono.cr', 'kemono.su'];

/** Ganti host sebuah URL kemono ke mirror lain (untuk fallback download). */
function mirrorize(url, host) {
  if (!url) return url;
  return url.replace(/^https?:\/\/[^/]+/i, `https://${host}`);
}

module.exports = {
  getRandomKemonoPost,
  getKemonoPostMedia,
  MIRRORS,
  mirrorize,
  // diekspos untuk testing
  parseKemonoUrl,
  buildMediaUrl,
};
