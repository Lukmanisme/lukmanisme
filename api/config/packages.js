// api/config/packages.js
// Endpoint to return subscription packages and trial days configured in Supabase app_config

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Default fallback values (matching default system config)
  const defaultResponse = {
    trial_days: 3,
    packages: {
      '1m': { price: 30000, label: '1 Bulan (30 Hari)', days: 30 },
      '3m': { price: 75000, label: 'Paket 3 Bulan (90 Hari)', days: 90 },
      '12m': { price: 250000, label: 'Paket 12 Bulan (365 Hari)', days: 365 }
    }
  };

  const supabaseUrl = process.env.SUPABASE_URL || 'https://vojacwqruwkhcswyqhyh.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = 'sb_publishable_nZMjA4bnvEfTvYDEa9QZeA_Mg3S21eE';
  const activeKey = (serviceKey && !serviceKey.includes('your_supabase')) ? serviceKey : anonKey;

  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/app_config?key=in.(packages,trial_days)&select=key,value`,
      {
        method: 'GET',
        headers: {
          apikey: activeKey,
          Authorization: `Bearer ${activeKey}`
        }
      }
    );

    if (resp.ok) {
      const rows = await resp.json();
      const result = { ...defaultResponse };

      for (const row of rows) {
        if (row.key === 'trial_days') {
          const days = parseInt(typeof row.value === 'object' ? JSON.stringify(row.value) : row.value, 10);
          if (!isNaN(days) && days > 0) {
            result.trial_days = days;
          }
        } else if (row.key === 'packages' && row.value && typeof row.value === 'object') {
          // Merge dynamic prices
          if (row.value['1m'] && row.value['1m'].price) {
            result.packages['1m'].price = Number(row.value['1m'].price);
            if (row.value['1m'].label) result.packages['1m'].label = row.value['1m'].label;
          }
          if (row.value['3m'] && row.value['3m'].price) {
            result.packages['3m'].price = Number(row.value['3m'].price);
            if (row.value['3m'].label) result.packages['3m'].label = row.value['3m'].label;
          }
          if (row.value['12m'] && row.value['12m'].price) {
            result.packages['12m'].price = Number(row.value['12m'].price);
            if (row.value['12m'].label) result.packages['12m'].label = row.value['12m'].label;
          }
        }
      }

      return res.status(200).json({ success: true, data: result });
    }
  } catch (err) {
    console.warn('[api/config/packages] Supabase query failed, falling back to defaults:', err.message);
  }

  return res.status(200).json({ success: true, data: defaultResponse, fallback: true });
}
