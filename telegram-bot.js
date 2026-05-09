'use strict';
require('dotenv').config(); // Load environment variables dari file .env

// --- QUEUE MANAGER ---
class DownloadQueue {
  constructor() {
    this.queue = [];
    this.activeJobs = new Map();
    this.jobCounter = 1;
    this.maxConcurrency = 2; // Maksimal 2 proses download+ekstrak bersamaan di VPS
    this.maxPerUser = 3;     // Maksimal 3 file ngantri di tas per pengguna (anti-spam)
  }

  addJob(chatId, title, execFunc, bot) {
    // Cek beban aktif per Pengguna
    const userJobs = this.queue.filter(j => j.chatId === chatId).length +
      Array.from(this.activeJobs.values()).filter(j => j.chatId === chatId).length;

    if (userJobs >= this.maxPerUser) {
      bot.sendMessage(chatId, `⛔ <b>Antrean Penuh!</b> Anda hanya diizinkan menitipkan maksimal ${this.maxPerUser} tugas unduhan (termasuk yang sedang berjalan). Harap tunggu hingga yang lama selesai.`, { parse_mode: 'HTML' }).catch(() => { });
      return false;
    }

    const job = { id: this.jobCounter++, chatId, title, execFunc, addedAt: Date.now() };
    this.queue.push(job);

    this.checkQueue();
    return true;
  }

  updateJob(id, progressText) {
    if (this.activeJobs.has(id)) {
      this.activeJobs.get(id).progress = progressText;
    }
  }

  finishJob(id) {
    this.activeJobs.delete(id);
    this.checkQueue(); // Tarik antrean selanjutnya jika batas max kosong
  }

  async checkQueue() {
    if (this.activeJobs.size >= this.maxConcurrency || this.queue.length === 0) return;

    // Comot antrean terdepan
    const nextJob = this.queue.shift();
    this.activeJobs.set(nextJob.id, {
      id: nextJob.id,
      chatId: nextJob.chatId,
      title: nextJob.title,
      progress: '⚙️ Menghubungkan...',
      status: 'Berjalan'
    });

    log.info(`[Queue] Mengeksekusi Job #${nextJob.id} dari antrean (Taskers: ${this.activeJobs.size}/${this.maxConcurrency})`);
    try {
      await nextJob.execFunc(nextJob.id);
    } catch (e) {
      log.error(`Queue Job #${nextJob.id} meledak: ${e.message}`);
    } finally {
      this.finishJob(nextJob.id);
    }
  }
}

const queueManager = new DownloadQueue();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const fsp = fs.promises;
const path = require('path');
// Modul unzipper dan node-unrar-js telah dinonaktifkan untuk menghemat RAM (Telah menggunakan native P7zip OS)
const sharp = require('sharp'); // Auto-Compressor
const cosplayteleScraper = require('./scrapers/cosplaytele');
const gofileApi = require('./scrapers/gofile');
const mediafireApi = require('./scrapers/mediafire');
const sorafolderApi = require('./scrapers/sorafolder');
const kemonoScraper = require('./scrapers/kemono');
const r34Scraper = require('./scrapers/rule34video');
const historyTracker = require('./history');
const statsDb = require('./statsDb');

const MENU_THUMB_PATH = path.join(__dirname, 'reze.jpg');

process.env.NTBA_FIX_350 = 1; // Fix node-telegram-bot-api deprecation warning
sharp.cache(false);   // Matikan seluruh RAM cache agar RAM tidak bengkak
// sharp.concurrency(1) sudah DICABUT. Mengembalikan Sharp ke multi-thread maksimum OS agar compress lebih ngebut!



// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  ALLOWED_USER_IDS: [], // kosong = semua
  XAPIVERSE_KEY: process.env.XAPIVERSE_KEY,
  XAPIVERSE_URL: 'https://xapiverse.com/api/terabox-pro',
  LOCAL_API_URL: process.env.LOCAL_API_URL || null,
  TEMP_DIR: './tmp_downloads',
  IMAGE_EXTS: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  POSTS_PER_PAGE: 8,
  SEND_DELAY: 600,
  // Limit dinamis: 48MB untuk Telegram biasa, atau 1950MB jika pakai Local API Server
  VIDEO_MAX_BYTES: process.env.LOCAL_API_URL ? 1950 * 1024 * 1024 : 48 * 1024 * 1024,
};

// ─── LOGGER & UTILS ──────────────────────────────────────────────────────────
const log = {
  info: (m) => console.log(`\x1b[36m[INFO]\x1b[0m  ${m}`),
  ok: (m) => console.log(`\x1b[32m[OK]\x1b[0m    ${m}`),
  warn: (m) => console.log(`\x1b[33m[WARN]\x1b[0m  ${m}`),
  error: (m) => console.log(`\x1b[31m[ERROR]\x1b[0m ${m}`),
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isImage = (f) => CONFIG.IMAGE_EXTS.includes(path.extname(f).toLowerCase());
const isVideo = (f) => ['.mp4', '.mov', '.webm', '.mkv'].includes(path.extname(f).toLowerCase());
const isMedia = (f) => isImage(f) || isVideo(f);
const isArchive = (f) => ['.zip', '.rar', '.7z'].includes(path.extname(f).toLowerCase());

async function rimraf(dir) {
  if (fs.existsSync(dir)) {
    await fsp.rm(dir, { recursive: true, force: true });
    log.info(`Dihapus: ${dir}`);
  }
}

function collectFiles(dir) {
  const res = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d)) {
      const f = path.join(d, e);
      fs.statSync(f).isDirectory() ? walk(f) : res.push(f);
    }
  };
  walk(dir);
  return res.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function chunkMediaByLimits(medias) {
  const MAX_ITEMS = 10;
  // Limit gabungan upload Telegram Bot API (sekitar 90% dari MAX_BYTES agar aman terhadap metadata tambahan)
  const MAX_BYTES = Math.floor(CONFIG.VIDEO_MAX_BYTES * 0.9);

  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;

  for (const mediaPath of medias) {
    const size = fs.existsSync(mediaPath) ? fs.statSync(mediaPath).size : 0;

    // Jika ada satu file yang sendirian sudah jumbo, kita paksa sendirian di chunk terpisah.
    // Atau jika batas kuota 10 biji tercapai, atau batas gabungan tercapai... potong jadi chunk baru.
    if (currentChunk.length > 0 && (currentChunk.length >= MAX_ITEMS || currentSize + size >= MAX_BYTES)) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }

    currentChunk.push(mediaPath);
    currentSize += size;
  }

  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

// ─── SHARP AUTO-COMPRESSOR ───────────────────────────────────────────────────
async function sanitizeMediasForTelegram(medias, statusCallback) {
  // Telegram batas maksimal: 10 MB per foto, resolusi gabungan (width+height) tidak melewati 10000px
  let needStatus = false;

  for (let i = 0; i < medias.length; i++) {
    const mPath = medias[i];
    const ext = path.extname(mPath).toLowerCase();

    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      try {
        const fStats = fs.statSync(mPath);
        const meta = await sharp(mPath).metadata();
        const sumDim = meta.width + meta.height;
        const ratio = Math.max(meta.width, meta.height) / Math.min(meta.width, meta.height);

        // Jika file tembus >9MB atau resolusi kepanjangan, KOMPRES!
        if (fStats.size > 9 * 1024 * 1024 || sumDim > 9000 || ratio > 19) {
          if (!needStatus) {
            await statusCallback(`🗜️ <b>Sistem Cerdas Bekerja</b>: Terdapat beberapa foto 4K Raksasa! Mengkompres ukurannya sesaat...`);
            needStatus = true;
          }

          const outPath = mPath + '_compressed.jpg';
          let s = sharp(mPath);

          // Resize jika rasio konyol
          if (meta.width > 4200) s = s.resize({ width: 4200 });
          else if (sumDim > 9000 && meta.height > 4200) s = s.resize({ height: 4200 });

          if (ratio > 19) {
            const safeWidth = meta.width > meta.height ? Math.min(meta.width, Math.floor(meta.height * 18)) : undefined;
            const safeHeight = meta.height > meta.width ? Math.min(meta.height, Math.floor(meta.width * 18)) : undefined;
            s = s.resize({ width: safeWidth, height: safeHeight, fit: 'cover', position: 'top' });
          }

          // Kompres ke persentase aman ~80%
          await s.jpeg({ quality: 80 }).toFile(outPath);

          // Ganti tracker array media ke file versi kurus
          medias[i] = outPath;

          // Jeda 200 milidetik agar CPU sempat "bernapas" dan Garbace Collector berjalan
          await new Promise(res => setTimeout(res, 200));
          global.gc && global.gc();
        }
      } catch (err) {
        console.log(`Gagal mem-bypass resolusi untuk ${mPath}: ` + err.message);
      }
    }
  }
}

// ─── STATE MANAGEMENT ────────────────────────────────────────────────────────
// Format: chatId -> { step: 'AWAITING_SOURCE' | 'AWAITING_PASSWORD', url: string }
const userStates = new Map();
const browseCache = new Map(); // chatId -> { posts: [], page, category, query }
const menuTracker = new Map(); // chatId -> lastMessageId (Untuk auto-clean menu lama)
const kemonoTracker = new Map(); // chatId -> array of message_ids (Untuk auto-clean media gacha)
const r34BrowseCache = new Map(); // chatId -> { posts: [], page, query }

