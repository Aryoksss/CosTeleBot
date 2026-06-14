'use strict';
/**
 * Dev tool: tes resolver download secara manual.
 *
 * Pakai (di VPS yang sudah ada chromium):
 *   node tools/testResolve.js sora    https://sorafolder.com/d/xxxx
 *   node tools/testResolve.js terabox https://terabox.com/s/xxxx
 *   node tools/testResolve.js buzz    https://buzzheavier.com/xxxx
 */

require('dotenv').config();

const [, , type, url] = process.argv;
if (!type || !url) {
  console.log('Usage: node tools/testResolve.js <sora|terabox|buzz> <url>');
  process.exit(1);
}

(async () => {
  const t0 = Date.now();
  try {
    if (type === 'sora') {
      const sora = require('../scrapers/sorafolder');
      const link = await sora.getDirectLink(url);
      console.log('\nDIRECT LINK:\n', link);
    } else if (type === 'terabox') {
      const tera = require('../scrapers/teraboxResolver');
      const r = await tera.resolve(url);
      const best = tera.pickBestFile(r.files);
      console.log('\nsource:', r.source, '| files:', r.files.length);
      console.log('best  :', best && best.filename, best ? (best.sizeBytes / 1048576).toFixed(1) + ' MB' : '');
      console.log('link  :', best && best.directLink);
    } else if (type === 'buzz') {
      const host = require('../scrapers/hostResolver');
      console.log('\nDIRECT LINK:\n', await host.resolveBuzzheavier(url));
    } else {
      console.log('Tipe tidak dikenal:', type);
      process.exit(1);
    }
    console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.error('\nFAIL:', e.message);
    process.exit(1);
  }
})();
