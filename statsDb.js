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
    getUserStats
};
