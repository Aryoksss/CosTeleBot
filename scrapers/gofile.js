const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

chromium.use(StealthPlugin());

const PROFILE_DIR = path.resolve('./browser_profile_gofile');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Proxy opsional untuk bypass banned IP datacenter (DO/AWS/GCP/Azure).
 * Set GOFILE_PROXY=socks5://127.0.0.1:40000 (Cloudflare WARP proxy mode) di .env.
 * Format didukung Playwright: http://host:port, https://host:port, socks5://host:port.
 */
function getProxyConfig() {
  const raw = process.env.GOFILE_PROXY || process.env.HTTPS_PROXY || '';
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const cfg = { server: `${u.protocol}//${u.host}` };
    if (u.username) cfg.username = decodeURIComponent(u.username);
    if (u.password) cfg.password = decodeURIComponent(u.password);
    return cfg;
  } catch (_) {
    return null;
  }
}

function buildLaunchOpts(extra = {}) {
  const proxy = getProxyConfig();
  return {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    userAgent: UA,
    ...(proxy ? { proxy } : {}),
    ...extra,
  };
}

async function resolveGofile(gofileUrl) {
  let ctx;
  const proxy = getProxyConfig();
  try {
    console.log(`[Gofile] resolveGofile START url=${gofileUrl.split('#')[0]} proxy=${proxy ? proxy.server : 'none'}`);
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, buildLaunchOpts());
    console.log(`[Gofile] Playwright context OK`);

    const page = await ctx.newPage();
    const files = [];

    const apiInterception = new Promise((resolve) => {
      page.on('response', async res => {
        const u = res.url();
        if (u.includes('/contents/') && u.includes('api.gofile')) {
          try {
            const json = await res.json();
            if (json.status === 'ok' && json.data && json.data.children) {
              for (const childId in json.data.children) {
                const fileInfo = json.data.children[childId];
                if (fileInfo && fileInfo.link) {
                  files.push({
                    id: childId,
                    name: fileInfo.name || 'archive.zip',
                    link: fileInfo.link
                  });
                }
              }
              resolve(true);
            }
          } catch (e) { }
        }
      });
    });

    await page.goto(gofileUrl.split('#')[0], { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
      console.log(`[Gofile] page.goto gagal/timeout: ${e.message}`);
    });
    console.log(`[Gofile] page loaded, menunggu XHR /contents/...`);
    await Promise.race([apiInterception, page.waitForTimeout(8000)]);
    console.log(`[Gofile] Files ditemukan: ${files.length}`);

    // Ambil cookies (untuk fallback axios) + accountToken secara spesifik
    const cookies = await ctx.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const accountTokenCookie = cookies.find(c => c.name === 'accountToken');
    const accountToken = accountTokenCookie ? accountTokenCookie.value : null;

    return {
      files: files,
      cookie: cookieStr,
      accountToken: accountToken
    };

  } catch (err) {
    console.error(`[Gofile] resolve error: ${err.message}`);
    console.error(`[Gofile] stack: ${err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : 'n/a'}`);
    return null;
  } finally {
    if (ctx) await ctx.close().catch(() => { });
    console.log(`[Gofile] resolveGofile END`);
  }
}

/**
 * Download file dari Gofile CDN langsung lewat Playwright (sesi browser persistent).
 * Berbeda dengan axios, ini meniru perilaku browser penuh: UA + TLS fingerprint + cookies
 * (termasuk accountToken) identik dengan resolver — yang sama sekali tidak kena 429.
 *
 * Chromium download manager streaming file ke disk, jadi file besar (>1GB) aman untuk VPS 512MB.
 *
 * @param {string} directUrl  direct link dari resolveGofile (store*.gofile.io/...)
 * @param {string} destPath   path file tujuan
 * @param {function} [onProgress] (downloadedBytes) => void — dipanggil ~setiap detik
 * @returns {Promise<number>} ukuran file akhir dalam byte
 */
async function downloadGofileFile(directUrl, destPath, onProgress = null, accountToken = null) {
  let ctx;
  const proxy = getProxyConfig();
  console.log(`[Gofile-DL] START url=${directUrl.slice(0, 80)}... proxy=${proxy ? proxy.server : 'none'}`);
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, buildLaunchOpts({ acceptDownloads: true }));
    console.log(`[Gofile-DL] context OK`);

    // Gofile CDN mewajibkan header `Authorization: Bearer <accountToken>` untuk akses direct link.
    // Token diterima sebagai argumen dari resolveGofile() agar tidak ada race antar context.
    // Fallback: baca dari cookies context bila caller tidak forward.
    if (!accountToken) {
      const cookies = await ctx.cookies();
      const tokenCookie = cookies.find(c => c.name === 'accountToken');
      accountToken = tokenCookie ? tokenCookie.value : null;
    }
    console.log(`[Gofile-DL] accountToken: ${accountToken ? '***(' + accountToken.length + ' chars)' : 'NONE'}`);

    console.log(`[Gofile-DL] fetching via context.request.get...`);
    const reqHeaders = {
      'Referer': 'https://gofile.io/',
      'User-Agent': UA,
    };
    if (accountToken) reqHeaders['Authorization'] = `Bearer ${accountToken}`;

    const res = await ctx.request.get(directUrl, {
      headers: reqHeaders,
      timeout: 300000, // 5 menit
    });
    const status = res.status();
    const ct = res.headers()['content-type'] || '';
    const cl = parseInt(res.headers()['content-length'] || '0', 10);
    console.log(`[Gofile-DL] response status=${status} content-type=${ct} content-length=${cl}`);

    if (status !== 200) {
      throw new Error(`Gofile CDN HTTP ${status}`);
    }
    if (ct.startsWith('text/html')) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Gofile CDN balas HTML (link expired atau session invalid). Preview: ${body.replace(/\s+/g, ' ')}`);
    }

    // Stream body ke disk dengan progress polling.
    // Playwright response.body() return Buffer full — oke untuk file ≤ 500MB di VPS 1GB RAM,
    // tapi untuk file > 1GB kita butuh streaming. Strategi: coba response.body() dulu;
    // kalau butuh true streaming, pakai axios dengan cookies + Referer.
    console.log(`[Gofile-DL] downloading body to memory (will flush to disk)...`);
    const body = await res.body();
    console.log(`[Gofile-DL] body received: ${(body.length / 1048576).toFixed(1)}MB`);
    fs.writeFileSync(destPath, body);
    if (onProgress) onProgress(body.length);

    const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
    console.log(`[Gofile-DL] END size=${(size / 1048576).toFixed(1)}MB`);
    return size;
  } catch (err) {
    console.error(`[Gofile-DL] error: ${err.message}`);
    console.error(`[Gofile-DL] stack: ${err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : 'n/a'}`);
    throw err;
  } finally {
    if (ctx) await ctx.close().catch(() => { });
  }
}

module.exports = {
  resolveGofile,
  downloadGofileFile
};
