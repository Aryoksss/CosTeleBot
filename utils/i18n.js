'use strict';

/**
 * i18n ringan via kamus frasa Indonesia→Inggris, diterapkan di lapisan PENGIRIMAN
 * (wrap bot.sendMessage/editMessageText/sendPhoto/Video/Document). Tujuannya: nutup
 * semua teks detail (status download, caption, error, label tombol) tanpa harus edit
 * ratusan call-site. Tidak sempurna secara grammar, tapi membuat output "mostly English".
 *
 * Catatan: HTML tag dipertahankan (kamus tidak berisi fragmen tag). Frasa multi-kata
 * diletakkan lebih dulu agar diganti sebelum kata tunggalnya.
 */

// Urutan PENTING: frasa panjang dulu, baru kata pendek.
const DICT = [
  // Frasa / kalimat umum
  ['Tidak ada source video yang dapat diekstrak', 'No extractable video source'],
  ['Gagal resolve video detail', 'Failed to resolve video detail'],
  ['Source video tidak tersedia', 'Video source unavailable'],
  ['Gagal memuat detail post', 'Failed to load post detail'],
  ['Gagal memuat halaman detail', 'Failed to load detail page'],
  ['Tidak ada link download terdeteksi', 'No download link detected'],
  ['Diunduh kualitas terbaik via HLS. Video besar otomatis dipecah.', 'Downloaded at best quality via HLS. Large videos are auto-split.'],
  ['Video besar otomatis dipecah', 'Large videos are auto-split'],
  ['akan dikirim per-part otomatis', 'will be sent per-part automatically'],
  ['Memecah jadi beberapa part', 'Splitting into multiple parts'],
  ['memecah & mengupload per-part', 'splitting & uploading per-part'],
  ['melebihi limit upload', 'exceeds upload limit'],
  ['melebihi limit', 'exceeds the limit'],
  ['file dilewati', 'file skipped'],
  ['Kuota harian habis', 'Daily quota exhausted'],
  ['Reset otomatis tengah malam', 'Resets automatically at midnight'],
  ['Upgrade untuk kuota lebih besar', 'Upgrade for a bigger quota'],
  ['Kuota hari ini', "Today's quota"],
  ['Antrean Penuh', 'Queue Full'],
  ['tugas unduhan sekaligus', 'download tasks at once'],
  ['termasuk yang berjalan', 'including running ones'],
  ['termasuk yang sedang berjalan', 'including running ones'],
  ['Tunggu yang lama selesai', 'Wait for older ones to finish'],
  ['Harap tunggu hingga yang lama selesai', 'Please wait for older ones to finish'],
  ['atau upgrade', 'or upgrade'],
  ['untuk limit lebih tinggi', 'for a higher limit'],
  ['Sesi kadaluarsa', 'Session expired'],
  ['Sesi kadaluarsa. Ulangi', 'Session expired. Repeat'],
  ['Mengupload ke Telegram', 'Uploading to Telegram'],
  ['Mengupload', 'Uploading'],
  ['Mengunduh video', 'Downloading video'],
  ['Mengunduh kualitas terbaik', 'Downloading best quality'],
  ['Mengunduh', 'Downloading'],
  ['Memulai download', 'Starting download'],
  ['Memuat detail', 'Loading details'],
  ['Memuat XNXX', 'Loading XNXX'],
  ['Memuat EroThots', 'Loading EroThots'],
  ['Memuat Pinterest', 'Loading Pinterest'],
  ['Memuat', 'Loading'],
  ['Memproses isi link Gofile', 'Processing Gofile link'],
  ['Memproses', 'Processing'],
  ['Menyambungkan tautan Gofile CDN', 'Connecting to Gofile CDN'],
  ['Menyambungkan tautan aslinya', 'Connecting to the original link'],
  ['Menyambungkan', 'Connecting'],
  ['Menghubungkan', 'Connecting'],
  ['Gagal kirim', 'Failed to send'],
  ['Gagal mengirim', 'Failed to send'],
  ['Download gagal', 'Download failed'],
  ['Gacha gagal', 'Gacha failed'],
  ['Gacha kosong, coba lagi', 'Gacha empty, try again'],
  ['Kembali ke Daftar', 'Back to List'],
  ['Menu Utama', 'Main Menu'],
  ['Buka halaman', 'Open page'],
  ['Halaman Javtiful', 'Javtiful page'],
  ['Halaman XNXX', 'XNXX page'],
  ['Halaman EroThots', 'EroThots page'],
  ['Pilih sumber pencarian', 'Choose a search source'],
  ['Pilih sumber', 'Choose source'],
  ['Pilih mode', 'Choose mode'],
  ['Pilih paket', 'Choose a plan'],
  ['Tidak ada job aktif', 'No active jobs'],
  ['Antrean kamu', 'Your queue'],
  ['Job kamu', 'Your jobs'],
  ['berjalan', 'running'],
  ['menunggu', 'waiting'],
  ['Batalkan semua antrean saya', 'Cancel all my queue'],
  ['Pembayaran diterima', 'Payment received'],
  ['Belum terbayar', 'Not paid yet'],
  ['Mencoba lagi', 'Retrying'],
  ['Coba Lagi', 'Try Again'],
  ['Coba lagi', 'Try again'],
  ['Ngocok semua sumber', 'Shuffling all sources'],
  ['Tidak ada video', 'No videos'],
  ['Tidak ada pin ditemukan', 'No pins found'],
  ['Tidak ada hasil', 'No results'],
  ['Sedang berjalan', 'Running'],
  ['hasil di halaman ini', 'results on this page'],
  ['ke Telegram', 'to Telegram'],
  ['ke chat bot ini', 'into this chat'],
  ['Pencarian', 'Search'],
  ['Reroll', 'Reroll'],
  // Kata tunggal (word-boundary)
  ['Durasi', 'Duration'],
  ['Ukuran', 'Size'],
  ['Halaman', 'Page'],
  ['Antrean', 'Queue'],
  ['Bersihkan', 'Clear'],
  ['Kembali', 'Back'],
  ['Batal', 'Cancel'],
  ['Gagal', 'Failed'],
  ['Kali', 'times'],
  ['Sumber', 'Source'],
  ['sumber', 'source'],
  ['Aktif', 'Active'],
  ['aktif', 'active'],
  ['Selesai', 'Done'],
  ['selesai', 'done'],
  ['Tunggu', 'Wait'],
  ['detik', 'sec'],
  ['menit', 'min'],
  ['hari', 'days'],
  ['lagi', 'again'],
  ['tersisa', 'left'],
  ['Catatan', 'Note'],
];

