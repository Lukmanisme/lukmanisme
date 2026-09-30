// api/payment/create.js
// Unified Payment Controller: Switches between Midtrans (Plan A) and Xoftware Pay (Plan B)
// Auto-registers new tenant & user in Supabase if not yet registered.
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
  const activeKey = (serviceKey && !serviceKey.includes('your_supabase')) ? serviceKey : anonKey;

  const headers = {
    'Content-Type': 'application/json',
    apikey: activeKey,
    Authorization: `Bearer ${activeKey}`
  };

  let resolvedTenantId = existingTenantId;
  let resolvedTenantCode = customTenantCode ? customTenantCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) : '';

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
    const newTenantId = crypto.randomUUID();
    if (!resolvedTenantCode) {
      resolvedTenantCode = 'T' + newTenantId.replace(/-/g, '').substring(0, 9).toUpperCase();
    }

    let authUserId = null;

    // A. Create Supabase Auth User via Admin API if serviceKey is present
    if (serviceKey && !serviceKey.includes('your_supabase') && password) {
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

        if (authRes.ok) {
          const authData = await authRes.json();
          authUserId = authData.id;
          console.log(`[ensureTenantAndUser] Created Supabase Auth user: ${authUserId} for ${email}`);
        } else {
          const authErr = await authRes.json();
          console.warn('[ensureTenantAndUser] Admin Auth create note:', authErr);
        }
      } catch (authEx) {
        console.warn('[ensureTenantAndUser] Failed calling Admin Auth API:', authEx.message);
      }
    }

    // B. Insert into public.tenants
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
      }
    } catch (tEx) {
      console.warn('[ensureTenantAndUser] Failed inserting tenant:', tEx.message);
    }

    // C. Update public.profiles if auth user was created
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
        console.warn('[ensureTenantAndUser] Failed linking profile to tenant:', pEx.message);
      }
    }
  }

  // 3. Record pending payment request with orderId so webhook can easily link and approve
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
    tenantId: resolvedTenantId,
    tenantCode: resolvedTenantCode
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

  if (activeGateway === 'manual') {
    return res.status(400).json({
      error: 'Pembayaran otomatis dinonaktifkan oleh Admin. Silakan gunakan transfer manual dan kirim bukti via WhatsApp.',
      gateway: 'manual'
    });
  }

  try {
    // Auto-register tenant & user or fetch existing tenant
    const { tenantId, tenantCode } = await ensureTenantAndUser({
      email: body.customer_email,
      password: body.customer_password,
      storeName: body.store_name,
      phone: body.customer_phone,
      customTenantCode: body.tenant_code,
      existingTenantId: body.tenant_id,
      orderId: body.order_id,
      plan: body.plan,
      amount: body.amount,
      gateway: activeGateway
    });

    if (activeGateway === 'xoftware') {
      // Delegate to Xoftware Pay
      const response = await createXoftwareTransaction({
        orderId: body.order_id,
        amount: Number(body.amount),
        storeName: body.store_name,
        customerEmail: body.customer_email,
        phone: body.customer_phone,
        channelCode: body.channel_code || 'QRIS'
      });

      const trxData = response.data || response;
      return res.status(200).json({
        gateway: 'xoftware',
        order_id: body.order_id,
        tenant_id: tenantId,
        tenant_code: tenantCode,
        qris_text: trxData.qris_text || '',
        transaction_id: trxData.transaction_id,
        amount: trxData.amount || body.amount,
        expires_at: trxData.expires_at,
        url: trxData.url || ''
      });

    } else {
      // Default: Midtrans Snap Token
      const serverKey = process.env.MIDTRANS_SERVER_KEY;
      if (!serverKey) {
        return res.status(200).json({
          gateway: 'midtrans',
          demo_mode: true,
          token: null,
          tenant_id: tenantId,
          tenant_code: tenantCode,
          order_id: body.order_id
        });
      }

      const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';
      const midtransApiUrl = isProduction
        ? 'https://app.midtrans.com/snap/v1/transactions'
        : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

      const authString = Buffer.from(`${serverKey}:`).toString('base64');

      const midtransPayload = {
        transaction_details: {
          order_id: body.order_id,
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
      return res.status(200).json({
        gateway: 'midtrans',
        order_id: body.order_id,
        tenant_id: tenantId,
        tenant_code: tenantCode,
        token: mData.token || null,
        redirect_url: mData.redirect_url || null
      });
    }

  } catch (err) {
    console.error('[Unified Payment Error]:', err.message);
    return res.status(500).json({
      error: 'Payment processing failed',
      gateway: activeGateway,
      details: err.message
    });
  }
}
