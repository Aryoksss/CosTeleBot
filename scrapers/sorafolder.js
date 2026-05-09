const { chromium } = require('playwright');

const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  ok: (m) => console.log(`\x1b[32m[OK]\x1b[0m    ${m}`),
  error: (m) => console.log(`\x1b[31m[ERROR]\x1b[0m ${m}`),
};

/**
 * Mendapatkan tautan unduhan langsung (Direct Link) dari tautan halaman SoraFolder menggunakan Playwright
 * @param {string} url Tautan SoraFolder (misal: https://www.sorafolder.com/file/xxxxx)
 * @returns {Promise<string>} Tautan direct-download untuk diolah Downloader Node.js, atau melemparkan Error
 */
async function getDirectLink(url) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    log.info(`[SoraFolder] Membedah sorafolder.com secara siluman...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Periksa apakah halaman error 404 (File Not Found)
    const pageText = await page.content();
    if (pageText.toLowerCase().includes('file not found') || pageText.toLowerCase().includes('was removed') || pageText.toLowerCase().includes('does not exist')) {
      throw new Error('File SoraFolder ini sudah dihanguskan atau melanggar hak cipta (Error 404/Not Found). Silakan Gacha post lain.');
    }

    // Tunggu 12 detik agar timer 10 detik khas SoraFolder tuntas!
    log.info(`[SoraFolder] Menunggu 12 detik menghitung mundur timer bypasser SoraFolder...`);
    await page.waitForTimeout(12000);

    // Mengekstrak langsung melalui evaluasi script di dalam peramban
    let finalUrl = await page.evaluate(async () => {
      // 1. Beberapa format SoraFolder butuh diklik tombol "Free Download" nya dulu agar Timer baris kedua muncul / Linknya pecah
      const btns = Array.from(document.querySelectorAll('button, a.btn'));
      for (const btn of btns) {
        if (btn.innerText && btn.innerText.toLowerCase().includes('download')) {
          btn.click();
        }
      }

      // Tunggu 2 detik setelah insiden "klik tombol"
      await new Promise(r => setTimeout(r, 2000));

      // 2. Berburu link Href aslinya (Biasanya berisi direct IP Address atau server domain yg berbeda dari sorafolder.com)
      const allLinks = Array.from(document.querySelectorAll('a'));
      for (let a of allLinks) {
        if (a.href && (a.href.includes('token=') || a.href.includes('/download/') || a.href.includes('download.sorafolder'))) {
          // Pastikan bukan sekadar tautan menu atau iklan bodoh
          if (!a.href.includes('facebook') && !a.href.includes('twitter') && !a.href.includes('login')) {
            return a.href;
          }
        }
      }
      return null;
    });

    if (finalUrl && finalUrl.startsWith('http')) {
      log.ok(`[SoraFolder] Tembus Proteksi! Tautan Direct: ${finalUrl}`);
      return finalUrl;
    }

    throw new Error('File Not Found. Pilih link GoFile jika ada!');
  } catch (err) {
    if (err.message.includes('404')) {
      throw err;
    }
    log.error(`SoraFolder bypass error: ${err.message}`);
    throw new Error(err.message);
  } finally {
    if (browser) await browser.close().catch(() => { });
  }
}

module.exports = { getDirectLink };
