'use strict';
const gofile = require('../scrapers/gofile');
async function main() {
  const url = process.argv[2] || 'https://gofile.io/d/YoltD4';
  console.log('--- getWebsiteToken ---');
  const wt = await gofile.getWebsiteToken();
  console.log('wt =', wt);
  console.log('--- resolveGofile ---');
  const res = await gofile.resolveGofile(url);
  if (!res) return console.log('NULL (gagal)');
  console.log('accountToken:', res.accountToken ? res.accountToken.slice(0, 8) + '...' : 'none');
  console.log('files:', res.files.length);
  res.files.slice(0, 5).forEach(f => console.log(` - ${f.name} | ${(f.size/1048576).toFixed(1)}MB | ${f.link.slice(0,70)}`));
}
main().catch(e => console.error('ERR', e.message));
