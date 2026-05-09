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
 * Download file Gofile via axios streaming (tidak buffer ke RAM — aman untuk file 1GB+).
 * Gofile CDN butuh `Authorization: Bearer <accountToken>` yang didapat dari resolveGofile().
 *
 * @param {string} directUrl    direct link dari resolveGofile (store*.gofile.io/...)
 * @param {string} destPath     path file tujuan
 * @param {function} [onProgress] (downloadedBytes, totalBytes) => void — dipanggil tiap ~1 detik
 * @param {string} [accountToken] Gofile account token (dari resolveGofile().accountToken)
 * @returns {Promise<number>}   ukuran file akhir dalam byte
 */
async function downloadGofileFile(directUrl, destPath, onProgress = null, accountToken = null) {
  const axios = require('axios');
  const proxy = getProxyConfig();
  console.log(`[Gofile-DL] START url=${directUrl.slice(0, 80)}... proxy=${proxy ? proxy.server : 'none'}`);

  if (!accountToken) {
    // Fallback: kalau caller tidak forward, coba ambil dari persistent profile cookies.
    // Butuh spawn Playwright sekali — lebih lambat tapi tetap works.
    console.log(`[Gofile-DL] accountToken tidak di-forward, ambil dari cookies disk...`);
    let tmpCtx;
    try {
      tmpCtx = await chromium.launchPersistentContext(PROFILE_DIR, buildLaunchOpts());
      const cookies = await tmpCtx.cookies();
      const c = cookies.find(x => x.name === 'accountToken');
      if (c) accountToken = c.value;
    } finally {
      if (tmpCtx) await tmpCtx.close().catch(() => { });
    }
  }
  console.log(`[Gofile-DL] accountToken: ${accountToken ? '***(' + accountToken.length + ' chars)' : 'NONE'}`);

  // Siapkan proxy agent untuk axios jika GOFILE_PROXY di-set (SOCKS5/HTTP).
  const reqCfg = {
    method: 'GET',
    url: directUrl,
    responseType: 'stream',
    timeout: 3600000, // 1 jam untuk file raksasa
    headers: {
      'User-Agent': UA,
      'Referer': 'https://gofile.io/',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    // maxContentLength: infinity ensures axios doesn't cut big files
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true,
  };
  if (accountToken) reqCfg.headers['Authorization'] = `Bearer ${accountToken}`;
  if (proxy) {
    try {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const { SocksProxyAgent } = require('socks-proxy-agent');
      const proxyUrl = proxy.username
        ? `${proxy.server.replace('://', `://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`)}`
        : proxy.server;
      reqCfg.httpsAgent = proxy.server.startsWith('socks')
        ? new SocksProxyAgent(proxyUrl)
        : new HttpsProxyAgent(proxyUrl);
      reqCfg.httpAgent = reqCfg.httpsAgent;
      console.log(`[Gofile-DL] axios via proxy agent: ${proxy.server}`);
    } catch (e) {
      console.log(`[Gofile-DL] proxy agent load gagal (${e.message}), fallback no-proxy`);
    }
  }

  console.log(`[Gofile-DL] axios GET streaming...`);

  // Retry loop untuk 429 (rate-limit per CDN node) dan 5xx. Max 3 attempt dengan backoff 3s/6s/12s.
  const MAX_RETRIES = 3;
  let res = null;
  let lastAttemptErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      res = await axios(reqCfg);
      const status = res.status;
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (!retriable) break; // sukses atau error non-retriable, lanjut

      // Log body singkat untuk visibility (biasanya pesan rate-limit dari CDN)
      let bodyPreview = '';
      try {
        const chunks = [];
        for await (const c of res.data) { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 500) break; }
        bodyPreview = Buffer.concat(chunks).toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
      } catch (_) { }
      console.log(`[Gofile-DL] attempt ${attempt}/${MAX_RETRIES} → HTTP ${status} body="${bodyPreview}"`);

      if (attempt === MAX_RETRIES) {
        throw new Error(`Gofile CDN HTTP ${status} setelah ${MAX_RETRIES} retry: ${bodyPreview || '(empty)'}`);
      }
      const retryAfter = parseInt(res.headers['retry-after'] || '0', 10);
      const backoff = retryAfter > 0 ? Math.min(retryAfter * 1000, 30000) : Math.pow(2, attempt) * 3000;
      console.log(`[Gofile-DL] retry dalam ${backoff}ms...`);
      await new Promise(r => setTimeout(r, backoff));
    } catch (e) {
      if (e.message && e.message.startsWith('Gofile CDN HTTP')) throw e; // sudah kita format
      lastAttemptErr = e;
      if (attempt === MAX_RETRIES) throw e;
      console.log(`[Gofile-DL] attempt ${attempt} network error: ${e.message}, retry...`);
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 2000));
    }
  }

  const status = res.status;
  const ct = String(res.headers['content-type'] || '').toLowerCase();
  const total = parseInt(res.headers['content-length'] || '0', 10);
  console.log(`[Gofile-DL] response status=${status} content-type=${ct} content-length=${total} (${(total / 1048576).toFixed(1)}MB)`);

  if (status !== 200) {
    try { res.data.destroy(); } catch (_) { }
    throw new Error(`Gofile CDN HTTP ${status}`);
  }
  if (ct.startsWith('text/html') || ct.startsWith('text/plain')) {
    // Baca body sebagai text untuk error message yang berguna
    let body = '';
    try {
      const chunks = [];
      for await (const c of res.data) chunks.push(c);
      body = Buffer.concat(chunks).toString('utf8').slice(0, 300).replace(/\s+/g, ' ');
    } catch (_) { }
    throw new Error(`Gofile CDN balas ${ct} (bukan binary). Body: ${body || '(empty)'}. Mungkin link expired, rate-limit, atau IP VPS di-block.`);
  }

  // Stream ke disk dengan progress callback tiap ~1 detik.
  return await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    let downloaded = 0;
    let lastTick = Date.now();
    res.data.on('data', (chunk) => {
      downloaded += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick >= 1000) {
        onProgress(downloaded, total);
        lastTick = now;
      }
    });
    res.data.on('error', (err) => {
      writer.close();
      if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch (_) { } }
      reject(new Error(`Stream error: ${err.message}`));
    });
    writer.on('error', (err) => {
      try { res.data.destroy(); } catch (_) { }
      if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch (_) { } }
      reject(new Error(`Write error: ${err.message}`));
    });
    writer.on('finish', () => {
      if (onProgress) onProgress(downloaded, total); // tick final
      const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
      console.log(`[Gofile-DL] END size=${(size / 1048576).toFixed(1)}MB downloaded=${(downloaded / 1048576).toFixed(1)}MB`);
      resolve(size);
    });
    res.data.pipe(writer);
  });
}

module.exports = {
  resolveGofile,
  downloadGofileFile
};
