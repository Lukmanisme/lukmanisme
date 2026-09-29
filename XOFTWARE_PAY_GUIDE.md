# Panduan Integrasi Xoftware Pay (Plan B) - Balanjo POS

Dokumen ini berisi analisis komprehensif perbandingan **Midtrans (Plan A)** dan **Xoftware Pay (Plan B)**, arsitektur adapter multi-gateway yang telah diimplementasikan, serta panduan langkah demi langkah untuk pengajuan integrasi merchant di Xoftware Pay.

---

## 1. Analisis Kelebihan & Kekurangan: Midtrans vs Xoftware Pay

| Aspek / Kriteria | Midtrans (Plan A) | Xoftware Pay (Plan B) | Analisis & Implikasi untuk Balanjo POS |
| :--- | :--- | :--- | :--- |
| **Profil & Regulasi** | PJP Resmi Berlisensi Bank Indonesia (GoTo Group), standar industri enterprise. | Penyedia payment gateway / aggregator pihak ketiga (fintech lokal). | Midtrans memiliki kepatuhan regulasi tertinggi, namun verifikasi dokumen bisnis dan KYC jauh lebih ketat (menuntut legalitas PT/CV/surat klarifikasi). Xoftware Pay umumnya memiliki proses KYC yang lebih fleksibel untuk UMKM/Individu. |
| **MDR / Biaya Transaksi (QRIS)** | 0.7% (regulasi standar BI untuk QRIS usaha mikro/kecil). | Sesuai kesepakatan merchant / tiering (umumnya berkisar 0.7% - 1.5% atau flat fee per hit). | Keduanya sangat terjangkau untuk model langganan software POS bulanan/tahunan (Rp 49.000 - Rp 499.000). |
| **Kecepatan Onboarding / Aktivasi** | Membutuhkan tinjauan manual KYC 2-5 hari kerja + verifikasi website ketat. | Pengajuan integrasi langsung lewat dashboard (`/merchant/request-integration`) dengan form terpadu. | Xoftware Pay ideal sebagai **Plan B cepat** jika Midtrans menahan approval akun karena klausul "penampungan dana" atau kelengkapan legalitas formal. |
| **User Experience (UI/UX)** | Snap Popup terintegrasi (iframe bawaan Midtrans dengan berbagai metode pembayaran). | API murni (mengembalikan raw `qris_text` standar EMVCo). | Midtrans menyediakan modal otomatis. Xoftware Pay membutuhkan modal QRIS kustom di frontend (telah kita buatkan secara responsif di `balanjo/index.html`). |
| **Arsitektur Keamanan API** | Basic Auth (`ServerKey:` base64) + verifikasi hash SHA512 pada webhook. | Signature HMAC-SHA256 Canonical Request (`X-API-Key`, `X-Timestamp`, `X-Signature`) + Secret Webhook Signature. | Xoftware Pay menerapkan standar canonical signature (mirip AWS / BCA API), sangat aman dari tampering (modifikasi body request di tengah jalan). |
| **Dukungan Serverless / Cloud IP** | Mengizinkan webhook dan panggilan API dari dynamic IP tanpa whitelisting IP ketat. | Mendukung Layer 3/4 IP Whitelisting (Default: `0.0.0.0`). | **Penting**: Karena Vercel menggunakan dynamic cloud IP, whitelist IP di dashboard Xoftware Pay **harus diisi `0.0.0.0`** agar API call tidak menghasilkan error `403 Forbidden`. |

### Ringkasan Strategi:
- **Jadikan Midtrans sebagai Plan A Utama**: Gunakan saat verifikasi selesai untuk memaksimalkan kredibilitas dan brand trust di mata pelanggan.
- **Jadikan Xoftware Pay sebagai Plan B Siap Tempur**: Jika Midtrans menolak atau proses KYC berlarut-larut, sistem Balanjo POS dapat langsung aktif menerima pembayaran QRIS hanya dengan mengubah satu konfigurasi environment di Vercel: `PAYMENT_GATEWAY=xoftware`.

---

## 2. Arsitektur Multi-Gateway yang Telah Diterapkan

Sistem telah dirancang dengan arsitektur **Adapter Pattern** independen sehingga beralih gateway tidak memerlukan penulisan ulang kode:

```
[ Frontend: balanjo/index.html ]
              │
              ▼
    POST /api/payment/create
              │
     ┌────────┴────────┐
     ▼                 ▼
[PAYMENT_GATEWAY=midtrans]    [PAYMENT_GATEWAY=xoftware]
     │                                   │
     ▼                                   ▼
Midtrans Snap Token               Xoftware Pay API
(Popup Snap UI)                 (Modal QRIS Dinamis)
     │                                   │
     ▼                                   ▼
/api/midtrans/webhook             /api/xoftware/webhook
     │                                   │
     └────────┬──────────────────────────┘
              ▼
   [ Supabase Database ]
   • Table: `subscriptions` (Otomatis perpanjang expired_date)
   • Table: `payment_requests` (Update status ke 'settlement' / 'paid')
```

