# neotrade.pro Referral Bot v1.0

Bot otomatis untuk mendaftar akun **app.neotrade.pro** secara massal memakai dompet HD
dan menerapkan **kode invite (referral)** lewat Sign-In with Ethereum (SIWE).

> **Peringatan:** repo ini melakukan otomasi signup massal. Penggunaan dapat melanggar
> ToS neotrade.pro dan berisiko akun diblokir. Gunakan hanya untuk pengujian pribadi.
> Anda bertanggung jawab penuh atas penggunaan tool ini.

---

## Logika referral neotrade.pro (hasil reverse-engineer bundle `app.neotrade.pro`)

| Aspek | neotrade.pro |
| --- | --- |
| Login | **SIWE** (Sign-In with Ethereum) via viem + Reown AppKit / WalletConnect |
| Captcha | **Tidak ada** (tidak perlu 2Captcha / Turnstile) |
| Referral | URL `?invite=<CODE>` → disimpan sebagai `neotrade.invite` (sessionStorage) |
| Penerapan referral | Dibundel di login: `invite_code` dikirim ke endpoint verify |
| Sesi | **httpOnly cookie** (`credentials: same-origin`) — bukan Bearer token |
| Safe approval | Tidak ada |

### Alur signup + referral

```
1. Buka app.neotrade.pro/?invite=<CODE>            (app simpan invite_code)
2. POST /v1/auth/siwe/challenge  { address }        → { nonce, message }   (SIWE message)
3. personal_sign(message) dengan private key       → signature
4. POST /v1/auth/siwe/verify  { nonce, signature, invite_code }
                                                    → server set cookie sesi, akun dibuat
5. GET /v1/me  (cookie)                             → data akun
6. GET /v1/invite-codes?status=&page=               → kode referral milik akun + status mint
```

Karena tidak ada captcha dan tidak ada approval terpisah, **seluruh signup bisa
dilakukan murni via API** — tanpa browser, tanpa 2Captcha, tanpa Puppeteer. Bot ini
memakai pendekatan itu di mode Auto.

### Endpoint API yang dipakai (base `https://app.neotrade.pro`)

| Method | Path | Body | Keterangan |
| --- | --- | --- | --- |
| POST | `/v1/auth/siwe/challenge` | `{address}` | minta nonce + SIWE message |
| POST | `/v1/auth/siwe/verify` | `{nonce, signature, invite_code?}` | login, set cookie |
| POST | `/v1/auth/email/start` | `{email}` | kirim kode email (alternatif) |
| POST | `/v1/auth/email/verify` | `{email, code, invite_code?}` | login email, set cookie |
| POST | `/v1/wallet/challenge` | `{address}` | bind wallet ke akun |
| POST | `/v1/wallet/bind` | `{nonce, signature}` | bind wallet |
| GET  | `/v1/me` | — | info akun saat ini |
| GET  | `/v1/invite-codes?status=&page=&tx_hash=` | — | kode referral + status mint |
| POST | `/v1/invite-codes/:id/retry` | — | ulang mint kode |
| POST | `/v1/auth/logout` | — | logout |

Semua request: `Content-Type: application/json`, kirim `Cookie` dari response sebelumnya,
dan header `Origin` / `Referer` = `https://app.neotrade.pro` (mengikuti `same-origin`).

---

## Fitur

- **Derivasi wallet HD** — 1 seed phrase (BIP-44 `m/44'/60'/0'/0`) → N wallet
- **Mode Auto** — **pure-API SIWE** (tanpa browser, tanpa captcha), cepat & ringan
- **Mode Manual** — buka Chrome asli (non-headless), signup interaktif dengan walletmu sendiri, capture cookie sesi
- **Auto referral** — `invite_code` otomatis dikirim saat verify
- **Resume** — wallet yang sudah sukses dilewati, tersimpan di `processed_wallets.json`
- **Menu interaktif** — 6 mode operasi dalam satu proses
- **Cek referral** — tarik `/v1/me` + `/v1/invite-codes` untuk tiap akun sukses

## Requirements

- Node.js v18+ (disarankan v20)
- (Mode Manual saja) Google Chrome terpasang + puppeteer di-install

## Instalasi

```bash
cd neotradeinv
npm install

# hanya jika ingin memakai Mode Manual (browser):
npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
npx puppeteer browsers install chrome
```

## Konfigurasi

Buat file `.env` di root project (sudah disiapkan, isi nilai sendiri):

