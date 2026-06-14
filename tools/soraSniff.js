'use strict';
/**
 * SoraFolder network sniffer — JALANKAN DI VPS (yang sudah ada chromium).
 *
 * Tujuan: lihat request/response asli saat tombol download diklik, biar ketahuan
 * endpoint + bentuk body (JWT) yang dipakai. Hasilnya dipakai untuk bikin resolver
 * pure-axios (tanpa browser).
 *
 * Pakai:
 *   node tools/soraSniff.js https://sorafolder.com/d/<id>
 *
 * Salin SEMUA output "[REQ]/[RES]/[DL]" ke chat.
 */
const { chromium } = require('playwright');

const URL = process.argv[2];
if (!URL) { console.log('Usage: node tools/soraSniff.js <sorafolder-url>'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const STATIC = /\.(css|js|png|jpe?g|gif|svg|woff2?|ico)(\?|$)|cloudflare|jquery|bootstrap|jsdelivr|popperjs|cdnjs|google|gstatic|youradexchange|wallpaper/i;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const ctx = await browser.newContext({ acceptDownloads: true, userAgent: UA });
  const page = await ctx.newPage();

  page.on('request', (req) => {
    const u = req.url();
    if (STATIC.test(u)) return;
    const body = req.postData();
    console.log(`[REQ] ${req.method()} ${u}${body ? ' | body: ' + body.slice(0, 300) : ''}`);
  });
  page.on('response', (res) => {
    const u = res.url();
    if (STATIC.test(u)) return;
    const ct = res.headers()['content-type'] || '';
    const cl = res.headers()['content-length'] || '';
    if (/octet-stream|video|zip|rar|json|application/i.test(ct) || cl > 100000) {
      console.log(`[RES] ${res.status()} ${u} | ${ct} ${cl}`);
    }
  });
  page.on('download', (dl) => console.log(`[DL] download event url: ${dl.url()}`));
  ctx.on('page', (pop) => {
    pop.on('request', (req) => { if (!STATIC.test(req.url())) console.log(`[POPUP-REQ] ${req.method()} ${req.url()}`); });
  });

  console.log('goto:', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('goto err', e.message));
  console.log('--- tunggu timer 15s ---');
  await page.waitForTimeout(15000);

  // Klik tombol start download (id asli: start-download-btn), lalu save-file-btn
  for (const sel of ['#start-download-btn', '#save-file-btn']) {
    const el = await page.$(sel);
    if (el) { console.log('klik', sel); await el.click().catch(() => {}); await page.waitForTimeout(8000); }
    else console.log('tidak ada', sel);
  }

  console.log('--- tunggu 8s terakhir ---');
  await page.waitForTimeout(8000);
  await browser.close().catch(() => {});
  console.log('=== selesai ===');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
