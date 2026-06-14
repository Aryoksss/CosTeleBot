# Auto-Deploy: Push GitHub → VPS reload otomatis

Alur: `git push` ke branch `main` → GitHub Actions SSH ke VPS → jalankan `deploy.sh`
(`git pull` + `npm install` kalau dep berubah + `pm2 reload costelebot`).

`.env`, `stats.json`, `history.json`, `browser_profile_*` aman (di-gitignore, tidak ditimpa).

---

## 1. Persiapan di VPS (sekali saja)

```bash
# Pastikan repo sudah di-clone di VPS, mis:
cd ~/CosTeleBot          # path ini yang nanti dipakai sebagai VPS_PATH

# Pastikan PM2 terpasang & bot jalan dengan nama "costelebot"
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup           # ikuti instruksi yang muncul agar bot auto-start saat reboot
```

## 2. Buat SSH key khusus deploy (di laptop / VPS)

```bash
ssh-keygen -t ed25519 -C "github-deploy" -f deploy_key -N ""
# - deploy_key       → private key (masuk ke GitHub Secret VPS_SSH_KEY)
# - deploy_key.pub   → public key (masuk ke VPS)
```

Tambahkan public key ke VPS:

```bash
cat deploy_key.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

## 3. Set GitHub Secrets

Repo GitHub → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret        | Isi                                                        |
|---------------|------------------------------------------------------------|
| `VPS_HOST`    | IP / domain VPS (mis. `123.45.67.89`)                      |
| `VPS_USER`    | user SSH (mis. `root` atau `ubuntu`)                       |
| `VPS_SSH_KEY` | **isi lengkap** file `deploy_key` (private key)            |
| `VPS_PATH`    | path repo di VPS (mis. `/root/CosTeleBot`)                 |
| `VPS_PORT`    | (opsional) port SSH, default `22`                          |

## 4. Selesai

Sekarang tiap `git push origin main`, tab **Actions** akan menjalankan deploy
otomatis. Bisa juga jalankan manual via **Actions → Deploy to VPS → Run workflow**.

---

## Cek & Troubleshoot

```bash
pm2 logs costelebot          # lihat log bot
pm2 status                   # status proses
bash deploy.sh               # tes deploy manual di VPS
```

- **`pm2: command not found` saat Actions jalan** → install pm2 global (`npm i -g pm2`)
  atau pastikan PATH-nya kebaca (deploy.sh sudah menambah path umum + nvm).
- **Permission denied (publickey)** → cek `VPS_SSH_KEY` (private key utuh termasuk
  baris `-----BEGIN/END-----`) dan public key sudah ada di `authorized_keys`.
- **Git minta auth** → repo di VPS sebaiknya pakai remote yang bisa di-pull tanpa
  prompt (HTTPS public, atau deploy key GitHub read-only di VPS).

---

## Alternatif tanpa GitHub Actions (cron pull)

Kalau tak mau pakai Secrets, jadwalkan pull berkala di VPS:

```bash
crontab -e
# cek update tiap 2 menit (reload hanya kalau ada commit baru)
*/2 * * * * cd /root/CosTeleBot && bash deploy.sh >> deploy.log 2>&1
```

`deploy.sh` otomatis skip reload kalau HEAD tidak berubah, jadi aman dijalankan
sesering apa pun lewat cron. GitHub Actions memakai `FORCE_RELOAD=1` supaya manual
re-run tetap reload walau commit-nya sama.

---

## Notifikasi Deploy ke Telegram

`deploy.sh` otomatis kirim pesan ke admin saat deploy sukses/gagal — ambil
`BOT_TOKEN` + chat tujuan dari `.env` VPS.

- Chat tujuan default = `DEPLOY_NOTIFY_CHAT`, fallback ke `ADMIN_IDS` pertama.
- Tambahkan di `.env` VPS (opsional, kalau mau beda dari admin pertama):
  ```
  DEPLOY_NOTIFY_CHAT=123456789
  ```
- Tidak ada token/chat → notif di-skip diam-diam (tidak error).

---

## Operasional VPS (#10)

### Log rotation (biar disk tidak penuh)
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

### Health-check terjadwal (alert kalau sumber down)
```bash
crontab -e
# cek tiap jam; alert ke Telegram admin kalau ada sumber 'error'
0 * * * * cd /root/CosTeleBot && node tools/healthPing.js >> health.log 2>&1
```
Hanya status `error` yang memicu alert (`warn`/rate-limit diabaikan). Naikkan
intervalnya kalau alert terasa berisik saat satu sumber lama down.

### ffmpeg (untuk auto-split video oversize)
Video yang melebihi limit upload Telegram (mis. >2 GB) otomatis dipecah jadi
beberapa part pakai ffmpeg. Wajib install di VPS:
```bash
sudo apt install -y ffmpeg
```
Matikan fitur ini via env `SPLIT_OVERSIZE=0` kalau tidak mau (file oversize dilewati).
