// api/payment/create.js
// Unified Payment Controller: Switches between Midtrans (Plan A) and Xoftware Pay (Plan B)
// Auto-registers new tenant & user in Supabase with structured diagnostic feedback on success/failure.
import crypto from 'crypto';
import { createXoftwareTransaction } from '../../lib/xoftware.js';

// Helper to resolve active gateway dynamically from Supabase app_config (managed by Superadmin in APK)
async function resolveActiveGateway() {
  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://vojacwqruwkhcswyqhyh.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_nZMjA4bnvEfTvYDEa9QZeA_Mg3S21eE';

    const resp = await fetch(`${supabaseUrl}/rest/v1/app_config?key=eq.payment_methods&select=value`, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`
      }
    });

    if (resp.ok) {
      const rows = await resp.json();
      if (rows && rows.length > 0 && rows[0].value) {
        const val = rows[0].value;
        if (val.provider) {
          const prov = String(val.provider).toLowerCase();
          if (prov === 'xoftware' || prov === 'midtrans' || prov === 'manual') {
            return prov;
          }
        }
        if (val.gateway === true) {
          return 'midtrans';
        }
        if (val.manual_transfer === true && !val.gateway) {
          return 'manual';
        }
      }
    }
  } catch (err) {
    console.warn('[Unified Payment] Failed to fetch dynamic gateway config from Supabase:', err.message);
  }

  return (process.env.PAYMENT_GATEWAY || 'midtrans').toLowerCase();
}

// Helper to ensure tenant and user exist in Supabase (auto-register if new)
async function ensureTenantAndUser({
  email,
  password,
  storeName,
  phone,
  customTenantCode,
  existingTenantId,
  orderId,
  plan,
  amount,
  gateway
}) {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://vojacwqruwkhcswyqhyh.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = 'sb_publishable_nZMjA4bnvEfTvYDEa9QZeA_Mg3S21eE';
  const hasServiceKey = Boolean(serviceKey && !serviceKey.includes('your_supabase'));
  const activeKey = hasServiceKey ? serviceKey : anonKey;

  const headers = {
    'Content-Type': 'application/json',
    apikey: activeKey,
    Authorization: `Bearer ${activeKey}`
  };

  let resolvedTenantId = existingTenantId;
  let resolvedTenantCode = customTenantCode ? customTenantCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) : '';
  let isNewAccount = false;
  let authUserId = null;

  // 1. If tenantId not provided, search by email in profiles and tenants
  if (!resolvedTenantId && email) {
    try {
      const profRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id,tenant_id&limit=1`,
        { headers }
      );
      if (profRes.ok) {
        const profs = await profRes.json();
        if (profs && profs.length > 0 && profs[0].tenant_id) {
          resolvedTenantId = profs[0].tenant_id;
        }
      }
    } catch (e) {
      console.warn('[ensureTenantAndUser] Profile search warning:', e.message);
    }

    if (!resolvedTenantId) {
      try {
        const tRes = await fetch(
          `${supabaseUrl}/rest/v1/tenants?admin_wa=eq.${encodeURIComponent(email)}&select=id,code&limit=1`,
          { headers }
        );
        if (tRes.ok) {
          const tenants = await tRes.json();
          if (tenants && tenants.length > 0) {
            resolvedTenantId = tenants[0].id;
            resolvedTenantCode = tenants[0].code || resolvedTenantCode;
          }
        }
      } catch (e) {
        console.warn('[ensureTenantAndUser] Tenant search warning:', e.message);
      }
    }
  }

  // 2. If STILL no tenantId, this is a NEW customer: auto-register user & tenant!
  if (!resolvedTenantId && email) {
    isNewAccount = true;
    const newTenantId = crypto.randomUUID();
    if (!resolvedTenantCode) {
      resolvedTenantCode = 'T' + newTenantId.replace(/-/g, '').substring(0, 9).toUpperCase();
    }

    // A. Check Service Role Key requirement for new user creation
    if (!hasServiceKey && password) {
      console.warn('[ensureTenantAndUser] Warning: SUPABASE_SERVICE_ROLE_KEY missing on Vercel.');
      // Return a diagnostic error so the admin/user immediately knows what to configure
      return {
        success: false,
        stage: 'supabase_config',
        error: 'Kredensial SUPABASE_SERVICE_ROLE_KEY belum terpasang di Vercel',
        analysis: 'Pendaftaran akun baru secara otomatis memerlukan kunci Service Role Supabase untuk membuat pengguna di auth.users tanpa verifikasi email manual.',
        recommendation: 'Buka Dashboard Vercel -> Project Settings -> Environment Variables, tambahkan SUPABASE_SERVICE_ROLE_KEY dengan nilai service_role secret dari Supabase Dashboard (Settings -> API), lalu lakukan Redeploy.',
        technical_details: {
          missing_env: 'SUPABASE_SERVICE_ROLE_KEY',
          email,
          timestamp: new Date().toISOString()
        }
      };
    }

    // B. Create Supabase Auth User via Admin API
    if (hasServiceKey && password) {
      try {
        const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`
          },
          body: JSON.stringify({
            email: email,
            password: password,
            email_confirm: true,
            user_metadata: {
              name: storeName || 'Toko Pelanggan',
              phone: phone || ''
            }
          })
        });

        const authData = await authRes.json();

        if (authRes.ok) {
          authUserId = authData.id;
          console.log(`[ensureTenantAndUser] Created Supabase Auth user: ${authUserId} for ${email}`);
        } else {
          // If auth creation fails (e.g. user already registered or password weak)
          const errorMsg = authData.message || authData.msg || authData.error_description || 'Gagal mendaftarkan akun di Supabase Auth';
          return {
            success: false,
            stage: 'supabase_auth_admin',
            error: `Gagal membuat akun kasir: ${errorMsg}`,
            analysis: `Supabase Auth Admin API mengembalikan error status ${authRes.status}: ${errorMsg}`,
            recommendation: errorMsg.toLowerCase().includes('already')
              ? 'Email ini kemungkinan sudah ada di auth.users. Coba gunakan email lain atau periksa daftar pengguna di Supabase Auth.'
              : 'Pastikan format password memenuhi standar keamanan (minimal 6 karakter) dan parameter user_metadata valid.',
            technical_details: {
              http_status: authRes.status,
              supabase_error: authData,
              email,
              timestamp: new Date().toISOString()
            }
          };
        }
      } catch (authEx) {
        return {
          success: false,
          stage: 'supabase_auth_network',
          error: `Koneksi ke Supabase Auth gagal: ${authEx.message}`,
          analysis: 'Terjadi gangguan jaringan atau timeout saat memanggil endpoint Admin Auth Supabase.',
          recommendation: 'Periksa koneksi internet serverless Vercel atau status layanan Supabase.',
          technical_details: {
            exception: authEx.message,
            timestamp: new Date().toISOString()
          }
        };
      }
    }

    // C. Insert into public.tenants
    try {
      const insertTenantRes = await fetch(`${supabaseUrl}/rest/v1/tenants`, {
        method: 'POST',
        headers: {
          ...headers,
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          id: newTenantId,
          code: resolvedTenantCode,
          name: storeName || 'Toko Pelanggan',
          owner_name: storeName || 'Toko Pelanggan',
          owner_phone: phone || '',
          admin_wa: email, // Linked via email
          is_active: true
        })
      });

      if (insertTenantRes.ok) {
        resolvedTenantId = newTenantId;
        console.log(`[ensureTenantAndUser] Created tenant ${resolvedTenantId} (${resolvedTenantCode})`);
      } else {
        const tErrText = await insertTenantRes.text();
        return {
          success: false,
          stage: 'public_tenants_insert',
          error: 'Gagal menyimpan data toko ke tabel public.tenants',
          analysis: `Supabase PostgREST menolak penambahan tenant: ${tErrText}`,
          recommendation: 'Periksa apakah kode toko sudah terpakai sebelumnya (UNIQUE constraint) atau aturan RLS pada tabel tenants.',
          technical_details: {
            http_status: insertTenantRes.status,
            error_body: tErrText,
            tenant_code: resolvedTenantCode,
            timestamp: new Date().toISOString()
          }
        };
      }
    } catch (tEx) {
      return {
        success: false,
        stage: 'public_tenants_network',
        error: `Gagal menghubungi tabel tenants: ${tEx.message}`,
        analysis: 'Terjadi kendala jaringan saat menghubungi database Supabase PostgREST.',
        recommendation: 'Periksa URL Supabase dan status endpoint database.',
        technical_details: {
          exception: tEx.message,
          timestamp: new Date().toISOString()
        }
      };
    }

    // D. Update public.profiles if auth user was created
    if (authUserId && resolvedTenantId) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${authUserId}`, {
          method: 'PATCH',
          headers: {
            ...headers,
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            tenant_id: resolvedTenantId,
            phone: phone || ''
          })
        });
      } catch (pEx) {
        console.warn('[ensureTenantAndUser] Warning: Failed linking profile to tenant:', pEx.message);
      }
    }
  }

  // 3. Record pending payment request with orderId
  if (resolvedTenantId && orderId) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/payment_requests`, {
        method: 'POST',
        headers: {
          ...headers,
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          tenant_id: resolvedTenantId,
          plan: plan || '1m',
          amount: Math.round(Number(amount)),
          bank_name: gateway === 'xoftware' ? 'Xoftware Pay (QRIS)' : 'Midtrans',
          account_name: `Order: ${orderId}`,
          rejection_reason: orderId, // Matches order_id for webhook lookup
          status: 'pending'
        })
      });
    } catch (prEx) {
      console.warn('[ensureTenantAndUser] Failed recording payment_request:', prEx.message);
    }
  }

  return {
    success: true,
    tenantId: resolvedTenantId,
    tenantCode: resolvedTenantCode,
    isNewAccount,
    dbStatus: {
      stage: 'completed',
      user_created: isNewAccount,
      tenant_id: resolvedTenantId,
      tenant_code: resolvedTenantCode,
      message: isNewAccount
        ? 'Akun kasir baru dan data toko berhasil didaftarkan di Supabase'
        : 'Data akun kasir dan toko terdaftar berhasil diverifikasi'
    }
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const activeGateway = await resolveActiveGateway();
  const body = req.body || {};

  // High-entropy unique order ID generator fallback
  const now = new Date();
  const dateStr = now.toISOString().slice(2, 10).replace(/-/g, '');
  const timeStr = String(now.getHours()).padStart(2, '0') +
                  String(now.getMinutes()).padStart(2, '0') +
                  String(now.getSeconds()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  const orderId = (body.order_id && String(body.order_id).trim()) || `BLJ-${dateStr}-${timeStr}-${rand}`;

  if (activeGateway === 'manual') {
    return res.status(400).json({
      success: false,
      error: 'Pembayaran otomatis dinonaktifkan oleh Admin. Silakan gunakan transfer manual dan kirim bukti via WhatsApp.',
      gateway: 'manual'
    });
  }

  try {
    let finalAmount = Number(body.amount);
    let appliedVoucherCode = (body.voucher_code || '').trim().toUpperCase();

    // Server-side voucher verification & daily counter update
    if (appliedVoucherCode && body.plan !== 'trial') {
      try {
        const supabaseUrl = process.env.SUPABASE_URL || 'https://vojacwqruwkhcswyqhyh.supabase.co';
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const anonKey = 'sb_publishable_nZMjA4bnvEfTvYDEa9QZeA_Mg3S21eE';
        const activeKey = (serviceKey && !serviceKey.includes('your_supabase')) ? serviceKey : anonKey;

        const vCfgRes = await fetch(`${supabaseUrl}/rest/v1/app_config?key=eq.promo_vouchers&select=value`, {
          headers: { apikey: activeKey, Authorization: `Bearer ${activeKey}` }
        });

        if (vCfgRes.ok) {
          const vRows = await vCfgRes.json();
          let vouchersList = (vRows && vRows.length > 0 && Array.isArray(vRows[0].value)) ? vRows[0].value : [];
          const vIdx = vouchersList.findIndex(v => String(v.code || '').trim().toUpperCase() === appliedVoucherCode);

          if (vIdx !== -1) {
            const v = vouchersList[vIdx];
            const today = new Date().toISOString().slice(0, 10);
            const isValid = v.is_active !== false && (!v.valid_from || today >= v.valid_from) && (!v.valid_until || today <= v.valid_until);
            const usageHistory = v.usage_history || {};
            const usedToday = Number(usageHistory[today]) || 0;
            const dailyLimit = Number(v.daily_limit) || 0;

            if (isValid && (dailyLimit <= 0 || usedToday < dailyLimit)) {
              // Increment usage counter
              usageHistory[today] = usedToday + 1;
              v.usage_history = usageHistory;
              vouchersList[vIdx] = v;

              // Save updated counter back to Supabase
              fetch(`${supabaseUrl}/rest/v1/app_config?key=eq.promo_vouchers`, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  apikey: activeKey,
                  Authorization: `Bearer ${activeKey}`,
                  Prefer: 'return=minimal'
                },
                body: JSON.stringify({ value: vouchersList, updated_at: new Date().toISOString() })
              }).catch(e => console.warn('[create.js] Failed updating voucher usage:', e.message));
            }
          }
        }
      } catch (vErr) {
        console.warn('[create.js] Voucher check failed:', vErr.message);
      }
    }

    // 1. Auto-register tenant & user or fetch existing tenant
    const tenantResult = await ensureTenantAndUser({
      email: body.customer_email,
      password: body.customer_password,
      storeName: body.store_name,
      phone: body.customer_phone,
      customTenantCode: body.tenant_code,
      existingTenantId: body.tenant_id,
      orderId: orderId,
      plan: body.plan,
      amount: finalAmount,
      gateway: activeGateway
    });

    // If database registration failed, return structured diagnostic error
    if (!tenantResult.success) {
      return res.status(400).json({
        success: false,
        error: tenantResult.error,
        stage: tenantResult.stage,
        analysis: tenantResult.analysis,
        recommendation: tenantResult.recommendation,
        technical_details: tenantResult.technical_details
      });
    }

    const { tenantId, tenantCode, dbStatus } = tenantResult;

    // 2. Delegate to active payment gateway
    if (activeGateway === 'xoftware') {
      const response = await createXoftwareTransaction({
        orderId: orderId,
        amount: finalAmount,
        storeName: body.store_name,
        customerEmail: body.customer_email,
        phone: body.customer_phone,
        channelCode: body.channel_code || 'QRIS'
      });

      const trxData = response.data || response;
      const invoiceId = trxData.invoice_id || trxData.invoice || (trxData.invoice_detail ? trxData.invoice_detail.id : null);
      const txId = trxData.id || trxData.tx_id || trxData.transaction_id || null;

      return res.status(200).json({
        success: true,
        gateway: 'xoftware',
        db_status: dbStatus,
        order_id: orderId,
        tenant_id: tenantId,
        tenant_code: tenantCode,
        qris_text: trxData.qris_text || '',
        transaction_id: txId,
        invoice_id: invoiceId,
        amount: trxData.amount || finalAmount,
        expires_at: trxData.expires_at || trxData.expired_at || null,
        url: trxData.url || ''
      });

    } else {
      // Default: Midtrans Snap Token
      const serverKey = process.env.MIDTRANS_SERVER_KEY;
      if (!serverKey) {
        return res.status(200).json({
          success: true,
          gateway: 'midtrans',
          demo_mode: true,
          token: null,
          db_status: dbStatus,
          tenant_id: tenantId,
          tenant_code: tenantCode,
          order_id: orderId
        });
      }

      const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';
      const midtransApiUrl = isProduction
        ? 'https://app.midtrans.com/snap/v1/transactions'
        : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

      const authString = Buffer.from(`${serverKey}:`).toString('base64');

      const midtransPayload = {
        transaction_details: {
          order_id: orderId,
          gross_amount: Math.round(Number(body.amount))
        },
        item_details: [
          {
            id: body.plan || '1m',
            price: Math.round(Number(body.amount)),
            quantity: 1,
            name: `Langganan Kasir (${body.plan || '1m'})`
          }
        ],
        customer_details: {
          first_name: body.store_name || 'Pelanggan',
          email: body.customer_email,
          phone: body.customer_phone || ''
        },
        custom_field1: tenantId || '',
        custom_field2: body.plan || '1m',
        custom_field3: body.customer_email || '',
        callbacks: {
          finish: `${process.env.APP_URL || 'https://lukmanisme.vercel.app'}/balanjo/success.html`
        }
      };

      const mRes = await fetch(midtransApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Basic ${authString}`
        },
        body: JSON.stringify(midtransPayload)
      });

      const mData = await mRes.json();

      if (!mRes.ok || (!mData.token && !mData.redirect_url)) {
        return res.status(400).json({
          success: false,
          stage: 'midtrans_gateway',
          error: mData.error_messages ? mData.error_messages.join(', ') : 'Gagal membuat transaksi di Midtrans',
          analysis: `Midtrans Snap API mengembalikan respons status ${mRes.status}`,
          recommendation: 'Periksa MIDTRANS_SERVER_KEY dan pastikan akun Midtrans sudah berstatus aktif (Production/Sandbox).',
          technical_details: {
            http_status: mRes.status,
            midtrans_response: mData,
            order_id: orderId
          }
        });
      }

      return res.status(200).json({
        success: true,
        gateway: 'midtrans',
        db_status: dbStatus,
        order_id: orderId,
        tenant_id: tenantId,
        tenant_code: tenantCode,
        token: mData.token || null,
        redirect_url: mData.redirect_url || null
      });
    }

  } catch (err) {
    console.error('[Unified Payment Error]:', err.message);
    return res.status(500).json({
      success: false,
      stage: 'server_exception',
      error: 'Terjadi kesalahan sistem saat memproses pembayaran',
      analysis: err.message,
      recommendation: 'Periksa log serverless Vercel atau hubungi pengembang untuk analisis lebih mendalam.',
      technical_details: {
        exception: err.message,
        gateway: activeGateway,
        timestamp: new Date().toISOString()
      }
    });
  }
}
