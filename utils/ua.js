'use strict';

// UA tunggal untuk seluruh scraper: konsisten + mudah di-upgrade.
// Kalau situs target mulai memblok versi tertentu, cukup ubah di sini.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Beberapa host (mis. Mega) menolak UA browser generik dan minta klien dikenali.
const UA_BOT = 'CosTeleBot/1.0 (+https://github.com/Aryoksss/CosTeleBot)';

module.exports = { UA, UA_BOT };