// ─── ADMIN STATS TRACKER ─────────────────────────────────────────────────────
const botStats = {
  startTime: Date.now(),
  downloadedBytes: 0,
  extractedFiles: 0,
  totalJobs: 0
};

// Escape HTML entities agar Telegram tidak crash saat judul mengandung < atau >
function escHtml(str) { return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function autoCleanOldMenu(bot, chatId, newMsgId) {
  const oldId = menuTracker.get(chatId);
  // Hapus menu lama jika ada
  if (oldId && oldId !== newMsgId) {
    bot.deleteMessage(chatId, oldId).catch(() => { });
  }
  menuTracker.set(chatId, newMsgId);
}

// ─── TERABOX DOWNLOAD PIPELINE ───────────────────────────────────────────────
async function getApiResult(teraboxUrl) {
  const { data } = await axios.post(CONFIG.XAPIVERSE_URL, { url: teraboxUrl }, {
    headers: { 'Content-Type': 'application/json', 'xAPIverse-Key': CONFIG.XAPIVERSE_KEY },
    timeout: 30000,
  });
  if (!data.list || !data.list.length) return null;
  const item = data.list[0];
  return {
    zipDlink: item.zip_dlink || null,
    name: item.name || 'archive',
    sizeMB: (item.size / 1024 / 1024).toFixed(1),
    credits: data.free_credits_remaining || '?',
  };
}

async function downloadStream(url, destPath, onProgress, cookie = null) {
  const headers = {};
  if (cookie) headers['Cookie'] = cookie;

  const res = await axios({ url, method: 'GET', responseType: 'stream', timeout: 600000, headers });
  const total = parseInt(res.headers['content-length'] || '0', 10);
  let downloaded = 0, lastPct = 0;

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    res.data.pipe(writer);
    res.data.on('data', (chunk) => {
      downloaded += chunk.length;
      botStats.downloadedBytes += chunk.length; // TRACKING TRAFIK
      if (total > 0 && onProgress) {
        const pct = Math.floor((downloaded / total) * 100);
        if (pct >= lastPct + 10) { lastPct = pct; onProgress(pct, downloaded, total); }
      }
    });
    writer.on('finish', () => { writer.close(); resolve(); });
    writer.on('error', (err) => {
      writer.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

async function extractArchive(archivePath, destDir, password = null) {
  await fsp.mkdir(destDir, { recursive: true });
  const ext = path.extname(archivePath).toLowerCase();
  const { execSync } = require('child_process');

  if (ext === '.zip' || ext === '.rar') {
    const candidates = [password, 'cosplaytele', '4KHD', '4khd', null].filter((p, i, arr) => arr.indexOf(p) === i);
    let success = false;
    for (const pw of candidates) {
      try {
        if (ext === '.zip') {
          const pwFlag = pw ? `-p"${pw}"` : '';
          execSync(`7z x "${archivePath}" ${pwFlag} -o"${destDir}" -y`, { stdio: 'ignore' });
        } else {
          // Untuk Linux VPS, .rar jauh lebih handal di-decode menggunakan modul unrar asli bawaan VPS
          const pwFlag = pw ? `-p"${pw}"` : '-p-'; // -p- menolak password kosong prompt
          execSync(`unrar x -y ${pwFlag} "${archivePath}" "${destDir}/"`, { stdio: 'ignore' });
        }
        success = true;
        log.ok(`Archive extracted via Native OS (pw=${pw || 'none'})`);
        break;
      } catch (e) { }
    }
    if (!success) throw new Error("Gagal ekstrak Arsip via OS Native, password mungkin salah/corrupted.");
  }

  // Nested extract
  for (const file of collectFiles(destDir)) {
    if (!isArchive(file)) continue;
    const subDir = file.replace(/\.[^.]+$/, '_x');
    try {
      await extractArchive(file, subDir, password);
      fs.unlinkSync(file);
    } catch (e) { log.warn(`Nested extract fail: ${e.message}`); }
  }
}

async function sendOne(bot, chatId, filePath, explicitCaption = null) {
  const size = fs.statSync(filePath).size;
  const name = path.basename(filePath);
  const finalCaption = explicitCaption !== null ? explicitCaption : name;

  if (size > CONFIG.VIDEO_MAX_BYTES) return; // Skip jika melebihi platform limit

  if (isVideo(filePath) && size < CONFIG.VIDEO_MAX_BYTES) {
    try {
      await bot.sendVideo(chatId, fs.createReadStream(filePath), { caption: finalCaption });
    } catch (e) {
      log.warn(`Gagal sendVideo (${name}), fallback doc: ${e.message}`);
      try { await bot.sendDocument(chatId, fs.createReadStream(filePath), { caption: finalCaption }); } catch (_) { }
    }
  } else if (isImage(filePath) && size < CONFIG.PHOTO_MAX_BYTES) {
    try {
      // Kirim sebagai foto dari stream
      await bot.sendPhoto(chatId, fs.createReadStream(filePath), { caption: finalCaption });
    }
    catch (e) {
      try {
        log.warn(`Gagal sendPhoto (${name}), fallback document: ${e.message}`);
        await bot.sendDocument(chatId, fs.createReadStream(filePath), { caption: finalCaption });
      } catch (_) { }
    }
  } else {
    try { await bot.sendDocument(chatId, fs.createReadStream(filePath), { caption: finalCaption }); } catch (_) { }
  }
}

async function processDownload(bot, chatId, url, password, source = 'terabox', jobId = null) {
  log.info(`[User ${chatId}] Memulai processDownload: ${url}`);
  const tmpBase = path.join(CONFIG.TEMP_DIR, `job_${Date.now()}`);
  let zipPath = `${tmpBase}_raw.zip`;
  const unzipDir = `${tmpBase}_ext`;
  let statusMsg = null;
  const status = async (txt) => {
    try {
      if (statusMsg) await bot.editMessageText(txt, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
      else statusMsg = await bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
    } catch (_) { }
  };

  try {
    await fsp.mkdir(CONFIG.TEMP_DIR, { recursive: true });

    let downloadLink = '';
    let fileName = '';
    let cookie = '';
    zipPath = '';

    if (source === 'gofile') {
      await status('⚙️ <b>Memproses isi link Gofile...</b>');
      log.info(`[Process] Memeriksa isi Gofile lewat Playwright...`);
      const gofileRes = await gofileApi.resolveGofile(url);
      if (!gofileRes || gofileRes.files.length === 0) {
        log.warn(`[Process] Resolving Gofile gagal / kosong: ${url}`);
        return status('❌ Gagal meresolve isi Gofile, atau folder kosong.');
      }

      let targetFile;
      // Jika gofileRes.files dilempar dari button spesifik, kita cari id-nya. 
      // Tapi karena saat ini processDownload menerima `url` yang merupakan base url (misal gofile.io/d/123),
      // kalau ada M>1 file di dalam, bot seharusnya bertanya dulu.
      // Kita asumsikan saat memanggil `processDownload`, jika url mengandung "#file=", kita pilih spesifik.
      const fMatch = url.match(/#file=(.+)$/);
      if (fMatch) {
        targetFile = gofileRes.files.find(f => f.id === fMatch[1]);
      } else if (gofileRes.files.length === 1) {
        targetFile = gofileRes.files[0];
      } else {
        // Terdapat >1 file and tidak ada url/#file spesifik. Tampilkan opsi:
        let textOpts = `📁 <b>Terdapat ${gofileRes.files.length} file di Gofile.</b>\nPilih file yang ingin didownload:\n\n`;
        const btns = [];
        gofileRes.files.forEach((f, i) => {
          btns.push([{ text: `⬇️ ${f.name}`, callback_data: `dls_gofile_${f.id}` }]);
        });

        // Simpan url utama ke state agar callback query ntar tau url asalnya
        userStates.set(chatId, { step: 'SELECT_GOFILE_FILE', url: url });

        await bot.editMessageText(textOpts, {
          chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: btns }
        });
        return; // Hentikan di sini.
      }

      if (!targetFile) return status('❌ File tidak ditemukan di dalam Gofile.');

      downloadLink = targetFile.link;
      fileName = targetFile.name || 'gofile_archive.zip';
      cookie = gofileRes.cookie;
      zipPath = `${tmpBase}_raw${path.extname(fileName)}`;
    } else if (source === 'direct') {
      await status('⚙️ <b>Menyambungkan tautan aslinya...</b>');
      downloadLink = url;
      // Gunakan nama akhir dari url jika memungkinkan
      fileName = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'archive.zip';
      zipPath = `${tmpBase}_raw${path.extname(fileName)}`;
    } else {
      await status('⚙️ <b>Mapping via xAPIverse...</b>');
      const api = await getApiResult(url);
      if (!api || !api.zipDlink) return status('❌ API Gagal / Kuota Habis.');
      downloadLink = api.zipDlink;
      fileName = api.name;
    }

    await status(`⬇️ <b>Mengunduh ${fileName}...</b>\n📦`);
    await downloadStream(downloadLink, zipPath, async (pct, dl, tot) => {
      const pText = `⬇️ <b>Mengunduh ${fileName}...</b>\n<code>${pct}%  ─  ${(dl / 1048576).toFixed(1)} MB / ${(tot ? (tot / 1048576).toFixed(1) : '?')} MB</code>`;
      if (jobId) queueManager.updateJob(jobId, pText);
      await status(pText);
    }, cookie);

    const finalSize = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
    if (finalSize > 0) statsDb.addDownloadSize(chatId, finalSize);

    // Tandai status jadi Ekstraksi
    if (jobId) queueManager.updateJob(jobId, '📦 Mengekstrak berkas arsip...');

    let fallbackRaw = false;

    if (isArchive(zipPath)) {
      await status('📦 <b>Mengekstrak arsip...</b>');
      try {
        await extractArchive(zipPath, unzipDir, password);
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      } catch (extErr) {
        log.warn(`Ekstraksi gagal: ${extErr.message}, mengirim mentahan...`);
        await status(`⚠️ <b>Gagal ekstrak arsip.</b> Mengirim file mentahan langsung ke Tuan...`);
        if (!fs.existsSync(unzipDir)) fs.mkdirSync(unzipDir);
        fs.renameSync(zipPath, path.join(unzipDir, path.basename(zipPath)));
        fallbackRaw = true; // Tandai bahwa ini file mentahan, jangan filter!
      }
    } else {
      // Bukan arsip (contoh: unduhan file .mp4 langsung), pindahkan agar tetap dikirim
      if (!fs.existsSync(unzipDir)) fs.mkdirSync(unzipDir);
      fs.renameSync(zipPath, path.join(unzipDir, path.basename(zipPath)));
    }

    const files = collectFiles(unzipDir);
    const medias = files.filter(isMedia);
    // Jika fallbackRaw, kirim SEMUA file termasuk arsip mentahan sebagai dokumen
    const docs = fallbackRaw
      ? files.filter(f => !isMedia(f))
      : files.filter(f => !isMedia(f) && !isArchive(f));
    const total = medias.length + docs.length;

    if (total === 0) return status('⚠️ Arsip kosong atau berpassword proteksi tingkat tinggi.');
    botStats.totalJobs += 1; // TRACKING KERJAAN
    botStats.extractedFiles += total; // TRACKING JUMLAH FILE

    // Auto-compressor Sharp Engine (Pre-flight checks) sebelum masuk antiller
    await sanitizeMediasForTelegram(medias, status);

    await status(`📤 <b>Mengirim ${total} file Media...</b>`);

    let sent = 0;
    const mediaChunks = chunkMediaByLimits(medias);
    let isFirstBatch = true; // Untuk memastikan caption hanya ditambahkan 1x

    // 1. Mengirim gambar/video secara massal (Media Group)
    for (const chunk of mediaChunks) {
      const mediaGroup = chunk.map((mediaPath, idx) => {
        const obj = {
          type: isVideo(mediaPath) ? 'video' : 'photo',
          media: fs.createReadStream(mediaPath)
        };
        if (isFirstBatch && idx === 0) {
          obj.caption = fileName;
        }
        return obj;
      });

      try {
        await bot.sendMediaGroup(chatId, mediaGroup);
        sent += chunk.length;
      } catch (err) {
        log.warn(`[User ${chatId}] Gagal sendMediaGroup, fallback manual. Er: ${err.message}`);
        // Jika MediaGroup gagal (mungkin ukuran file aneh), kirim satu-satu fallback
        for (let idx = 0; idx < chunk.length; idx++) {
          const caption = (isFirstBatch && idx === 0) ? fileName : '';
          await sendOne(bot, chatId, chunk[idx], caption);
          sent++;
        }
      }
      isFirstBatch = false;
      await status(`📤 <b>Mengirim Album... ${sent}/${medias.length}</b>`).catch(() => { });
      await sleep(CONFIG.SEND_DELAY * 2); // delay sedikit agar tidak limit di Telegram
    }

    // 2. Mengirim file / dokumen (Jika ada)
    for (const d of docs) {
      // Untuk document, sengaja kita tidak timpa captionnya agar user tau ini doc apa
      await sendOne(bot, chatId, d);
      sent++;
      await sleep(CONFIG.SEND_DELAY);
    }

    await status(`✅ <b>Selesai!</b> Terkirim ${sent} file.\n<i>(Pesan status ini akan musnah dalam 5 detik..)</i>`);

    // Fitur Auto-Clean: Hapus pesan status download setelah 5 detik agar riwayat chat bersih
    setTimeout(() => {
      if (statusMsg) bot.deleteMessage(chatId, statusMsg.message_id).catch(() => { });
    }, 5000);

  } catch (err) {
    await status(`❌ <b>Error:</b> <code>${err.message}</code>`);
  } finally {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    await rimraf(unzipDir);
  }
}

// ─── COSPLAYTELE MAPPING HANDLERS ──────────────────────────────────────────────
async function sendPostDetail(bot, chatId, loadMsg, post, cacheIndex) {
  const links = await cosplayteleScraper.scrapePostDetail(post.url);
  let resText = `🔗 <b>Links Ditemukan:</b>\n${post.title}\n\n`;
  let dlButtons = [];

  if (links) {
    if (links.gofile) {
      resText += `📁 <b>Gofile:</b> ${links.gofile}\n`;
      dlButtons.push([{ text: '⬇️ Download via Gofile (Auto)', callback_data: `dlgofile_${cacheIndex}` }]);
    }
    if (links.mediafire) {
      resText += `🔥 <b>MediaFire:</b> ${links.mediafire}\n`;
      dlButtons.push([{ text: '⬇️ Download via MediaFire (Auto)', callback_data: `dlmediafire_${cacheIndex}` }]);
    }
    if (links.sorafolder) {
      resText += `🔥 <b>SoraFolder:</b> ${links.sorafolder}\n`;
      dlButtons.push([{ text: '⬇️ Download via SoraFolder (Auto)', callback_data: `dlsorafolder_${cacheIndex}` }]);
    }
    if (links.terabox) resText += `📥 <b>TeraBox:</b> ${links.terabox}\n`;
  } else {
    resText += 'Tidak ada link yang dikenali.';
  }

  const stateInfo = browseCache.get(chatId);
  if (stateInfo && stateInfo.isGacha) {
    dlButtons.push([{ text: '🎲 Cari Acak Lagi (Reroll)', callback_data: 'menu_gacha' }]);
    dlButtons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);
  } else {
    dlButtons.push([{ text: '🔙 Kembali ke Daftar', callback_data: 'back_browse' }]);
  }

  const replyMarkupObj = dlButtons.length > 0 ? { inline_keyboard: dlButtons } : undefined;

  try {
    if (post.thumb) {
      await bot.deleteMessage(chatId, loadMsg.message_id).catch(() => { });
      await bot.sendPhoto(chatId, post.thumb, {
        caption: resText, parse_mode: 'HTML', reply_markup: replyMarkupObj
      });
    } else {
      bot.editMessageText(resText, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML', reply_markup: replyMarkupObj
      });
    }
  } catch (err) {
    log.warn(`Gagal mengirim preview: ${err.message}`);
    bot.editMessageText(resText, { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML', reply_markup: replyMarkupObj }).catch(() => { });
  }
}

async function doCosplayteleGacha(bot, chatId) {
  const gMsg = await bot.sendMessage(chatId, '🎲 <b>Mengguncang Mesin Gacha...</b>\n<i>Mencari random album rahasia dari dimensi lain...</i>', { parse_mode: 'HTML' });
  await autoCleanOldMenu(bot, chatId, gMsg.message_id);
  statsDb.addGacha(chatId);

  try {
    const randPage = Math.floor(Math.random() * 50) + 1; // Asumsi ada >50 page
    const posts = await cosplayteleScraper.scrapeListing(randPage, 'home');

    if (!posts || posts.length === 0) {
      return bot.editMessageText('❌ Mesin Gacha sedang macet, coba lagi nanti.', { chat_id: chatId, message_id: gMsg.message_id });
    }

    const unseenPosts = posts.filter(p => !historyTracker.hasSeen(chatId, 'cosplay', p.url));
    const randomPost = unseenPosts.length > 0
      ? unseenPosts[Math.floor(Math.random() * unseenPosts.length)]
      : posts[Math.floor(Math.random() * posts.length)]; // Fallback jika semua pernah dilihat

    // Tandai sudah dilihat
    historyTracker.markSeen(chatId, 'cosplay', randomPost.url);

    // Sengaja overwrite cache index 0 agar tombol Download Gofile nyambung ke index ini
    browseCache.set(chatId, { posts: [randomPost], page: randPage, category: 'home', query: null, isGacha: true });

    await bot.editMessageText(`🎲 <b>Berhasil! Anda mendapat item SSR!</b>\n\n🔍 Memeriksa link untuk:\n<b>${randomPost.title}</b>`, {
      chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML'
    });

    await sendPostDetail(bot, chatId, gMsg, randomPost, 0);
  } catch (e) {
    log.error('Gacha gagal: ' + e.message);
    bot.editMessageText(`❌ Error Gacha: ${e.message}`, { chat_id: chatId, message_id: gMsg.message_id }).catch(() => { });
  }
}

async function doKemonoGacha(bot, chatId, creatorUrl) {
  const gMsg = await bot.sendMessage(chatId, '🍁 <b>Patreon Gacha...</b>\n<i>Menelusuri database Patreon dari vault...</i>', { parse_mode: 'HTML' });
  statsDb.addGacha(chatId);

  // Eksekusi pembersihan media gacha lama
  const oldMsgs = kemonoTracker.get(chatId) || [];
  if (oldMsgs.length > 0) {
    for (const mId of oldMsgs) {
      bot.deleteMessage(chatId, mId).catch(() => { });
      await sleep(35); // cegah error socket
    }
    kemonoTracker.set(chatId, []);
  }

  try {
    const selectedPost = await kemonoScraper.getRandomKemonoPost(creatorUrl, chatId);
    const mediaUrls = await kemonoScraper.getKemonoPostMedia(selectedPost.href);
    const rawUrls = [...mediaUrls.inlineImgs, ...mediaUrls.links]
      .filter(u => u.toLowerCase().match(/\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)$/)); // Support images & videos
    const allUrls = [...new Set(rawUrls)]; // Remove duplicate urls

    if (allUrls.length === 0) {
      return bot.editMessageText(`😔 <b>${selectedPost.title}</b>\n\nPost ini tidak berisi gambar yang didukung (mungkin isinya zip/teks saja). Coba gacha lagi!`, {
        chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll', callback_data: 'menu_kemono_reroll' }, { text: '🔙 Menu', callback_data: 'menu_awal' }]] }
      });
    }

    await bot.editMessageText(`🍁 <b>${selectedPost.title}</b>\n\n<i>⏳ Target Cloudflare terkunci. Mengekstrak ${allUrls.length} media secara luring ke server lokal...</i>`, {
      chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML'
    }).catch(() => { });

    // Bikin direktori luring
    const jobDir = path.join(CONFIG.TEMP_DIR, 'kemono_' + Date.now());
    await fsp.mkdir(jobDir, { recursive: true });

    let downloadedFiles = [];
    for (let i = 0; i < allUrls.length; i++) {
      const u = allUrls[i];
      try {
        const cleanUrl = u.split('?')[0];
        let ext = path.extname(cleanUrl) || '.jpg';
        if (!ext.match(/\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)$/i)) ext = '.jpg'; // Fallback
        const dest = path.join(jobDir, `media_${i}${ext}`);

        // Mengunduh diam-diam
        await downloadStream(u, dest, null, null);
        downloadedFiles.push(dest);
      } catch (e) {
        log.warn(`[Kemono DL] Gagal download ${u}`);
      }
    }

    if (downloadedFiles.length === 0) {
      await rimraf(jobDir);
      return bot.editMessageText(`❌ Gagal mendownload isi media (Akses ditolak CDN/Kosong)`, { chat_id: chatId, message_id: gMsg.message_id });
    }

    await bot.editMessageText(`🍁 <b>${selectedPost.title}</b>\n\n<i>✓ Berhasil mendownload ${downloadedFiles.length} media. Memfilter ukuran raksasa...</i>`, { chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML' }).catch(() => { });

    // Filter kompresor untuk memangkas ukuran raksasa melebihi 10MB
    await sanitizeMediasForTelegram(downloadedFiles, (txt) => {
      bot.editMessageText(txt, { chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML' }).catch(() => { });
    });

    // Filter pelindung API Telegram limit (50MB Cloud / 2000MB Lokal)
    const validFiles = downloadedFiles.filter(f => {
      if (!fs.existsSync(f)) return false;
      return fs.statSync(f).size <= CONFIG.VIDEO_MAX_BYTES;
    });
    const rejectedCount = downloadedFiles.length - validFiles.length;

    // Hapus pesan progres
    bot.deleteMessage(chatId, gMsg.message_id).catch(() => { });

    const thresholdMB = Math.floor(CONFIG.VIDEO_MAX_BYTES / 1024 / 1024);
    if (validFiles.length === 0) {
      await rimraf(jobDir);
      return bot.sendMessage(chatId, `😔 Seluruh file di post ini terlalu raksasa (>${thresholdMB}MB) yang ditolak mutlak oleh Server Telegram Anda.\n\nSilakan coba post lain.`, { reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll', callback_data: 'menu_kemono_reroll' }]] } });
    }

    const chunks = chunkMediaByLimits(validFiles);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const mediaGroup = chunk.map((localFile, idx) => ({
        type: localFile.match(/\.(mp4|mov|webm)$/i) ? 'video' : 'photo',
        media: fs.createReadStream(localFile),
        // Telegram tidak mengizinkan tombol (reply_markup) pada Album (MediaGroup). 
        // Caption dikosongkan agar semua teks digabung pada menu kemudi di bawahnya.
        parse_mode: 'HTML'
      }));

      try {
        const resGroups = await bot.sendMediaGroup(chatId, mediaGroup);
        // Rekam message_id setiap foto yang tayang agar bisa dihapus pada reroll berikutnya
        const tracked = kemonoTracker.get(chatId) || [];
        resGroups.forEach(m => tracked.push(m.message_id));
        kemonoTracker.set(chatId, tracked);
      } catch (e) {
        log.error(`[Patreon Batch Send Error] ${e.message}`);
      }
      await sleep(CONFIG.SEND_DELAY);
    }

    let navText = `🍁 <b>${selectedPost.title}</b>\n\n✨ <i>Selesai! ${validFiles.length} File premium berhasil dikirim.</i>`;
    if (rejectedCount > 0) navText += `\n⚠️ <i>${rejectedCount} video dilewati karena melebihi kapasitas server Telegram Anda!</i>`;

    const navMsg = await bot.sendMessage(chatId, navText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll Gacha', callback_data: 'menu_kemono_reroll' }, { text: '🔙 Menu Utama', callback_data: 'menu_awal' }]] }
    });
    autoCleanOldMenu(bot, chatId, navMsg.message_id);

    // Bersihkan jejak
    await rimraf(jobDir);

  } catch (e) {
    log.error('Patreon Gacha gagal: ' + e.message);
    bot.editMessageText(`❌ Error Patreon: ${e.message}`, { chat_id: chatId, message_id: gMsg.message_id }).catch(() => { });
  }
}

// ─── RULE34VIDEO HANDLERS ────────────────────────────────────────────────────
async function doR34Browse(bot, chatId, page = 1, query = null) {
  log.info(`[User ${chatId}] Request R34Video (Page: ${page}, Query: ${query || 'none'})`);
  const loadMsg = await bot.sendMessage(chatId, `🎬 <b>Memuat Rule34Video...</b>`, { parse_mode: 'HTML' });
  await autoCleanOldMenu(bot, chatId, loadMsg.message_id);

  try {
    const posts = await r34Scraper.scrapeListing(page, query);
    if (!posts.length) return bot.editMessageText('⚠️ Tidak ada video ditemukan.', { chat_id: chatId, message_id: loadMsg.message_id });

    const shown = posts.slice(0, 10);
    r34BrowseCache.set(chatId, { posts: shown, page, query });

    let text = `🎬 <b>Rule34Video</b> ${query ? `(Search: ${query})` : '(Terbaru)'} · Halaman ${page}\n\n`;
    shown.forEach((p, i) => text += `${i + 1}. ${escHtml(p.title)}\n`);

    const buttons = [];
    for (let i = 0; i < shown.length; i += 2) {
      const row = [{ text: `${i + 1}. 🎬 Detail`, callback_data: `r34_${i}` }];
      if (i + 1 < shown.length) row.push({ text: `${i + 2}. 🎬 Detail`, callback_data: `r34_${i + 1}` });
      buttons.push(row);
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '◀ Prev', callback_data: `r34page_${page - 1}` });
    navRow.push({ text: 'Next ▶', callback_data: `r34page_${page + 1}` });
    buttons.push(navRow);
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    bot.editMessageText(`❌ Gagal: ${err.message}`, { chat_id: chatId, message_id: loadMsg.message_id }).catch(() => { });
  }
}

async function doR34Gacha(bot, chatId) {
  const gMsg = await bot.sendMessage(chatId, '🎬 <b>R34 Video Gacha...</b>\n<i>Mengacak konten dari database Rule34Video...</i>', { parse_mode: 'HTML' });
  statsDb.addGacha(chatId);

  try {
    // Ambil halaman random (1-100)
    const randomPage = Math.floor(Math.random() * 50) + 1;
    const posts = await r34Scraper.scrapeListing(randomPage);
    if (!posts.length) {
      return bot.editMessageText('😔 Gagal memuat video acak. Coba lagi!', {
        chat_id: chatId, message_id: gMsg.message_id,
        reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll', callback_data: 'menu_r34_gacha' }, { text: '🔙 Menu', callback_data: 'menu_awal' }]] }
      });
    }

    const unseenPosts = posts.filter(p => !historyTracker.hasSeen(chatId, 'r34', p.link));
    const pick = unseenPosts.length > 0
      ? unseenPosts[Math.floor(Math.random() * unseenPosts.length)]
      : posts[Math.floor(Math.random() * posts.length)];

    historyTracker.markSeen(chatId, 'r34', pick.link);
    log.ok(`[R34] Gacha pick: ${pick.title}`);

    const links = await r34Scraper.scrapePostDetail(pick.link);
    if (!links.length) {
      return bot.editMessageText(`😔 <b>${escHtml(pick.title)}</b>\n\nGagal mendapatkan link download. Coba reroll!`, {
        chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll', callback_data: 'menu_r34_gacha' }, { text: '🔙 Menu', callback_data: 'menu_awal' }]] }
      });
    }

    await bot.editMessageText(`🎬 <b>${escHtml(pick.title)}</b>\n\n<i>⏳ Mengunduh video ke server lokal (auto-fallback resolusi)...</i>`, {
      chat_id: chatId, message_id: gMsg.message_id, parse_mode: 'HTML'
    }).catch(() => { });

    // Download resolusi tertinggi yang tersedia
    const jobDir = path.join(CONFIG.TEMP_DIR, 'r34_' + Date.now());
    await fsp.mkdir(jobDir, { recursive: true });
    let downloaded = null;
    let dlLabel = '';

    for (const dl of links) {
      try {
        const dest = path.join(jobDir, 'video.mp4');
        await downloadStream(dl.url, dest, null, null);
        downloaded = dest;
        dlLabel = dl.label;
        log.ok(`[R34] Berhasil download ${dl.label} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)}MB)`);
        break;
      } catch (e) {
        log.warn(`[R34] Gagal download ${dl.label}: ${e.message}`);
      }
    }

    if (!downloaded) {
      await rimraf(jobDir);
      return bot.editMessageText(`❌ Semua resolusi gagal didownload.`, {
        chat_id: chatId, message_id: gMsg.message_id,
        reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll', callback_data: 'menu_r34_gacha' }, { text: '🔙 Menu', callback_data: 'menu_awal' }]] }
      });
    }

    const fsize = fs.statSync(downloaded).size;
    const sizeMB = (fsize / 1024 / 1024).toFixed(1);

    // Hapus pesan loading
    bot.deleteMessage(chatId, gMsg.message_id).catch(() => { });

    // Kirim video
    try {
      await bot.sendVideo(chatId, fs.createReadStream(downloaded), {
        caption: `🎬 <b>${escHtml(pick.title)}</b> (${dlLabel}, ${sizeMB}MB)`,
        parse_mode: 'HTML', supports_streaming: true
      });
    } catch (e) {
      log.error(`[R34 Send Error] ${e.message}`);
    }

    const navMsg = await bot.sendMessage(chatId, `✨ <i>Video berhasil dikirim!</i>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🎲 Reroll Gacha', callback_data: 'menu_r34_gacha' }, { text: '🔙 Menu Utama', callback_data: 'menu_awal' }]] }
    });
    autoCleanOldMenu(bot, chatId, navMsg.message_id);

    // Cleanup
    await rimraf(jobDir);
  } catch (e) {
    log.error('R34 Gacha gagal: ' + e.message);
    bot.editMessageText(`❌ Error R34: ${e.message}`, { chat_id: chatId, message_id: gMsg.message_id }).catch(() => { });
  }
}

async function doR34PostDetail(bot, chatId, post) {
  const loadMsg = await bot.sendMessage(chatId, `🎬 <b>Memuat detail...</b>`, { parse_mode: 'HTML' });

  try {
    const links = await r34Scraper.scrapePostDetail(post.link);
    const idx = r34BrowseCache.get(chatId)?.posts?.indexOf(post) ?? 0;
    let text = `🎬 <b>${escHtml(post.title)}</b>\n\n`;

    const buttons = [];
    if (links.length) {
      text += `📥 <b>Pilih Resolusi Download:</b>\n`;
      links.forEach((l, i) => {
        text += `• ${l.label}\n`;
        buttons.push([{ text: `⬇️ ${l.label}`, callback_data: `r34dlres_${idx}_${i}` }]);
      });
    } else {
      text += '⚠️ Tidak ada link download terdeteksi.';
    }

    buttons.push([{ text: '🔙 Kembali ke Daftar', callback_data: 'r34_back_browse' }]);
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]);

    if (post.thumb) {
      await bot.deleteMessage(chatId, loadMsg.message_id).catch(() => { });
      await bot.sendPhoto(chatId, post.thumb, {
        caption: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons }
      });
    } else {
      await bot.editMessageText(text, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
      });
    }
  } catch (e) {
    bot.editMessageText(`❌ Gagal: ${e.message}`, { chat_id: chatId, message_id: loadMsg.message_id }).catch(() => { });
  }
}

// ─── COSPLAYTELE BROWSE HANDLERS ─────────────────────────────────────────────
async function doCosplayteleBrowse(bot, chatId, category = 'home', page = 1, query = null) {
  log.info(`[User ${chatId}] Request Cosplaytele (Cat: ${category}, Page: ${page}, Query: ${query || 'none'})`);
  const loadMsg = await bot.sendMessage(chatId, `🔍 <b>Memuat Cosplaytele...</b>`, { parse_mode: 'HTML' });
  await autoCleanOldMenu(bot, chatId, loadMsg.message_id);

  try {
    const posts = await cosplayteleScraper.scrapeListing(page, category, query);
    if (!posts.length) return bot.editMessageText('⚠️ Tidak ada post ditemukan.', { chat_id: chatId, message_id: loadMsg.message_id });

    const shown = posts.slice(0, CONFIG.POSTS_PER_PAGE);
    browseCache.set(chatId, { posts: shown, page, category, query });

    let text = `✨ <b>Cosplaytele</b> ${query ? `(Query: ${query})` : ''} · Halaman ${page}\n\n`;
    shown.forEach((p, i) => text += `${i + 1}. ${p.title}\n`);

    const buttons = [];
    for (let i = 0; i < shown.length; i += 2) {
      const row = [{ text: `${i + 1}. 📖 Detail`, callback_data: `cpt_${i}` }];
      if (i + 1 < shown.length) row.push({ text: `${i + 2}. 📖 Detail`, callback_data: `cpt_${i + 1}` });
      buttons.push(row);
    }

    const navRow = [];
    if (page > 1) navRow.push({ text: '◀ Prev', callback_data: `cpage_${page - 1}` });
    navRow.push({ text: 'Next ▶', callback_data: `cpage_${page + 1}` });
    buttons.push(navRow);

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    bot.editMessageText(`❌ Gagal: ${err.message}`, { chat_id: chatId, message_id: loadMsg.message_id }).catch(() => { });
  }
}

// ─── INIT BOT & MENUS ────────────────────────────────────────────────────────
async function sendMenuWithThumb(bot, chatId, text, keyboard) {
  const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  try {
    if (fs.existsSync(MENU_THUMB_PATH)) {
      opts.caption = text;
      return await bot.sendPhoto(chatId, fs.createReadStream(MENU_THUMB_PATH), opts);
    }
  } catch (e) { log.warn('Gagal kirim thumbnail: ' + e.message); }

  // Fallback text only
  return await bot.sendMessage(chatId, text, opts);
}

async function sendMainMenu(bot, chatId) {
  const text = `👋 <b>CosTele Bot</b>\n\nPilih mode operasi:`;
  const keyboard = [
    [{ text: '🔍 Cari Karakter (Cosplay)', callback_data: 'menu_search_cosplay' }, { text: '🔍 Cari Karakter (R34)', callback_data: 'menu_search_r34' }],
    [{ text: '📚 Browse Cosplay', callback_data: 'menu_browse' }, { text: '🎲 Gacha Cosplay', callback_data: 'menu_gacha' }],
    [{ text: '🍁 Patreon Gacha', callback_data: 'menu_kemono_reroll' }],
    [{ text: '📊 Profile', callback_data: 'menu_profile' }],
    [{ text: '🎬 R34 Video Browse', callback_data: 'menu_r34_browse' }, { text: '🎬 R34 Gacha', callback_data: 'menu_r34_gacha' }],
    [{ text: '🧹 Clear Chat', callback_data: 'menu_clear' }, { text: '📥 Manual Terabox DL', callback_data: 'menu_terabox' }]
  ];

  if (String(chatId) === '6663343995') {
    keyboard.splice(4, 0, [{ text: '💻 Dasbor Admin', callback_data: 'menu_vps' }]);
  }

  const sentMsg = await sendMenuWithThumb(bot, chatId, text, keyboard);
  autoCleanOldMenu(bot, chatId, sentMsg.message_id);
}

function startBot() {
  const botOptions = { polling: true };
  if (CONFIG.LOCAL_API_URL) botOptions.baseApiUrl = CONFIG.LOCAL_API_URL;
  const bot = new TelegramBot(CONFIG.BOT_TOKEN, botOptions);
  log.ok('Bot Telegram aktif ✅');

  // Set Telegram Menu Commands
  bot.setMyCommands([
    { command: '/start', description: 'Buka Menu Utama' },
    { command: '/browse', description: 'Jelajahi Postingan Cosplay Terbaru' },
    { command: '/gacha', description: '🎲 Gacha Cosplay Random (Surprise Me)' },
    { command: '/maple', description: '🍁 Gacha Patreon' },
    { command: '/r34', description: '🎬 Rule34 Video (Browse & Gacha)' },
    { command: '/search', description: 'Cari Karakter / Album Cosplay' },
    { command: '/tasks', description: '🚦 Pantau Dasbor Antrean' },
    { command: '/stats', description: '🔰 Lihat Profil' },
    { command: '/clear', description: '🧹 Bersihkan Seluruh Chat' }
  ]).catch(() => log.warn('Gagal set command menu.'));

  // Menus
  bot.onText(/\/start/, (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { }); // Auto-clean chat dari sisi user
    log.info(`[User ${msg.chat.id}] Execute /start`);
    sendMainMenu(bot, msg.chat.id);
  });

  bot.onText(/\/browse/, (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { }); // Auto-clean
    log.info(`[User ${msg.chat.id}] Execute /browse`);
    doCosplayteleBrowse(bot, msg.chat.id, 'home', 1);
  });

  bot.onText(/\/gacha(?!\d)/, (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { }); // Auto-clean
    log.info(`[User ${msg.chat.id}] Execute /gacha`);
    doCosplayteleGacha(bot, msg.chat.id);
  });

  bot.onText(/\/maple/, (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { }); // Auto-clean
    const urls = [
      'https://kemono.cr/patreon/user/3295915',
      'https://kemono.cr/patreon/user/49965584'
    ];
    const pickedUrl = urls[Math.floor(Math.random() * urls.length)];
    log.info(`[User ${msg.chat.id}] Execute /maple Kemono Gacha (${pickedUrl})`);
    doKemonoGacha(bot, msg.chat.id, pickedUrl);
  });

  bot.onText(/^\/r34(?:\s+(.+))?$/, async (msg, match) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });
    const query = match[1];
    if (query) {
      log.info(`[User ${msg.chat.id}] Execute /r34 search: ${query}`);
      doR34Browse(bot, msg.chat.id, 1, query);
    } else {
      log.info(`[User ${msg.chat.id}] Execute /r34 (Menu)`);
      const sentMsg = await bot.sendMessage(msg.chat.id, `🎬 <b>Rule34 Video</b>\n\nPilih mode:`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔍 Cari Video', callback_data: 'r34_search_prompt' }],
            [{ text: '📋 Browse Terbaru', callback_data: 'menu_r34_browse' }],
            [{ text: '🎲 Gacha Video Random', callback_data: 'menu_r34_gacha' }],
            [{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]
          ]
        }
      });
      autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
    }
  });

  bot.onText(/^\/search(?:\s+(.+))?$/, async (msg, match) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { }); // Auto-clean
    const query = match[1];
    if (query) {
      // Jika ada query langsung, tampilkan pilihan sumber
      log.info(`[User ${msg.chat.id}] Execute /search ${query}`);
      const text = `🔍 <b>Cari: "${query}"</b>\n\nPilih sumber pencarian:`;
      const keyboard = [
        [{ text: '📚 Cosplaytele', callback_data: `dosearch_cosplay_${query}` }],
        [{ text: '🎬 Rule34 Video', callback_data: `dosearch_r34_${query}` }],
        [{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]
      ];
      const sentMsg = await sendMenuWithThumb(bot, msg.chat.id, text, keyboard);
      autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
    } else {
      log.info(`[User ${msg.chat.id}] Execute /search (No Query)`);
      const text = `🔍 <b>Pencarian Karakter</b>\n\nPilih sumber pencarian:`;
      const keyboard = [
        [{ text: '📚 Cari di Cosplaytele', callback_data: 'menu_search_cosplay' }],
        [{ text: '🎬 Cari di Rule34 Video', callback_data: 'menu_search_r34' }],
        [{ text: '🔙 Menu Utama', callback_data: 'menu_awal' }]
      ];
      const sentMsg = await sendMenuWithThumb(bot, msg.chat.id, text, keyboard);
      autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
    }
  });

  bot.onText(/\/clear/, async (msg) => {
    log.info(`[User ${msg.chat.id}] Execute /clear (WIPING ALL)`);
    const sentMsg = await bot.sendMessage(msg.chat.id, '🧹 <i>Tornado Pembersih Aktif! Menghapus hampir seribu riwayat pesan terakhir secara mendalam...</i>', { parse_mode: 'HTML' });

    // Looping mundur menghapus hingga 800 pesan terakhir dengan delay
    // Mencegah EFATAL: AggregateError akibat API/Socket exhaustion
    for (let i = msg.message_id; i > Math.max(0, msg.message_id - 1000); i--) {
      bot.deleteMessage(msg.chat.id, i).catch(() => { });
      await sleep(25); // Delay 25ms untuk mempercepat namun tidak spamming
    }

    // Hapus chat sapu bersihnya juga setelah beberapa detik
    setTimeout(() => {
      bot.deleteMessage(msg.chat.id, sentMsg.message_id).catch(() => { });
    }, 4000);
  });


  bot.onText(/^\/stat(?:\s|$)/, async (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });
    if (String(msg.chat.id) !== '6663343995') return; // Hanya admin ID 6663343995

    const uptimeSec = Math.floor((Date.now() - botStats.startTime) / 1000);
    const hrs = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const ramMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    const totalMemMB = (os.totalmem() / 1024 / 1024).toFixed(0);
    const freeMemMB = (os.freemem() / 1024 / 1024).toFixed(0);

    let dlFormatted = botStats.downloadedBytes > 1024 * 1024 * 1024 ? (botStats.downloadedBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB' : (botStats.downloadedBytes / (1024 * 1024)).toFixed(2) + ' MB';

    const txt = `💻 <b>Statistik Server VPS Global</b>\n━━━━━━━━━━━━━━━━━━\n⏳ <b>Uptime:</b> ${hrs} Jam ${mins} Menit\n💾 <b>RAM Node.js:</b> ${ramMB} MB\n🖥️ <b>RAM VPS:</b> Sisa ${freeMemMB} MB / ${totalMemMB} MB\n\n📈 <b>Kinerja Bot:</b>\n🌐 Trafik Disalurkan: <b>${dlFormatted}</b>\n✅ Total Eksekusi Terkirim: <b>${botStats.totalJobs}</b> \n━━━━━━━━━━━━━━━━━━`;
    const sentMsg = await bot.sendMessage(msg.chat.id, txt, { parse_mode: 'HTML' });
    autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
  });

  bot.onText(/^\/stats(?:\s|$)/, async (msg) => {
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => { });

    const s = statsDb.getUserStats(msg.chat.id);
    const exp = Math.floor(s.downloadBytes / (1024 * 1024)) + (s.gachaCasts * 50); // 1 MB = 1 EXP, 1 Gacha = 50 EXP

    let rank = 'Newbie 🪓';
    if (String(msg.chat.id) === '6663343995') rank = 'DEWA 👑👑👑 (Maha Kuasa)';
    else if (exp >= 10000000) rank = 'DEWA 👑 (Legendary God)';
    else if (exp >= 100000) rank = 'Legend 🐉';
    else if (exp >= 25000) rank = 'Senior ⚔️';
    else if (exp >= 5000) rank = 'Junior 🏹';

    const totalMediaGb = s.downloadBytes > 1024 * 1024 * 1024
      ? (s.downloadBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
      : (s.downloadBytes / (1024 * 1024)).toFixed(2) + ' MB';

    const uname = msg.chat.username ? `@${msg.chat.username}` : (msg.chat.first_name || 'Anonim');

    const txt = `🔰 <b>Profile</b>\n━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Identitas:</b> ${uname}\n` +
      `🎯 <b>Peringkat Tuan:</b> ${rank}\n` +
      `✨ <b>EXP:</b> ${exp.toLocaleString('id-ID')} Pt\n\n` +
      `🎁 <b>Gacha Dimainkan:</b> ${s.gachaCasts} Kali\n` +
      `📦 <b>Media Terkirim:</b> ${totalMediaGb} Data Super HD\n` +
      `━━━━━━━━━━━━━━━━━━\n<i>Tingkatkan EXP untuk meraih Ranking Dewa!</i>`;

    const sentMsg = await bot.sendMessage(msg.chat.id, txt, { parse_mode: 'HTML' });
    autoCleanOldMenu(bot, msg.chat.id, sentMsg.message_id);
  });

  // Handling user messages for Terabox manual and Passwords
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    log.info(`[User ${chatId}] Mengirim pesan text: ${text.substring(0, 50)}...`);

    const state = userStates.get(chatId);

    // If awaiting password
    if (state && state.step === 'AWAITING_PASSWORD') {
      const pw = (text.toUpperCase() === 'SKIP') ? null : text;
      userStates.delete(chatId);
      bot.sendMessage(chatId, `🔐 Password set to: ${pw ? pw : '(None)'}. Memulai download...`);
      queueManager.addJob(chatId, 'Manual Download', async (jobId) => {
        await processDownload(bot, chatId, state.url, pw, 'terabox', jobId);
      }, bot);
      return;
    }

    // If awaiting search query
    if (state && state.step === 'AWAITING_SEARCH_QUERY') {
      userStates.delete(chatId);
      log.info(`[User ${chatId}] Pencarian Interaktif: ${text}`);
      doCosplayteleBrowse(bot, chatId, 'home', 1, text);
      return;
    }

    // If awaiting R34 search query
    if (state && state.step === 'AWAITING_R34_SEARCH') {
      userStates.delete(chatId);
      log.info(`[User ${chatId}] Pencarian R34Video: ${text}`);
      doR34Browse(bot, chatId, 1, text);
      return;
    }

    // Direct link paste
    if (text.includes('terabox.com') || text.includes('1024terabox.com')) {
      userStates.set(chatId, { step: 'AWAITING_SOURCE', url: text });
      bot.sendMessage(chatId, '🔗 <b>TeraBox Link Terdeteksi!</b>\n\nApakah link ini dari 4KHD.com?', {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Ya, dari 4KHD (Auto Password)', callback_data: 'src_4khd' }],
            [{ text: '❌ Bukan (Input Manual)', callback_data: 'src_other' }]
          ]
        }
      });
      return;
    }

    if (text.includes('gofile.io')) {
      queueManager.addJob(chatId, 'Gofile Eksternal', async (jobId) => {
        await processDownload(bot, chatId, text, null, 'gofile', jobId);
      }, bot);
      return;
    }
  });

  // Callbacks
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const action = query.data;
    log.info(`[User ${chatId}] Hitungan Callback: ${action}`);
    bot.answerCallbackQuery(query.id).catch(() => { });

    let sid = null;
    const status = async (txt) => {
      try {
        if (!txt) {
          if (sid) bot.deleteMessage(chatId, sid).catch(() => { });
          return;
        }
        if (!sid) {
          const m = await bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
          sid = m.message_id;
        } else {
          await bot.editMessageText(txt, { chat_id: chatId, message_id: sid, parse_mode: 'HTML' }).catch(() => { });
        }
      } catch (e) { }
    };

    if (action.startsWith('dls_gofile_')) {
      const fileId = action.replace('dls_gofile_', '');
      const state = userStates.get(chatId);
      if (!state || state.step !== 'SELECT_GOFILE_FILE') return bot.sendMessage(chatId, 'Sesi kadaluarsa. Coba klik download ulang dari menu.');

      const gofileUrl = state.url + '#file=' + fileId;
      userStates.delete(chatId);

      queueManager.addJob(chatId, `Gofile (File ${fileId})`, async (jobId) => {
        await processDownload(bot, chatId, gofileUrl, null, 'gofile', jobId);
      }, bot);
      return;
    }

    // Menus
    if (action === 'menu_cosplaytele' || action === 'menu_browse') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doCosplayteleBrowse(bot, chatId);
    }
    if (action === 'menu_gacha') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doCosplayteleGacha(bot, chatId);
    }
    if (action === 'menu_awal') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return sendMainMenu(bot, chatId);
    }
    if (action === 'menu_kemono_reroll') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      const urls = ['https://kemono.cr/patreon/user/3295915', 'https://kemono.cr/patreon/user/49965584'];
      const pickedUrl = urls[Math.floor(Math.random() * urls.length)];
      return doKemonoGacha(bot, chatId, pickedUrl);
    }

    // ── Rule34Video Callbacks ──
    if (action === 'menu_r34_browse') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doR34Browse(bot, chatId);
    }
    if (action === 'menu_r34_gacha') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doR34Gacha(bot, chatId);
    }
    if (action === 'r34_search_prompt') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      userStates.set(chatId, { step: 'AWAITING_R34_SEARCH' });
      const sentMsg = await bot.sendMessage(chatId, '🎬 <b>Pencarian Rule34Video</b>\n\nSilakan ketik tag/karakter yang ingin dicari:', { parse_mode: 'HTML' });
      autoCleanOldMenu(bot, chatId, sentMsg.message_id);
      return;
    }
    if (action === 'r34_back_browse') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      const cache = r34BrowseCache.get(chatId);
      return doR34Browse(bot, chatId, cache?.page || 1, cache?.query || null);
    }
    if (action.startsWith('r34page_')) {
      const pg = parseInt(action.replace('r34page_', ''));
      const cache = r34BrowseCache.get(chatId);
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doR34Browse(bot, chatId, pg, cache?.query || null);
    }
    if (action.startsWith('r34_') && !action.startsWith('r34dl') && !action.startsWith('r34page_')) {
      const idx = parseInt(action.replace('r34_', ''));
      const cache = r34BrowseCache.get(chatId);
      if (!cache || !cache.posts[idx]) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa.');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doR34PostDetail(bot, chatId, cache.posts[idx]);
    }
    if (action.startsWith('r34dlres_')) {
      // Format: r34dlres_{postIdx}_{resIdx}
      const parts = action.replace('r34dlres_', '').split('_');
      const postIdx = parseInt(parts[0]);
      const resIdx = parseInt(parts[1]);
      const cache = r34BrowseCache.get(chatId);
      if (!cache || !cache.posts[postIdx]) return bot.sendMessage(chatId, '⚠️ Sesi kadaluarsa.');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });

      const post = cache.posts[postIdx];
      const dlMsg = await bot.sendMessage(chatId, `🎬 <b>${escHtml(post.title)}</b>\n\n<i>⏳ Mengunduh video...</i>`, { parse_mode: 'HTML' });

      try {
        const links = await r34Scraper.scrapePostDetail(post.link);
        const targetLink = links[resIdx] || links[0];
        if (!targetLink) {
          return bot.editMessageText('❌ Link tidak ditemukan.', { chat_id: chatId, message_id: dlMsg.message_id });
        }

        queueManager.addJob(chatId, `R34: ${post.title}`, async (jobId) => {
          const jobDir = path.join(CONFIG.TEMP_DIR, 'r34_' + jobId);
          await fsp.mkdir(jobDir, { recursive: true });
          const dest = path.join(jobDir, 'video.mp4');

          await downloadStream(targetLink.url, dest, null, null);
          const fsize = fs.statSync(dest).size;
          const sizeMB = (fsize / 1024 / 1024).toFixed(1);
          log.ok(`[R34] Downloaded ${targetLink.label} (${sizeMB}MB)`);

          if (fsize > CONFIG.VIDEO_MAX_BYTES) {
            await rimraf(jobDir);
            return bot.sendMessage(chatId, `⚠️ <b>${escHtml(post.title)}</b>\n\n❌ <b>${targetLink.label}</b> berukuran <b>${sizeMB}MB</b> — melebihi batas limit platform Telegram Anda saat ini (${Math.floor(CONFIG.VIDEO_MAX_BYTES / 1024 / 1024)}MB).`);
          }

          await bot.sendVideo(chatId, fs.createReadStream(dest), {
            caption: `🎬 <b>${escHtml(post.title)}</b> (${targetLink.label}, ${sizeMB}MB)`, parse_mode: 'HTML', supports_streaming: true
          });
          await rimraf(jobDir);
        }, bot);
        bot.deleteMessage(chatId, dlMsg.message_id).catch(() => { });
      } catch (e) {
        log.error('R34 DL Error: ' + e.message);
        bot.editMessageText(`❌ Error: ${e.message}`, { chat_id: chatId, message_id: dlMsg.message_id }).catch(() => { });
      }
      return;
    }
    if (action === 'menu_vps') {
      if (String(chatId) !== '6663343995') {
        return bot.answerCallbackQuery(query.id, { text: '⛔ Akses Ditolak: Anda bukan Admin Server!', show_alert: true });
      }
      bot.answerCallbackQuery(query.id).catch(() => { });

      const uptimeSec = Math.floor((Date.now() - botStats.startTime) / 1000);
      const hrs = Math.floor(uptimeSec / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      const ramMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      const totalMemMB = (os.totalmem() / 1024 / 1024).toFixed(0);
      const freeMemMB = (os.freemem() / 1024 / 1024).toFixed(0);
      let dlFormatted = botStats.downloadedBytes > 1024 * 1024 * 1024 ? (botStats.downloadedBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB' : (botStats.downloadedBytes / (1024 * 1024)).toFixed(2) + ' MB';

      const txt = `💻 <b>Statistik Server VPS Global</b>\n━━━━━━━━━━━━━━━━━━\n⏳ <b>Uptime:</b> ${hrs} Jam ${mins} Menit\n💾 <b>RAM Node.js:</b> ${ramMB} MB\n🖥️ <b>RAM VPS:</b> Sisa ${freeMemMB} MB / ${totalMemMB} MB\n\n📈 <b>Kinerja Bot:</b>\n🌐 Trafik Disalurkan: <b>${dlFormatted}</b>\n✅ Total Eksekusi Terkirim: <b>${botStats.totalJobs}</b> \n━━━━━━━━━━━━━━━━━━`;
      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
      return;
    }

    if (action === 'menu_profile') {
      bot.answerCallbackQuery(query.id).catch(() => { });
      const s = statsDb.getUserStats(chatId);
      const exp = Math.floor(s.downloadBytes / (1024 * 1024)) + (s.gachaCasts * 50); // 1 MB = 1 EXP, 1 Gacha = 50 EXP

      let rank = 'Newbie 🪓';
      if (String(chatId) === '6663343995') rank = 'DEWA 👑👑👑 (Maha Kuasa)';
      else if (exp >= 10000000) rank = 'DEWA 👑 (Legendary God)';
      else if (exp >= 100000) rank = 'Legend 🐉';
      else if (exp >= 25000) rank = 'Senior ⚔️';
      else if (exp >= 5000) rank = 'Junior 🏹';

      const totalMediaGb = s.downloadBytes > 1024 * 1024 * 1024
        ? (s.downloadBytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
        : (s.downloadBytes / (1024 * 1024)).toFixed(2) + ' MB';

      const uname = query.from.username ? `@${query.from.username}` : (query.from.first_name || 'Anonim');

      const txt = `🔰 <b>Profile</b>\n━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Identitas:</b> ${uname}\n` +
        `🎯 <b>Peringkat:</b> ${rank}\n` +
        `✨ <b>EXP:</b> ${exp.toLocaleString('id-ID')} Pt\n\n` +
        `🎁 <b>Gacha Dimainkan:</b> ${s.gachaCasts} Kali\n` +
        `📦 <b>Media Terkirim:</b> ${totalMediaGb} Data Super HD\n` +
        `━━━━━━━━━━━━━━━━━━\n<i>Tingkatkan EXP untuk meraih Ranking Dewa!</i>`;

      await bot.sendMessage(chatId, txt, { parse_mode: 'HTML' });
      return;
    }

    if (action === 'menu_clear') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      const sentMsg = await bot.sendMessage(chatId, '🧹 <i>Tornado Pembersih Aktif! Menghapus hampir seribu riwayat pesan terakhir secara mendalam...</i>', { parse_mode: 'HTML' });
      for (let i = query.message.message_id; i > Math.max(0, query.message.message_id - 800); i--) {
        bot.deleteMessage(chatId, i).catch(() => { });
        await sleep(25);
      }
      setTimeout(() => { bot.deleteMessage(chatId, sentMsg.message_id).catch(() => { }); }, 4000);
      return;
    }

    if (action === 'menu_terabox') {
      const msg = await sendMenuWithThumb(bot, chatId, '📥 <b>Manual Terabox</b>\n\nSilakan COPY & PASTE link TeraBox / 4KHD langsung ke chat bot ini.', [[{ text: '🔙 Kembali', callback_data: 'menu_awal' }]]);
      autoCleanOldMenu(bot, chatId, msg.message_id);
      return;
    }
    if (action === 'menu_search_cosplay') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      userStates.set(chatId, { step: 'AWAITING_SEARCH_QUERY' });
      const msg = await sendMenuWithThumb(bot, chatId, '📚 <b>Pencarian Cosplaytele</b>\n\nSilakan ketik nama karakter, cosplayer, atau judul di kolom chat:', [[{ text: '🔙 Batal', callback_data: 'menu_awal' }]]);
      autoCleanOldMenu(bot, chatId, msg.message_id);
      return;
    }
    if (action === 'menu_search_r34') {
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      userStates.set(chatId, { step: 'AWAITING_R34_SEARCH' });
      const msg = await sendMenuWithThumb(bot, chatId, '🎬 <b>Pencarian Rule34Video</b>\n\nSilakan ketik tag atau nama karakter di kolom chat:', [[{ text: '🔙 Batal', callback_data: 'menu_awal' }]]);
      autoCleanOldMenu(bot, chatId, msg.message_id);
      return;
    }
    if (action.startsWith('dosearch_cosplay_')) {
      const q = action.replace('dosearch_cosplay_', '');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doCosplayteleBrowse(bot, chatId, 'home', 1, q);
    }
    if (action.startsWith('dosearch_r34_')) {
      const q = action.replace('dosearch_r34_', '');
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
      return doR34Browse(bot, chatId, 1, q);
    }

    // Pagination Cosplaytele
    if (action.startsWith('cpage_')) {
      const page = parseInt(action.split('_')[1], 10);
      const cache = browseCache.get(chatId);
      if (cache) doCosplayteleBrowse(bot, chatId, cache.category, page, cache.query);
      return;
    }

    // Terabox Source selection
    if (action === 'src_4khd' || action === 'src_other') {
      const state = userStates.get(chatId);
      if (!state || state.step !== 'AWAITING_SOURCE') return bot.sendMessage(chatId, 'Sesi kadaluarsa, kirim ulang link.');

      if (action === 'src_4khd') {
        userStates.delete(chatId);
        bot.sendMessage(chatId, '✅ Pilihan 4KHD diset. Menghubungi Queue Manager...');
        queueManager.addJob(chatId, 'TeraBox (4KHD)', async (jobId) => {
          await processDownload(bot, chatId, state.url, '4KHD', 'terabox', jobId);
        }, bot);
      } else {
        userStates.set(chatId, { step: 'AWAITING_PASSWORD', url: state.url });
        bot.sendMessage(chatId, '🔑 Silakan ketik <b>Password Arsip</b> dan kirim.\n<i>(Ketik SKIP jika tidak ada password)</i>', { parse_mode: 'HTML' });
      }
      return;
    }

    // Detail Cosplaytele
    if (action.startsWith('cpt_')) {
      const idx = parseInt(action.split('_')[1], 10);
      const cache = browseCache.get(chatId);
      if (!cache || !cache.posts[idx]) return bot.sendMessage(chatId, 'Data kedaluwarsa.');

      const post = cache.posts[idx];
      log.info(`[User ${chatId}] Membuka detail post: ${post.title}`);
      const dMsg = await bot.sendMessage(chatId, `🔍 Memeriksa link untuk:\n<b>${post.title}</b>`, { parse_mode: 'HTML' });

      await sendPostDetail(bot, chatId, dMsg, post, idx);
    }

    // Kembali ke Browse List (Tombol Back)
    if (action === 'back_browse') {
      const cache = browseCache.get(chatId);
      bot.deleteMessage(chatId, query.message.message_id).catch(() => { }); // Hapus foto preview

      if (cache) {
        if (cache.isGacha) {
          const sentMsg = await bot.sendMessage(chatId, `👋 <b>CosTele Bot</b>\n\nPilih mode operasi:`, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔍 Browse Cosplaytele', callback_data: 'menu_cosplaytele' }],
                [{ text: '🎲 Gacha Cosplay (Acak!)', callback_data: 'menu_gacha' }],
                [{ text: '🔎 Cari / Search Judul', callback_data: 'menu_search' }],
                [{ text: '📥 Manual Terabox DL', callback_data: 'menu_terabox' }]
              ]
            }
          });
          return autoCleanOldMenu(bot, chatId, sentMsg.message_id);
        }
        return doCosplayteleBrowse(bot, chatId, cache.category, cache.page, cache.query);
      }
      return bot.sendMessage(chatId, 'Sesi kadaluarsa, ketik /browse kembali.');
    }

    // Auto Gofile Download dari menu
    if (action.startsWith('dlgofile_')) {
      const idx = parseInt(action.split('_')[1], 10);
      const cache = browseCache.get(chatId);
      if (!cache || !cache.posts[idx]) return;
      const post = cache.posts[idx];
      const links = await cosplayteleScraper.scrapePostDetail(post.url);
      if (links && links.gofile) {
        queueManager.addJob(chatId, `Gofile: ${post.title}`, async (jobId) => {
          await processDownload(bot, chatId, links.gofile, null, 'gofile', jobId);
        }, bot);
      } else {
        bot.sendMessage(chatId, '⚠️ Link gofile tidak ditemukan untuk post ini.');
      }
    }

    // Auto MediaFire Download dari menu
    if (action.startsWith('dlmediafire_')) {
      const idx = parseInt(action.split('_')[1], 10);
      const cache = browseCache.get(chatId);
      if (!cache || !cache.posts[idx]) return;
      const post = cache.posts[idx];
      const links = await cosplayteleScraper.scrapePostDetail(post.url);

      if (links && links.mediafire) {
        queueManager.addJob(chatId, `MediaFire: ${post.title}`, async (jobId) => {
          try {
            queueManager.updateJob(jobId, '⚙️ Mencari direct link MediaFire...');
            const directMFUrl = await mediafireApi.getDirectLink(links.mediafire);
            await processDownload(bot, chatId, directMFUrl, null, 'direct', jobId);
          } catch (e) {
            bot.sendMessage(chatId, `⚠️ <b>Gagal (Job #${jobId})!</b> ${e.message}`, { parse_mode: 'HTML' });
          }
        }, bot);
      } else {
        bot.sendMessage(chatId, '⚠️ Link mediafire tidak lagi tersedia untuk post ini.');
      }
    }

    // Auto SoraFolder Download dari menu
    if (action.startsWith('dlsorafolder_')) {
      const idx = parseInt(action.split('_')[1], 10);
      const cache = browseCache.get(chatId);
      if (!cache || !cache.posts[idx]) return;
      const post = cache.posts[idx];
      const links = await cosplayteleScraper.scrapePostDetail(post.url);

      if (links && links.sorafolder) {
        queueManager.addJob(chatId, `SoraFolder: ${post.title}`, async (jobId) => {
          let m = await bot.sendMessage(chatId, '⏳ <b>Bypass SoraFolder:</b> Pekerja mulai meretas blokade 10 detik...', { parse_mode: 'HTML' }).catch(() => { });

          let countdown = 12;
          const timerInterval = setInterval(() => {
            if (countdown > 0) {
              if (m) bot.editMessageText(`⏳ <b>Bypass SoraFolder:</b> Melewati gerbang keamanan...\n<i>Menunggu paksa timer situs: <b>${countdown} detik</b></i>`, { chat_id: chatId, message_id: m.message_id, parse_mode: 'HTML' }).catch(() => { });
              queueManager.updateJob(jobId, `⚙️ Menembus Proteksi 10D (${countdown}s tersisa)...`);
              countdown -= 2;
            }
          }, 2000);

          try {
            const directSoraUrl = await sorafolderApi.getDirectLink(links.sorafolder);
            clearInterval(timerInterval);
            if (m) bot.deleteMessage(chatId, m.message_id).catch(() => { });
            await processDownload(bot, chatId, directSoraUrl, null, 'direct', jobId);
          } catch (e) {
            clearInterval(timerInterval);
            bot.sendMessage(chatId, `⚠️ <b>Gagal (Job #${jobId})!</b> ${e.message}`, { parse_mode: 'HTML' });
            if (m) bot.deleteMessage(chatId, m.message_id).catch(() => { });
          }
        }, bot);
      } else {
        bot.sendMessage(chatId, '⚠️ Link Sorafolder tidak lagi tersedia untuk post ini.');
      }
    }
  });

  bot.on('polling_error', (e) => log.error('Polling: ' + e.message));
}

process.on('uncaughtException', (err) => log.error(`Uncaught: ${err.message}`));
process.on('unhandledRejection', (err) => {
  if (err && err.message && err.message.includes('ETELEGRAM: 400 Bad Request: message to edit not found')) return; // Abaikan pesan yang sudah dihapus
  if (err && err.message && err.message.includes('ETELEGRAM: 400 Bad Request: not Found')) return; // Abaikan pesan yang sudah dihapus
  log.error(`Unhandled: ${err}`);
});
startBot();
