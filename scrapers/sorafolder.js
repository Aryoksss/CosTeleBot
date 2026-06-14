const { chromium } = require('playwright');

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  ok: (m) => console.log(`\x1b[32m[OK]\x1b[0m    ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
  error: (m) => console.log(`\x1b[31m[ERROR]\x1b[0m ${m}`),
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// URL yang dianggap "direct link file" (bukan aset statis / lib CDN).
function isFileUrl(u) {
  if (!u || !/^https?:\/\//i.test(u)) return false;
  // Buang aset/library/asset sorafolder sendiri
  if (/cloudflare|jquery|bootstrap|jsdelivr|popperjs|cdnjs|fonts?\.|google-analytics|gstatic/i.test(u)) return false;
  if (/sorafolder\.com\/(detect_extension|assets|static|css|js|img|favicon)/i.test(u)) return false;
  // Pola direct link: token, /download/, atau ekstensi file arsip/video
  return /token=|[?&]dl=|\/download\/|download\.sorafolder|\.(rar|zip|7z|mp4|mkv|mov|webm)(\?|$)/i.test(u);
}

/**
 * Mendapatkan direct download link dari halaman SoraFolder.
 *
 * SoraFolder meng-generate URL via JavaScript ter-obfuscate (crypto-js) setelah
 * timer hitung mundur. Daripada menebak isi <a href> (rapuh), kita TANGKAP URL
 * file dari berbagai jalur: event browser-download, request jaringan, navigasi
 * frame, tab popup, dan terakhir fallback baca DOM.
 *
 * @param {string} url Tautan SoraFolder (mis. https://sorafolder.com/d/xxxx)
 * @returns {Promise<string>} direct link, atau melempar Error.
 */
async function getDirectLink(url) {
  let browser;
  const candidates = [];
  const pushIf = (u) => { if (isFileUrl(u) && !candidates.includes(u)) candidates.push(u); };

  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({ acceptDownloads: true, userAgent: UA });
    const page = await context.newPage();

    // 1) Browser-initiated download (paling akurat — URL final CDN)
    context.on('page', (pop) => {
      pop.on('download', (dl) => { try { pushIf(dl.url()); } catch (_) {} });
      pop.on('request', (req) => pushIf(req.url()));
      pop.on('framenavigated', (f) => pushIf(f.url()));
    });
    page.on('download', (dl) => { try { pushIf(dl.url()); } catch (_) {} });
    // 2) Request jaringan / navigasi ke URL file
    page.on('request', (req) => pushIf(req.url()));
    page.on('framenavigated', (f) => pushIf(f.url()));

    log.info(`[SoraFolder] Membuka ${url} ...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    const pageText = (await page.content()).toLowerCase();
    if (/file not found|was removed|does not exist/.test(pageText) && !/download your file/.test(pageText)) {
      throw new Error('File SoraFolder sudah dihapus / tidak ditemukan (404). Coba sumber lain.');
    }

    // Tunggu timer hitung mundur khas SoraFolder (~10 dtk) selesai.
    log.info(`[SoraFolder] Menunggu timer bypass...`);
    await page.waitForTimeout(13000);

    // Klik tombol Download (berbagai kemungkinan: id, class, atau teks).
    await page.evaluate(() => {
      const clicked = new Set();
      const click = (el) => { if (el && !clicked.has(el)) { clicked.add(el); try { el.click(); } catch (_) {} } };
      click(document.getElementById('DownloadBtn'));
      click(document.getElementById('download-btn'));
      document.querySelectorAll('button, a.btn, a.button, .download-btn, #downloadButton').forEach((b) => {
        if (/download/i.test((b.innerText || '') + ' ' + (b.id || ''))) click(b);
      });
    }).catch(() => {});

    // Beri waktu URL muncul (download/redirect/popup).
    await page.waitForTimeout(6000);

    // 3) Fallback: baca DOM untuk anchor / atribut yang berisi link file.
    if (candidates.length === 0) {
      const domLinks = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('a[href]').forEach((a) => out.push(a.href));
        // beberapa template simpan di data-attr / input value
        document.querySelectorAll('[data-url],[data-href],[data-link],input[value]').forEach((e) => {
          out.push(e.getAttribute('data-url') || e.getAttribute('data-href') || e.getAttribute('data-link') || e.value || '');
        });
        return out.filter(Boolean);
      }).catch(() => []);
      domLinks.forEach(pushIf);
    }

    // Pilih kandidat terbaik: prioritaskan yang punya token / path download.
    const best = candidates.find((u) => /token=|\/download\//i.test(u)) || candidates[0];
    if (best) {
      log.ok(`[SoraFolder] Direct link tertangkap: ${best.slice(0, 90)}`);
      return best;
    }

    throw new Error('Direct link SoraFolder tidak tertangkap (struktur situs mungkin berubah). Pakai link Gofile jika ada.');
  } catch (err) {
    log.error(`[SoraFolder] ${err.message}`);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { getDirectLink };
