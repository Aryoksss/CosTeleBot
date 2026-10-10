const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const crypto = require('crypto');

chromium.use(StealthPlugin());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * X-Website-Token: header WAJIB yang dibutuhkan API gofile (selain Authorization Bearer).
 * Tanpa ini, API balas 401 "error-notPremium" meski token guest valid — ini BUKAN soal
 * premium, murni header yang kurang. Formula reverse-engineered dari proyek open-source
 * ltsdw/gofile-downloader: sha256(`${userAgent}::en-US::${accountToken}::${timeSlot}::9844d94d963d30`)
 * timeSlot = jam Unix dibagi 14400 (4 jam) → token valid per window 4 jam.
 */
function generateWebsiteToken(userAgent, accountToken) {
  const timeSlot = Math.floor(Date.now() / 1000 / 14400);
  const raw = `${userAgent}::en-US::${accountToken || ''}::${timeSlot}::9844d94d963d30`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Token akun Gofile milik sendiri (Profile → API token di gofile.io).
 * Kalau di-set, dipakai untuk listing + download → BYPASS limit guest 1000GB/30hari
 * yang berbasis IP (WARP/shared IP cepat habis). Premium account = tanpa limit.
 */
const ACCOUNT_TOKEN = (process.env.GOFILE_TOKEN || '').trim() || null;

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

/**
 * Ubah response `data` dari /contents/{id} jadi flat list {id, name, link}.
 * Handle 2 bentuk: single file (data.type !== 'folder') atau folder dengan `children`
 * (yang bisa nested subfolder — rekursif).
 */
function collectGofileFiles(data) {
  const out = [];
  if (!data) return out;
  if (data.type && data.type !== 'folder' && data.link) {
    out.push({ id: data.id, name: data.name || 'file', link: data.link });
    return out;
  }
  const children = data.children || {};
  for (const cid in children) {
    const child = children[cid];
    if (!child) continue;
    if (child.type === 'folder') out.push(...collectGofileFiles(child));
    else if (child.link) out.push({ id: child.id || cid, name: child.name || 'file', link: child.link });
  }
  return out;
}

async function resolveGofile(gofileUrl) {
  let ctx;
  let browser;
  const proxy = getProxyConfig();

  // Strategi: setiap resolve pakai context BARU (non-persistent) agar Gofile ngasih
  // accountToken guest fresh. Ini bypass limit 1000GB/30-hari karena setiap download
  // counter-nya nol (account baru). Persistent profile di-skip untuk Gofile karena
  // lebih banyak mudarat (quota expired) daripada manfaat (cached cookies tidak perlu
  // untuk situs yang guest-auto).
  try {
    console.log(`[Gofile] resolveGofile START url=${gofileUrl.split('#')[0]} proxy=${proxy ? proxy.server : 'none'} (fresh guest)`);
    // launch() bukan launchPersistentContext — tidak akan bikin/pakai disk profile.
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...(proxy ? { proxy } : {}),
    });
    ctx = await browser.newContext({ userAgent: UA });
    console.log(`[Gofile] fresh context OK`);

    const page = await ctx.newPage();
    let files = [];

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
    const intercepted = await Promise.race([
      apiInterception,
      page.waitForTimeout(8000).then(() => false),
    ]);
    if (intercepted === false && files.length === 0) {
      console.log(`[Gofile] intercept timeout: XHR /contents/ tidak terlihat dalam 8s (fallback ke Node-side API)`);
    }
    console.log(`[Gofile] Files ditemukan: ${files.length}`);

    // Ambil daftar file via API DARI NODE (axios), BUKAN dari dalam browser.
    // Alasan: page.evaluate(fetch) ikut jalur network browser (termasuk proxy/WARP kalau
    // di-set) — kalau proxy itu bermasalah reach ke api.gofile.io, browser cuma kasih error
    // generik "Failed to fetch" tanpa detail. axios di Node terpisah dari proxy resolve
    // (default tanpa proxy untuk API call), jadi lebih robust + errornya lebih informatif.
    // Mode default = GUEST ROTATE: tiap resolve bikin akun guest BARU (POST /accounts)
    // → token fresh. Kalau GOFILE_TOKEN di-set, pakai itu (akun sendiri/premium).
    let apiToken = null;
    {
      const contentId = (gofileUrl.match(/\/d\/([\w-]+)/) || [])[1];
      if (contentId) {
        console.log(`[Gofile] Node-side API fetch (id=${contentId}, mode=${ACCOUNT_TOKEN ? 'GOFILE_TOKEN' : 'guest-rotate'})...`);
        try {
          const axiosLib = require('axios');
          let tk = ACCOUNT_TOKEN;
          if (!tk) {
            try {
              const wtCreate = generateWebsiteToken(UA, '');
              const acc = await axiosLib.post('https://api.gofile.io/accounts', {}, {
                headers: {
                  'Content-Type': 'application/json', 'User-Agent': UA,
                  'X-Website-Token': wtCreate, 'X-BL': 'en-US',
                  'Origin': 'https://gofile.io', 'Referer': 'https://gofile.io/',
                },
                timeout: 15000, validateStatus: () => true,
              });
              tk = (acc.data && acc.data.data && acc.data.data.token) || null;
            } catch (e) { console.log(`[Gofile] gagal buat guest token: ${e.message}`); }
          }
          if (tk) {
            // WAJIB: X-Website-Token (hash) + X-BL, bukan cuma Authorization Bearer.
            // Tanpa ini API balas 401 "error-notPremium" meski token valid.
            const wtContents = generateWebsiteToken(UA, tk);
            const r = await axiosLib.get(`https://api.gofile.io/contents/${contentId}?cache=true&sortField=createTime&sortDirection=1`, {
              headers: {
                'Authorization': `Bearer ${tk}`, 'User-Agent': UA,
                'X-Website-Token': wtContents, 'X-BL': 'en-US',
                'Origin': 'https://gofile.io', 'Referer': 'https://gofile.io/',
              },
              timeout: 15000, validateStatus: () => true,
            });
            if (r.status === 200 && r.data && r.data.status === 'ok' && r.data.data) {
              const apiFiles = collectGofileFiles(r.data.data);
              if (apiFiles.length) { files = apiFiles; apiToken = tk; }
              console.log(`[Gofile] API fetch → ${apiFiles.length} file (dipakai: ${files.length})`);
            } else {
              console.log(`[Gofile] API fetch gagal: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 150)} — fallback ke hasil intercept (${files.length} file)`);
            }
          } else {
            console.log(`[Gofile] tidak ada token tersedia untuk API fetch — fallback ke hasil intercept (${files.length} file)`);
          }
        } catch (e) {
          console.log(`[Gofile] Node-side API fetch error: ${e.message} — fallback ke hasil intercept (${files.length} file)`);
        }
      }
    }

    // Ambil cookies (untuk fallback axios) + accountToken secara spesifik
    const cookies = await ctx.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const accountTokenCookie = cookies.find(c => c.name === 'accountToken');
    const accountToken = accountTokenCookie ? accountTokenCookie.value : null;

    return {
      files: files,
      cookie: cookieStr,
      // Prioritas: GOFILE_TOKEN > token fresh dari API (guest-rotate) > cookie token.
      accountToken: ACCOUNT_TOKEN || apiToken || accountToken
    };

  } catch (err) {
    console.error(`[Gofile] resolve error: ${err.message}`);
    console.error(`[Gofile] stack: ${err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : 'n/a'}`);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => { });
    } else if (ctx) {
      await ctx.close().catch(() => { });
    }
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
    // Prioritas: token akun sendiri (GOFILE_TOKEN) → bypass limit guest 1000GB per-IP.
    if (ACCOUNT_TOKEN) {
      accountToken = ACCOUNT_TOKEN;
      console.log(`[Gofile-DL] pakai GOFILE_TOKEN (akun sendiri).`);
    } else {
      // Fallback: kalau caller tidak forward, fetch accountToken fresh dari Gofile.
    // Ini terjadi kalau dipanggil dari code-path lama yang belum update. Harusnya
    // jarang karena flow baru selalu forward token dari resolveGofile().
    console.log(`[Gofile-DL] accountToken tidak di-forward, fetch fresh guest...`);
    let tmpBrowser;
    try {
      tmpBrowser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        ...(proxy ? { proxy } : {}),
      });
      const tmpCtx = await tmpBrowser.newContext({ userAgent: UA });
      const tmpPage = await tmpCtx.newPage();
      await tmpPage.goto('https://gofile.io/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
      await tmpPage.waitForTimeout(2000);
      const cookies = await tmpCtx.cookies();
      const c = cookies.find(x => x.name === 'accountToken');
      if (c) accountToken = c.value;
    } finally {
      if (tmpBrowser) await tmpBrowser.close().catch(() => { });
    }
    }
  }
  console.log(`[Gofile-DL] accountToken: ${accountToken ? '***(' + accountToken.length + ' chars)' : 'NONE'}`);

  // Siapkan proxy agent untuk axios jika GOFILE_PROXY di-set (SOCKS5/HTTP).
  const reqCfg = {
    method: 'GET',
    url: directUrl,
    responseType: 'stream',
    timeout: 1800000, // 30 menit; stream besar dilindungi resume+Range di bawah
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
  if (accountToken) {
    reqCfg.headers['Authorization'] = `Bearer ${accountToken}`;
    // Gofile CDN sering butuh token via COOKIE juga (bukan cuma Bearer). Kalau cuma
    // Bearer, CDN bisa balas homepage HTML. Kirim dua-duanya biar aman.
    reqCfg.headers['Cookie'] = `accountToken=${accountToken}`;
    reqCfg.headers['X-Website-Token'] = generateWebsiteToken(UA, accountToken);
    reqCfg.headers['X-BL'] = 'en-US';
  }
  // Proxy TIDAK dipakai untuk CDN download — langsung dari VPS (lebih stabil untuk file besar).
  // Proxy hanya untuk resolve page di atas (accountToken fetch).

  // Gofile CDN (store*.gofile.io) accessible langsung dari VPS tanpa proxy.
  // Proxy hanya dibutuhkan untuk resolve page (gofile.io), bukan download CDN.
  // Skip proxy untuk download agar tidak kena timeout WARP pada file besar.
  console.log(`[Gofile-DL] axios GET streaming (direct, no proxy for CDN)...`);

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
        let got = 0;
        for await (const c of res.data) { chunks.push(c); got += c.length; if (got > 500) break; }
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
  // Resume support: jika stream abort, retry dengan Range header (max 3 resume attempts).
  const RESUME_MAX = 3;
  let resumeAttempt = 0;
  let totalDownloaded = 0;

  while (true) {
    const size = await new Promise((resolve, reject) => {
      const writeOpts = totalDownloaded > 0 ? { flags: 'a' } : undefined; // append mode for resume
      const writer = fs.createWriteStream(destPath, writeOpts);
      let chunkDownloaded = 0;
      let lastTick = Date.now();

      res.data.on('data', (chunk) => {
        chunkDownloaded += chunk.length;
        totalDownloaded += chunk.length;
        const now = Date.now();
        if (onProgress && now - lastTick >= 1000) {
          onProgress(totalDownloaded, total);
          lastTick = now;
        }
      });
      res.data.on('error', (err) => {
        writer.close();
        reject(new Error(`Stream abort: ${err.message} (downloaded ${(totalDownloaded / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB)`));
      });
      writer.on('error', (err) => {
        try { res.data.destroy(); } catch (_) { }
        reject(new Error(`Write error: ${err.message}`));
      });
      writer.on('finish', () => {
        if (onProgress) onProgress(totalDownloaded, total);
        const fileSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
        console.log(`[Gofile-DL] END size=${(fileSize / 1048576).toFixed(1)}MB downloaded=${(totalDownloaded / 1048576).toFixed(1)}MB`);
        resolve(fileSize);
      });
      res.data.pipe(writer);
    }).catch(async (err) => {
      // Resume logic: retry with Range header
      resumeAttempt++;
      if (resumeAttempt > RESUME_MAX || totalDownloaded === 0) {
        // Can't resume or too many retries — clean up and throw
        if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch (_) { } }
        throw err;
      }

      console.log(`[Gofile-DL] Stream aborted at ${(totalDownloaded / 1048576).toFixed(1)}MB, resume attempt ${resumeAttempt}/${RESUME_MAX}...`);
      await new Promise(r => setTimeout(r, 3000 * resumeAttempt)); // backoff

      // Re-request with Range header
      const resumeCfg = { ...reqCfg, headers: { ...reqCfg.headers, 'Range': `bytes=${totalDownloaded}-` } };
      try {
        res = await axios(resumeCfg);
        if (res.status !== 206 && res.status !== 200) {
          throw new Error(`Resume failed: HTTP ${res.status}`);
        }
        console.log(`[Gofile-DL] Resume OK from byte ${totalDownloaded}, status=${res.status}`);
        return null; // signal to continue loop
      } catch (resumeErr) {
        if (fs.existsSync(destPath)) { try { fs.unlinkSync(destPath); } catch (_) { } }
        throw new Error(`Resume failed: ${resumeErr.message}`);
      }
    });

    if (size !== null) return size; // download complete
    // size === null means we resumed, loop again to pipe the new stream
  }
}

module.exports = {
  resolveGofile,
  downloadGofileFile
};
