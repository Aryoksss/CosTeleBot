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
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, buildLaunchOpts());

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

    await page.goto(gofileUrl.split('#')[0], { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
    await Promise.race([apiInterception, page.waitForTimeout(8000)]);

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
    console.error(`Gofile resolve error: ${err.message}`);
    return null;
  } finally {
    if (ctx) await ctx.close();
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
async function downloadGofileFile(directUrl, destPath, onProgress = null) {
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, buildLaunchOpts({ acceptDownloads: true }));

    const page = await ctx.newPage();
    await page.goto('about:blank');

    // Mulai listener SEBELUM trigger download event
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });

    // Trigger download via anchor click (paling reliable cross-platform)
    await page.evaluate((url) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
    }, directUrl);

    const download = await downloadPromise;

    // Polling ukuran file sementara Chromium untuk progress bar realistic.
    // download.path() return path cache Chromium, file sudah mulai terisi streaming.
    const tmpPath = await download.path();
    let stopPolling = false;
    const pollTimer = (async () => {
      while (!stopPolling) {
        try {
          if (tmpPath && fs.existsSync(tmpPath)) {
            const s = fs.statSync(tmpPath).size;
            if (onProgress) onProgress(s);
          }
        } catch (_) { }
        await new Promise(r => setTimeout(r, 1500));
      }
    })();

    // Simpan ke path target. Playwright streaming internally — tidak buffer ke RAM.
    await download.saveAs(destPath);
    stopPolling = true;
    await pollTimer;

    // Final progress tick
    if (onProgress && fs.existsSync(destPath)) {
      onProgress(fs.statSync(destPath).size);
    }

    const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
    return size;
  } finally {
    if (ctx) await ctx.close();
  }
}

module.exports = {
  resolveGofile,
  downloadGofileFile
};
