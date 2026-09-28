// api/midtrans/create-token.js
// Vercel Serverless Function to generate Midtrans Snap Token

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      plan = '1m',
      amount,
      tenant_id,
      store_name = 'Toko UMKM',
      customer_name,
      customer_phone,
      customer_email
    } = req.body || {};

    // Standard package pricing fallback
    const PACKAGE_PRICES = {
      '1m': 30000,
      '3m': 75000,
      '12m': 250000
    };

    const PACKAGE_NAMES = {
      '1m': 'Balanjo POS 1 Bulan (30 Hari)',
      '3m': 'Balanjo POS 3 Bulan (90 Hari)',
      '12m': 'Balanjo POS 12 Bulan (365 Hari)'
    };

    const finalAmount = Number(amount) || PACKAGE_PRICES[plan] || 30000;
    const planName = PACKAGE_NAMES[plan] || `Balanjo POS (${plan})`;

    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';

    if (!serverKey || serverKey.includes('your_sandbox_server_key_here')) {
      return res.status(500).json({
        error: 'MIDTRANS_SERVER_KEY belum diatur di Environment Variables (.env.local atau Vercel).'
      });
    }

    // Generate unique order ID format: ORDER-BLJ-YYYYMMDD-XXXX
    const now = new Date();
    const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
    const rand = Math.floor(1000 + Math.random() * 9000);
    const orderId = req.body.order_id || `ORDER-BLJ-${ymd}-${rand}`;

    const snapEndpoint = isProduction
      ? 'https://app.midtrans.com/snap/v1/transactions'
      : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

    const authString = Buffer.from(`${serverKey}:`).toString('base64');

    const payload = {
      transaction_details: {
        order_id: orderId,
        gross_amount: finalAmount
      },
      item_details: [
        {
          id: plan,
          price: finalAmount,
          quantity: 1,
          name: planName.substring(0, 50)
        }
      ],
      customer_details: {
        first_name: (store_name || customer_name || 'Pelanggan').substring(0, 50),
        email: customer_email || 'kasir@balanjo.id',
        phone: customer_phone || '081234567890'
      },
      // Pass metadata through custom fields for webhook matching
      custom_field1: tenant_id || '',
      custom_field2: plan,
      custom_field3: store_name || ''
    };

    const midtransRes = await fetch(snapEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${authString}`
      },
      body: JSON.stringify(payload)
    });

    const data = await midtransRes.json();

    if (!midtransRes.ok) {
      console.error('Midtrans API error:', data);
      return res.status(midtransRes.status).json({
        error: data.error_messages ? data.error_messages.join(', ') : 'Gagal menghubungi Midtrans Snap API',
        details: data
      });
    }

    // Optional: Log pending request to Supabase if credentials are present and tenant_id provided
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (supabaseUrl && serviceRoleKey && tenant_id && !serviceRoleKey.includes('your_supabase')) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/payment_requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            tenant_id: tenant_id,
            plan: plan,
            amount: finalAmount,
            bank_name: 'Midtrans Snap',
            account_name: store_name,
            status: 'pending',
            rejection_reason: orderId
          })
        });
      } catch (dbErr) {
        console.warn('Could not pre-log payment_request to Supabase:', dbErr.message);
      }
    }

    return res.status(200).json({
      order_id: orderId,
      token: data.token,
      redirect_url: data.redirect_url,
      plan: plan,
      amount: finalAmount
    });
  } catch (err) {
    console.error('Create token handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
}
