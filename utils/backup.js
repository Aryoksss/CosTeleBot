/**
 * Backup utility: export user data (stats + history) sebagai JSON.
 * Command /backup → bot kirim file JSON ke user.
 * Command /restore + file JSON → bot merge ke existing data.
 */

const fs = require('fs');
const path = require('path');

const statsDb = require('../statsDb');
const historyTracker = require('../history');

const BACKUP_SCHEMA_VERSION = 1;

/**
 * Build backup payload untuk satu user.
 * @param {string|number} chatId
 * @returns {object}
 */
function buildBackup(chatId) {
  const stats = statsDb.getUserStats(chatId);

  // Baca history dari disk (historyTracker tidak expose read-all public API,
  // tapi JSON file accessible)
  const historyFile = path.join(__dirname, '..', 'history.json');
  let userHistory = {};
  if (fs.existsSync(historyFile)) {
    try {
      const all = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      userHistory = all[String(chatId)] || {};
    } catch (_) { }
  }

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    chatId: String(chatId),
    stats: {
      gachaCasts: stats.gachaCasts || 0,
      downloadBytes: stats.downloadBytes || 0,
      favoriteCount: stats.favoriteCount || 0,
      joinDate: stats.joinDate || Date.now(),
    },
    history: userHistory, // { cosplay: [url, url], r34: [...], jav: [...], etc }
    summary: {
      totalHistoryEntries: Object.values(userHistory).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0),
      categories: Object.keys(userHistory),
    },
  };
}

/**
 * Write backup to file in tmp_downloads/, return path.
 */
function writeBackupFile(chatId, tempDir) {
  const payload = buildBackup(chatId);
  const filename = `costelebot_backup_${chatId}_${Date.now()}.json`;
  const destPath = path.join(tempDir, filename);
  fs.writeFileSync(destPath, JSON.stringify(payload, null, 2), 'utf8');
  return { path: destPath, filename, payload };
}

/**
 * Merge backup JSON kembali ke statsDb + history (idempotent).
 * Return: { restored: bool, conflicts: [], entriesAdded: number }
 */
function restoreBackup(chatId, backupJson) {
  if (!backupJson || typeof backupJson !== 'object') {
    return { restored: false, error: 'Invalid backup format' };
  }
  if (backupJson.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    return { restored: false, error: `Unsupported schema version: ${backupJson.schemaVersion}` };
  }

  const targetChatId = String(chatId);
  const srcChatId = String(backupJson.chatId || '');

  // Policy: restore stats ONLY ke chatId asli (prevent steal akun lain)
  // History boleh di-merge cross-account (useful kalau user ganti device)
  const isSameUser = srcChatId === targetChatId;

  // Merge history (additive, dedup)
  const historyFile = path.join(__dirname, '..', 'history.json');
  const tmpFile = historyFile + '.tmp';
  let current = {};
  if (fs.existsSync(historyFile)) {
    try { current = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch (_) { }
  }
  if (!current[targetChatId]) current[targetChatId] = {};

  let entriesAdded = 0;
  for (const [cat, arr] of Object.entries(backupJson.history || {})) {
    if (!Array.isArray(arr)) continue;
    if (!current[targetChatId][cat]) current[targetChatId][cat] = [];
    for (const link of arr) {
      if (typeof link === 'string' && !current[targetChatId][cat].includes(link)) {
        current[targetChatId][cat].push(link);
        entriesAdded++;
      }
    }
    // Limit per category
    if (current[targetChatId][cat].length > 2000) {
      current[targetChatId][cat] = current[targetChatId][cat].slice(-2000);
    }
  }

  fs.writeFileSync(tmpFile, JSON.stringify(current), 'utf8');
  fs.renameSync(tmpFile, historyFile);

  // Restore stats kalau same user — additive supaya tidak timpa progress baru
  let statsRestored = false;
  if (isSameUser && backupJson.stats) {
    const cur = statsDb.getUserStats(targetChatId);
    const merged = {
      gachaCasts: Math.max(cur.gachaCasts || 0, backupJson.stats.gachaCasts || 0),
      downloadBytes: Math.max(cur.downloadBytes || 0, backupJson.stats.downloadBytes || 0),
      favoriteCount: Math.max(cur.favoriteCount || 0, backupJson.stats.favoriteCount || 0),
      joinDate: Math.min(cur.joinDate || Date.now(), backupJson.stats.joinDate || Date.now()),
    };
    // Patch lewat internal — karena statsDb tidak expose setter,
    // kita pakai trik addGacha/addDownloadSize selisih.
    // Simpler: direct edit file via fs (compatibility dengan atomic write existing)
    const statsFile = path.join(__dirname, '..', 'stats.json');
    let all = {};
    if (fs.existsSync(statsFile)) {
      try { all = JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch (_) { }
    }
    all[targetChatId] = merged;
    const tmp = statsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
    fs.renameSync(tmp, statsFile);
    statsRestored = true;
  }

  return {
    restored: true,
    entriesAdded,
    statsRestored,
    sameUser: isSameUser,
    srcChatId,
  };
}

module.exports = {
  buildBackup,
  writeBackupFile,
  restoreBackup,
  BACKUP_SCHEMA_VERSION,
};
