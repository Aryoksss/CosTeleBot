const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');

chromium.use(StealthPlugin());

const PROFILE_DIR = path.resolve('./browser_profile_gofile');

async function resolveGofile(gofileUrl) {
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

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
              resolve(true); // Langsung hentikan tunggu setelah data tertangkap!
            }
          } catch(e) {}
        }
      });
    });

    // Gunakan 'domcontentloaded' alih-alih 'networkidle' untuk mencegah browser ngehang gara-gara iklan/tracker
    await page.goto(gofileUrl.split('#')[0], { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
    
    // Tunggu XHR tertangkap, dengan batas toleransi 8 detik jika ngelag
    await Promise.race([
      apiInterception,
      page.waitForTimeout(8000)
    ]);

    // Get cookies
    const cookies = await ctx.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    return { 
      files: files,
      cookie: cookieStr 
    };

  } catch (err) {
    console.error(`Gofile resolve error: ${err.message}`);
    return null;
  } finally {
    if (ctx) await ctx.close();
  }
}

module.exports = {
  resolveGofile
};
