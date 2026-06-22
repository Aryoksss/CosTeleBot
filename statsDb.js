const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'stats.json');
const TMP_FILE = DB_FILE + '.tmp';

// Memory Cache
let statsData = {};
let saveTimer = null;

/**
 * Muat data dari JSON
 */
function loadDB() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const raw = fs.readFileSync(DB_FILE, 'utf8');
            statsData = JSON.parse(raw);
        } catch (e) {
            console.error(`[StatsDB] Gagal memuat database stats: ${e.message}`);
            statsData = {};
        }
    } else {
        statsData = {};
        saveDB();
    }
}

/**
 * Simpan data ke JSON secara atomic (tulis ke .tmp lalu rename).
 * Mencegah korupsi saat dua write bersamaan.
 */
function saveDB() {
    try {
        fs.writeFileSync(TMP_FILE, JSON.stringify(statsData, null, 2), 'utf8');
        fs.renameSync(TMP_FILE, DB_FILE);
    } catch (e) {
        console.error(`[StatsDB] Gagal menyimpan database stats: ${e.message}`);
    }
}

/**
 * Debounced save: coalesce banyak panggilan write dalam 300ms jadi satu I/O.
 */
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveDB();
    }, 300);
}

function getInitUser(chatId) {
    if (!statsData[chatId]) {
        statsData[chatId] = {
            gachaCasts: 0,
            downloadBytes: 0,
            favoriteCount: 0,
            joinDate: Date.now()
        };
    }
    return statsData[chatId];
}

// ─── PREMIUM / TIER + KUOTA HARIAN ─────────────────────────────────────────────
function _todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Aktifkan/perpanjang premium sejumlah `days` hari. tier: 'premium' | 'vvip'. */
function setPremium(chatId, days, tier = 'premium') {
    const u = getInitUser(chatId);
    const base = Math.max(Date.now(), u.premiumUntil || 0);
    u.premiumUntil = base + (Number(days) || 0) * 86400000;
    u.premiumTier = (tier === 'vvip') ? 'vvip' : 'premium';
    scheduleSave();
    return u.premiumUntil;
}

/** Cabut premium. */
function revokePremium(chatId) {
    const u = getInitUser(chatId);
    u.premiumUntil = 0;
    u.premiumTier = null;
    scheduleSave();
}

/** True kalau user sedang premium/vvip aktif. */
function isPremium(chatId) {
    const u = statsData[chatId];
    return !!(u && u.premiumUntil && u.premiumUntil > Date.now());
}

/** Tier aktif user: 'vvip' | 'premium' | 'free'. */
function getTier(chatId) {
    const u = statsData[chatId];
    if (u && u.premiumUntil && u.premiumUntil > Date.now()) {
        return u.premiumTier === 'vvip' ? 'vvip' : 'premium';
    }
    return 'free';
}

/** Timestamp kadaluarsa premium (0 kalau tidak ada). */
function getPremiumUntil(chatId) {
    const u = statsData[chatId];
    return (u && u.premiumUntil) || 0;
}

// ─── BAN / MODERASI ──────────────────────────────────────────────────────────
/** Blokir user (tidak bisa pakai bot). */
function banUser(chatId) {
    const u = getInitUser(chatId);
    u.banned = true;
    scheduleSave();
}
/** Cabut blokir user. */
function unbanUser(chatId) {
    const u = statsData[chatId];
    if (u) { u.banned = false; scheduleSave(); }
}
/** True kalau user diblokir. */
function isBanned(chatId) {
    const u = statsData[chatId];
    return !!(u && u.banned);
}
/** Semua chatId yang pernah tercatat (untuk broadcast). */
function allChatIds() {
    return Object.keys(statsData);
}

/** Daftar semua user premium aktif → [{chatId, until, tier}]. */
function listPremium() {
    const now = Date.now();
    return Object.entries(statsData)
        .filter(([, u]) => u.premiumUntil && u.premiumUntil > now)
        .map(([chatId, u]) => ({ chatId, until: u.premiumUntil, tier: u.premiumTier === 'vvip' ? 'vvip' : 'premium' }));
}

/** Jumlah download hari ini (auto-reset kalau ganti hari). */
function getDailyDownloads(chatId) {
    const u = getInitUser(chatId);
    if (u.dailyDate !== _todayKey()) return 0;
    return u.dailyCount || 0;
}

// ─── BAHASA (i18n) ──────────────────────────────────────────────────────────
/** Bahasa user: 'en' | 'id' (default 'id'). */
function getLang(chatId) {
    const u = statsData[chatId];
    return (u && u.lang === 'en') ? 'en' : 'id';
}
/** Set bahasa user. */
function setLang(chatId, lang) {
    const u = getInitUser(chatId);
    u.lang = (lang === 'en') ? 'en' : 'id';
    scheduleSave();
    return u.lang;
}

/** Tambah 1 hitungan download hari ini. Return jumlah baru. */
function incDailyDownloads(chatId) {
    const u = getInitUser(chatId);
    const today = _todayKey();
    if (u.dailyDate !== today) { u.dailyDate = today; u.dailyCount = 0; }
    u.dailyCount = (u.dailyCount || 0) + 1;
    scheduleSave();
    return u.dailyCount;
}

/**
 * Catat tambahan tarikan gacha
 */
function addGacha(chatId) {
    getInitUser(chatId).gachaCasts += 1;
    scheduleSave();
}

/**
 * Catat muatan file yang berhasil diunduh (terhitung sebelum Telegram botirim)
 */
function addDownloadSize(chatId, bytes) {
    getInitUser(chatId).downloadBytes += bytes;
    scheduleSave();
}

/**
 * Mengambil rekap kartu profil
 */
function getUserStats(chatId) {
    return getInitUser(chatId);
}

// Pastikan data tersimpan sebelum proses mati
function flushOnExit() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveDB();
}
process.on('beforeExit', flushOnExit);
process.on('SIGINT', () => { flushOnExit(); process.exit(0); });
process.on('SIGTERM', () => { flushOnExit(); process.exit(0); });

// Inisialisasi awal saat ditarik
loadDB();

module.exports = {
    addGacha,
    addDownloadSize,
    getUserStats,
    setPremium,
    revokePremium,
    isPremium,
    getTier,
    getPremiumUntil,
    listPremium,
    getDailyDownloads,
    incDailyDownloads,
    getLang,
    setLang,
    banUser,
    unbanUser,
    isBanned,
    allChatIds,
};
