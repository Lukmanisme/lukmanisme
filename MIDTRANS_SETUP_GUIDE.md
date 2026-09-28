# Panduan Setup Midtrans & Webhook Balanjo POS

Dokumen ini berisi panduan lengkap untuk menyelesaikan verifikasi Midtrans (Go-Live) serta konfigurasi webhook auto-verifikasi pembayaran aplikasi kasir **Balanjo POS**.

---

## 1. URL untuk Dimasukkan ke Dashboard Midtrans

Ketika tim Midtrans meminta:
> *"Mohon update URL di dashboard Midtrans dengan URL sesuai dokumen flow transaksi yang sebelumnya Anda lampirkan"*

Masukkan URL berikut:

| Pengaturan di Dashboard Midtrans | Nilai URL yang Harus Dimasukkan | Fungsi / Keterangan |
| :--- | :--- | :--- |
| **Website URL / Mobile App URL**<br>*(Pengaturan Bisnis / Akun)* | `https://lukmanisme.vercel.app/balanjo` | Halaman portal resmi Balanjo POS berisi paket langganan, rincian checkout, Syarat & Ketentuan (`/terms.html`), dan Kebijakan Privasi (`/privacy.html`). |
| **Payment Notification URL (Webhook)**<br>*(Settings &rarr; Configuration)* | `https://lukmanisme.vercel.app/api/midtrans/webhook` | Endpoint API Vercel yang menerima notifikasi pelunasan dan otomatis mengupdate database Supabase (`subscriptions`). |
| **Finish Redirect URL**<br>*(Settings &rarr; Configuration)* | `https://lukmanisme.vercel.app/balanjo` | Halaman tujuan setelah pembayaran selesai. |
| **Unfinish / Error Redirect URL**<br>*(Settings &rarr; Configuration)* | `https://lukmanisme.vercel.app/balanjo` | Halaman tujuan bila transaksi tertunda / batal. |

---

## 2. Konfigurasi Environment Variables di Vercel

Tambahkan variabel-variabel berikut di **Vercel Dashboard &rarr; Project Settings &rarr; Environment Variables**:

| Variable Name | Contoh Nilai (Sandbox) | Keterangan |
| :--- | :--- | :--- |
| `MIDTRANS_SERVER_KEY` | `SB-Mid-server-xxxxxxxxxxxx` | Server Key dari Midtrans (*Settings &rarr; Access Keys*) |
| `MIDTRANS_CLIENT_KEY` | `SB-Mid-client-xxxxxxxxxxxx` | Client Key dari Midtrans (*Settings &rarr; Access Keys*) |
| `MIDTRANS_IS_PRODUCTION` | `false` | Set `false` untuk Sandbox, `true` jika sudah Go-Live Production |
| `SUPABASE_URL` | `https://vojacwqruwkhcswyqhyh.supabase.co` | URL instance Supabase Anda |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGciOi...` *(Secret)* | Dapatkan dari **Supabase Dashboard &rarr; Project Settings &rarr; API &rarr; Project API keys &rarr; `service_role` (secret)**. Wajib menggunakan secret key agar webhook dapat memperpanjang masa aktif tenant tanpa terhalang RLS. |

---

## 3. Cara Mengaktifkan Payment Gateway di Aplikasi Android (Balanjo POS)

1. Buka aplikasi **Balanjo POS** di tablet/smartphone Android.
2. Login menggunakan akun ber-role **Superadmin**.
3. Buka menu **Admin Panel &rarr; Pengaturan**.
4. Gulir ke bawah ke bagian **Metode Pembayaran**:
   - Pilih: **Payment Gateway (Midtrans QRIS / VA Otomatis)**
5. Klik **Simpan Pengaturan**.
6. **Hasil:**
   - Ketika kasir/owner warung memilih paket (1 Bulan / 3 Bulan / 12 Bulan) di layar pemilihan paket maupun saat langganan expired, aplikasi akan otomatis membuka jendela pembayaran Midtrans.
   - Setelah user scan QRIS atau bayar Virtual Account, sistem Midtrans mengirim webhook ke server Vercel, tanggal `expire_date` di Supabase langsung diperpanjang, dan layar aplikasi langsung terbuka secara otomatis (real-time)!
   - Jika pengguna tetap ingin transfer manual, tersedia tombol **Transfer Manual (WA)** di layar pembayaran sebagai alternatif.