### File-file yang telah dibangun:
1. `lib/xoftware.js` - Helper SDK untuk canonical signature HMAC-SHA256, create transaction, dan verifikasi webhook signature.
2. `api/xoftware/create-transaction.js` - Serverless endpoint transaksi Xoftware Pay.
3. `api/xoftware/webhook.js` - Serverless webhook handler otomatis dengan proteksi signature dan integrasi Supabase.
4. `api/payment/create.js` - Unified payment switcher (router cerdas antara Midtrans & Xoftware Pay).
5. `balanjo/index.html` - Modal QRIS responsif interaktif yang menampilkan kode QR dinamis dari payload `qris_text` Xoftware Pay.

---

## 3. Langkah Pengajuan Integrasi di Xoftware Pay

Halaman login Xoftware Pay (`https://pay.xoftware.id/auth/login/`) dilindungi oleh widget Cloudflare Turnstile, sehingga pengajuan dilakukan langsung oleh merchant melalui browser.

### A. Login ke Dashboard
1. Buka [https://pay.xoftware.id/auth/login/](https://pay.xoftware.id/auth/login/) di browser Anda.
2. Masukkan kredensial:
   - **Username / Email**: `lukmansst`
   - **Password**: `sy4n9AL@210893`
3. Selesaikan verifikasi Cloudflare Turnstile (centang boks "Verify you are human") dan klik **Login**.

### B. Isi Formulir Request Integrasi
Setelah login, masuk ke menu **Integration** atau buka langsung URL:
👉 **`https://pay.xoftware.id/merchant/request-integration`**

Lengkapi formulir dengan rincian berikut:

| Field Formulir | Nilai yang Harus Diisi | Catatan Penjelasan |
| :--- | :--- | :--- |
| **Merchant Name / Nama Usaha** | `Balanjo POS (Lukmanisme)` | Nama produk/aplikasi Anda |
| **Business Category / Sektor** | `Software as a Service (SaaS) / IT Services / Retail Tools` | Kategori penyedia software POS kasir |
| **Website / App URL** | `https://lukmanisme.vercel.app/balanjo` | URL landing page & halaman checkout Balanjo POS |
| **Webhook URL / Callback URL** | `https://lukmanisme.vercel.app/api/xoftware/webhook` | Endpoint Vercel yang otomatis memproses notifikasi pembayaran |
| **IP Whitelist** | `0.0.0.0` | **Sangat penting!** Vercel tidak memiliki static IP; `0.0.0.0` mengizinkan seluruh IP cloud yang memiliki API Key & Signature valid |
| **Payment Channels yang Diminta** | Centang **QRIS** (dan Virtual Account jika diperlukan) | Saluran pembayaran utama Balanjo POS |
| **Deskripsi Singkat Penggunaan** | Pembayaran biaya langganan software POS kasir toko (Balanjo POS) berbasis cloud dengan perpanjangan otomatis akun merchant. | Memastikan tim approval memahami bahwa ini adalah penjualan lisensi software, bukan penampungan dana pihak ketiga. |

### C. Ambil Kredensial API
Setelah pengajuan disetujui (atau pada menu API Credentials), salin data berikut:
1. `Merchant ID` (contoh: `101`)
2. `API Key` (contoh: `xoft_live_...` atau string alfanumerik)
3. `Webhook Secret` (digunakan untuk memvalidasi callback webhook)

---

## 4. Cara Mengaktifkan Xoftware Pay di Vercel

Cukup tambahkan environment variables di dashboard Vercel Anda:
👉 **Vercel Dashboard -> Project (lukmanisme) -> Settings -> Environment Variables**

Tambahkan variabel berikut:
```env
PAYMENT_GATEWAY=xoftware
XOFTWARE_MERCHANT_ID=MASUKKAN_MERCHANT_ID
XOFTWARE_API_KEY=MASUKKAN_API_KEY
XOFTWARE_WEBHOOK_SECRET=MASUKKAN_WEBHOOK_SECRET
XOFTWARE_IS_PRODUCTION=true
```

> **Tips Switch Cepat:**
> - Jika ingin kembali ke Midtrans: Cukup ubah `PAYMENT_GATEWAY` menjadi `midtrans`.
> - Jika ingin beralih ke Xoftware: Cukup ubah `PAYMENT_GATEWAY` menjadi `xoftware`.
> - Lakukan Redeploy di Vercel setelah mengubah Environment Variables agar konfigurasi baru aktif.

---

## 5. Flow Pengujian (Testing & Verifikasi)

1. Buka `https://lukmanisme.vercel.app/balanjo`.
2. Klik tombol paket langganan (misal **Paket Bulanan** Rp 49.000).
3. Masukkan Email & Password akun Balanjo POS Anda.
4. Klik **Lanjutkan Pembayaran**:
   - Jika `PAYMENT_GATEWAY=midtrans`, popup Midtrans Snap akan muncul.
   - Jika `PAYMENT_GATEWAY=xoftware`, popup Modal QRIS Balanjo POS akan muncul dengan QR Code instan dan nominal pas.
5. Lakukan simulasi pembayaran QRIS (scan via aplikasi banking/e-wallet).
6. Xoftware Pay mengirimkan HTTP POST webhook ke `/api/xoftware/webhook`.
7. Webhook memverifikasi `X-Signature`, memvalidasi status `PAID`/`SETTLED`, dan memanggil Supabase untuk menambahkan masa aktif langganan akun email tersebut secara instan.