// Pre-compile: multi-kata pakai plain replace, satu kata pakai \b boundary.
// Sort by panjang id (desc) supaya frasa panjang selalu diganti sebelum kata pendeknya.
const RULES = DICT.slice().sort((a, b) => b[0].length - a[0].length).map(([id, en]) => {
  const multi = /\s/.test(id);
  const pattern = multi
    ? new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    : new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  return { pattern, en };
});

/** Terjemahkan teks Indonesia → Inggris (best-effort, HTML aman). */
function toEnglish(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const { pattern, en } of RULES) out = out.replace(pattern, en);
  return out;
}

/** Terjemahkan label tombol di reply_markup.inline_keyboard. */
function localizeOptions(opts) {
  if (!opts || !opts.reply_markup || !Array.isArray(opts.reply_markup.inline_keyboard)) return opts;
  const kb = opts.reply_markup.inline_keyboard.map(row =>
    row.map(btn => (btn && typeof btn.text === 'string') ? { ...btn, text: toEnglish(btn.text) } : btn));
  return { ...opts, reply_markup: { ...opts.reply_markup, inline_keyboard: kb } };
}

/**
 * Pasang wrapper i18n ke instance bot. `isEn(chatId)` → true kalau user pakai English.
 * Wrap: sendMessage, editMessageText, sendPhoto/Video/Document (caption).
 */
function attach(bot, isEn) {
  const origSend = bot.sendMessage.bind(bot);
  bot.sendMessage = (chatId, text, opts) => {
    if (isEn(chatId)) { text = toEnglish(text); opts = localizeOptions(opts); }
    return origSend(chatId, text, opts);
  };

  const origEdit = bot.editMessageText.bind(bot);
  bot.editMessageText = (text, opts) => {
    const cid = opts && opts.chat_id;
    if (cid != null && isEn(cid)) { text = toEnglish(text); opts = localizeOptions(opts); }
    return origEdit(text, opts);
  };

  for (const m of ['sendPhoto', 'sendVideo', 'sendDocument', 'sendAnimation']) {
    if (typeof bot[m] !== 'function') continue;
    const orig = bot[m].bind(bot);
    bot[m] = (chatId, file, opts) => {
      if (opts && isEn(chatId)) {
        opts = { ...opts };
        if (typeof opts.caption === 'string') opts.caption = toEnglish(opts.caption);
        opts = localizeOptions(opts);
      }
      return orig(chatId, file, opts);
    };
  }
}

module.exports = { toEnglish, localizeOptions, attach };
