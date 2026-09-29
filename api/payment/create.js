// api/payment/create.js
// Unified Payment Controller: Switches between Midtrans (Plan A) and Xoftware Pay (Plan B)
import { createXoftwareTransaction } from '../../lib/xoftware.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const activeGateway = (process.env.PAYMENT_GATEWAY || 'midtrans').toLowerCase();
  const body = req.body || {};

  try {
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