```env
MNEMONIC=word1 word2 word3 ... word12
INVITE_CODE=KODE_INVITE_KAMU
MAX_INDEX=50
DELAY_MS=5000
BASE_URL=https://app.neotrade.pro
VERBOSE=1
```

| Variabel | Wajib | Default | Keterangan |
| --- | --- | --- | --- |
| `MNEMONIC` | ya (mode 2 & 3) | — | Seed 12/24 kata. Boleh dikosongkan, dibuat lewat menu `1` |
| `INVITE_CODE` | tidak | — | Kode invite/referral dari URL `?invite=<CODE>` |
| `MAX_INDEX` | tidak | `50` | Jumlah wallet HD yang diproses |
| `DELAY_MS` | tidak | `5000` | Jeda antar wallet (ms) |
| `BASE_URL` | tidak | `https://app.neotrade.pro` | Override target URL |
| `VERBOSE` | tidak | — | Set `1` untuk log detail |

> `.env` sudah masuk `.gitignore` — **jangan pernah** commit seed phrase.

## Menjalankan

```bash
npm start          # menu interaktif
npm run auto       # langsung jalan mode Auto (skip menu)
```

### Menu

```
1) Generate New Wallet    Buat mnemonic acak + simpan ke .env
2) Run Bot Auto           Pure-API SIWE (no browser, no captcha)
3) Run Bot Manual         Chrome asli, signup interaktif (butuh puppeteer)
4) Check Referral Status  Cek /v1/me & /v1/invite-codes semua wallet sukses
5) View Processed Wallets Lihat riwayat hasil
6) Reset Wallet Data      Hapus processed_wallets.json & kosongkan MNEMONIC
0) Exit
```

### Alur Mode Auto (2)

```
1. Derive wallet[index] dari MNEMONIC (BIP-44)
2. POST /v1/auth/siwe/challenge {address}  → {nonce, message}
3. ethers wallet.signMessage(message)      → signature (personal_sign / EIP-191)
4. POST /v1/auth/siwe/verify {nonce, signature, invite_code}
   → server set cookie sesi, akun+referral terdaftar
5. GET /v1/me (cookie)                     → konfirmasi akun
6. GET /v1/invite-codes (cookie)            → kode referral milik akun baru
7. Simpan hasil ke processed_wallets.json
8. Jeda DELAY_MS, lanjut wallet berikutnya
```

## Script Pendamping

```bash
npm run reset    # Reset data wallet (processed_wallets.json + MNEMONIC .env)
```

## Struktur Project

```
├── index.js               # Menu utama + semua mode operasi
├── api.js                 # neotrade.pro API: SIWE, email, wallet/bind, me, invite-codes
├── wallet.js              # Derivasi HD wallet + tracking processed_wallets.json
├── browser.js             # (Mode Manual) Puppeteer: buka invite URL, capture cookie
├── processed_wallets.json # Hasil proses (gitignored)
└── .env                   # Konfigurasi (gitignored)
```

> Tidak ada `captcha.js` — neotrade.pro **tidak memakai captcha**, jadi tidak diperlukan
> solver. Mode Auto juga tidak memakai `browser.js` (murni API).

## Field `processed_wallets.json`

```json
{
  "index": 0,
  "address": "0x...",
  "status": "success | failed",
  "userId": "...",
  "inviteCode": "...",
  "account": { },
  "inviteCodes": { },
  "cookie": "name=value; ...",
  "error": null,
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

File ini berisi **cookie sesi aktif** — jangan di-share dan jangan di-commit.

## Troubleshooting

| Masalah | Solusi |
| --- | --- |
| `Set MNEMONIC di .env` | Isi MNEMONIC, atau jalankan menu `1` untuk generate |
| `challenge HTTP 4xx` | Cek address valid; cek `BASE_URL` benar |
| `verify HTTP 4xx` | Signature salah? Pastikan pakai ethers `signMessage` (EIP-191) — sudah otomatis |
| `me HTTP 401` | Cookie sesi tidak tersimpan/terkirim — jalankan ulang wallet itu |
| Rate-limit / 429 | Naikkan `DELAY_MS`, kurangi `MAX_INDEX` |
| Mode Manual: Chrome tidak ditemukan | Set `CHROME_PATH` atau install google-chrome + puppeteer |
| Mode Manual: `puppeteer tidak terpasang` | `npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth` |

## Lisensi

MIT — gunakan dengan tanggung jawab Anda sendiri.
