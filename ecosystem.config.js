// PM2 process config untuk CosTeleBot.
// Jalankan pertama kali di VPS: `pm2 start ecosystem.config.js && pm2 save`
// Deploy berikutnya otomatis via .github/workflows/deploy.yml (reload tanpa downtime).
module.exports = {
  apps: [
    {
      name: 'costelebot',
      script: 'telegram-bot.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',          // bot long-polling → cukup 1 proses (jangan cluster)
      autorestart: true,
      watch: false,
      // max_memory_restart HANYA memantau RSS proses Node bot ini (Chromium/Playwright
      // jalan sebagai proses terpisah, tidak ikut terhitung). Jadi ini cuma jaring
      // pengaman kalau Node bocor memori — pengatur RAM total yang sebenarnya adalah
      // QUEUE_CONCURRENCY di .env (tiap job: download+extract+sharp+kadang 1 Chromium).
      //
      // Panduan per RAM VPS:
      //   2 GB : max_memory_restart '640M'  + QUEUE_CONCURRENCY=3 + swap 2G
      //   4 GB : max_memory_restart '1024M' + QUEUE_CONCURRENCY=4 + swap 2G   (default ini)
      //   8 GB : max_memory_restart '2048M' + QUEUE_CONCURRENCY=8
      // Catatan: kalau pakai Local Bot API (docker) untuk upload 2GB, turunkan
      // QUEUE_CONCURRENCY 1 tingkat karena container-nya juga makan RAM.
      max_memory_restart: '1024M',
      time: true,                 // timestamp di log pm2
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
