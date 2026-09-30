// api/auth/check-email.js
// Endpoint to verify whether an email is already registered as a tenant/user in Balanjo POS Supabase

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const emailParam = req.method === 'GET' ? req.query.email : req.body?.email;
  const email = (emailParam || '').trim().toLowerCase();

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Email tidak valid' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://vojacwqruwkhcswyqhyh.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = 'sb_publishable_nZMjA4bnvEfTvYDEa9QZeA_Mg3S21eE';
  
  // Prefer service key to bypass RLS, fallback to anon key
  const activeKey = (serviceKey && !serviceKey.includes('your_supabase')) ? serviceKey : anonKey;

  const headers = {
    'Content-Type': 'application/json',
    apikey: activeKey,
    Authorization: `Bearer ${activeKey}`
  };

  try {
    let tenantId = null;
    let storeName = '';
    let tenantCode = '';
    let phone = '';
    let expireDate = null;

    // 1. Check in profiles table
    try {
      const profRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id,name,phone,tenant_id&limit=1`,
        { headers }
      );
      if (profRes.ok) {
        const profs = await profRes.json();
        if (profs && profs.length > 0) {
          tenantId = profs[0].tenant_id;
          storeName = profs[0].name || '';
          phone = profs[0].phone || '';
        }
      }
    } catch (err) {
      console.warn('[check-email] Failed querying profiles:', err.message);
    }

    // 2. If not found in profiles, check in tenants table by admin_wa (used as email link in web payments)
    if (!tenantId) {
      try {
        const tRes = await fetch(
          `${supabaseUrl}/rest/v1/tenants?admin_wa=eq.${encodeURIComponent(email)}&select=id,name,code,owner_phone&limit=1`,
          { headers }
        );
        if (tRes.ok) {
          const tenants = await tRes.json();
          if (tenants && tenants.length > 0) {
            tenantId = tenants[0].id;
            storeName = tenants[0].name || '';
            tenantCode = tenants[0].code || '';
            phone = tenants[0].owner_phone || '';
          }
        }
      } catch (err) {
        console.warn('[check-email] Failed querying tenants by admin_wa:', err.message);
      }
    }

    // 3. If tenantId was found from profiles, fetch the tenant details
    if (tenantId && !tenantCode) {
      try {
        const tRes2 = await fetch(
          `${supabaseUrl}/rest/v1/tenants?id=eq.${tenantId}&select=id,name,code,owner_phone&limit=1`,
          { headers }
        );
        if (tRes2.ok) {
          const tData = await tRes2.json();
          if (tData && tData.length > 0) {
            tenantCode = tData[0].code || '';
            if (!storeName) storeName = tData[0].name || '';
            if (!phone) phone = tData[0].owner_phone || '';
          }
        }
      } catch (err) {
        console.warn('[check-email] Failed querying tenant detail:', err.message);
      }
    }

    // 4. If tenant found, retrieve latest subscription info & check if trial has been used
    if (tenantId) {
      let hasUsedTrial = false;
      try {
        const subRes = await fetch(
          `${supabaseUrl}/rest/v1/subscriptions?tenant_id=eq.${tenantId}&order=expire_date.desc&limit=5`,
          { headers }
        );
        if (subRes.ok) {
          const subs = await subRes.json();
          if (subs && subs.length > 0) {
            expireDate = subs[0].expire_date;
            // Tenant is considered having used trial if any subscription exists (trial or paid)
            hasUsedTrial = subs.some(s => s.plan === 'trial') || subs.length > 0;
          }
        }
      } catch (err) {
        console.warn('[check-email] Failed querying subscriptions:', err.message);
      }

      // If tenant exists in database, user has an account so trial cannot be reused
      hasUsedTrial = true;

      return res.status(200).json({
        exists: true,
        email,
        tenant_id: tenantId,
        store_name: storeName,
        tenant_code: tenantCode,
        phone,
        expire_date: expireDate,
        has_used_trial: hasUsedTrial
      });
    }

    // Not found -> New tenant / user
    return res.status(200).json({
      exists: false,
      email
    });

  } catch (err) {
    console.error('[check-email Error]:', err.message);
    return res.status(500).json({
      error: 'Gagal mengecek status email',
      details: err.message
    });
  }
}
