// api/voucher/validate.js
// Endpoint to validate promo voucher codes against Supabase app_config.promo_vouchers

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code, plan, original_amount } = req.body || {};
  const voucherCode = (code || '').trim().toUpperCase();
  const subtotal = Number(original_amount) || 0;

  if (!voucherCode) {
    return res.status(400).json({ success: false, message: 'Kode voucher tidak boleh kosong' });
  }

  if (plan === 'trial' || subtotal <= 0) {
    return res.status(400).json({ success: false, message: 'Voucher tidak dapat digunakan untuk paket gratis / trial' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://vojacwqruwkhcswyqhyh.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = 'sb_publishable_nZMjA4bnvEfTvYDEa9QZeA_Mg3S21eE';
  const activeKey = (serviceKey && !serviceKey.includes('your_supabase')) ? serviceKey : anonKey;

  try {
    const configRes = await fetch(
      `${supabaseUrl}/rest/v1/app_config?key=eq.promo_vouchers&select=value`,
      {
        method: 'GET',
        headers: {
          apikey: activeKey,
          Authorization: `Bearer ${activeKey}`
        }
      }
    );

    if (!configRes.ok) {
      return res.status(500).json({ success: false, message: 'Gagal menghubungi database konfigurasi voucher' });
    }

    const rows = await configRes.json();
    const vouchersList = (rows && rows.length > 0 && Array.isArray(rows[0].value)) ? rows[0].value : [];
    
    // Find matching voucher
    const voucher = vouchersList.find(v => String(v.code || '').trim().toUpperCase() === voucherCode);

    if (!voucher) {
      return res.status(404).json({ success: false, message: `Kode voucher "${voucherCode}" tidak ditemukan atau sudah tidak berlaku.` });
    }

    if (voucher.is_active === false) {
      return res.status(400).json({ success: false, message: `Voucher "${voucherCode}" saat ini sedang dinonaktifkan.` });
    }

    // Check date range
    const today = new Date().toISOString().slice(0, 10);
    if (voucher.valid_from && today < voucher.valid_from) {
      return res.status(400).json({ success: false, message: `Voucher "${voucherCode}" baru mulai berlaku pada tanggal ${voucher.valid_from}.` });
    }
    if (voucher.valid_until && today > voucher.valid_until) {
      return res.status(400).json({ success: false, message: `Voucher "${voucherCode}" telah kedaluwarsa pada tanggal ${voucher.valid_until}.` });
    }

    // Check daily limit
    const dailyLimit = Number(voucher.daily_limit) || 0;
    const usageHistory = voucher.usage_history || {};
    const usedToday = Number(usageHistory[today]) || 0;

    if (dailyLimit > 0 && usedToday >= dailyLimit) {
      return res.status(400).json({ success: false, message: `Kuota harian untuk voucher "${voucherCode}" telah habis hari ini (${dailyLimit}/${dailyLimit}). Coba lagi besok!` });
    }

    // Calculate discount
    let discountAmount = 0;
    const discountType = voucher.discount_type || 'fixed';
    const discountVal = Number(voucher.discount_value) || 0;

    if (discountType === 'percent') {
      discountAmount = Math.round((subtotal * discountVal) / 100);
      if (voucher.max_discount && discountAmount > Number(voucher.max_discount)) {
        discountAmount = Number(voucher.max_discount);
      }
    } else {
      // Fixed nominal
      discountAmount = discountVal;
    }

    if (discountAmount > subtotal) {
      discountAmount = subtotal;
    }

    const finalAmount = Math.max(0, subtotal - discountAmount);

    return res.status(200).json({
      success: true,
      code: voucherCode,
      label: voucher.label || voucherCode,
      discount_type: discountType,
      discount_value: discountVal,
      discount_amount: discountAmount,
      subtotal,
      final_amount: finalAmount,
      message: `Voucher berhasil diterapkan! Hemat Rp ${discountAmount.toLocaleString('id-ID')}`
    });

  } catch (err) {
    console.error('[validate-voucher Error]:', err.message);
    return res.status(500).json({ success: false, message: `Terjadi kesalahan saat memvalidasi voucher: ${err.message}` });
  }
}
