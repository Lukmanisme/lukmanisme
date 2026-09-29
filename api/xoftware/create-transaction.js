// api/xoftware/create-transaction.js
// Vercel Serverless Function to initiate transactions on Xoftware Pay
import { createXoftwareTransaction } from '../../lib/xoftware.js';

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      order_id,
      plan,
      amount,
      store_name,
      customer_email,
      customer_phone,
      tenant_id,
      channel_code = 'QRIS'
    } = req.body || {};

    if (!order_id || !amount || !customer_email) {
      return res.status(400).json({
        error: 'Missing required parameters: order_id, amount, customer_email are mandatory'
      });
    }

    // Call Xoftware Pay API
    const response = await createXoftwareTransaction({
      orderId: order_id,
      amount: Number(amount),
      storeName: store_name || 'Toko Pelanggan',
      customerEmail: customer_email,
      phone: customer_phone || '',
      channelCode: channel_code
    });

    // The data contains: transaction_id, qris_text, expires_at, fee_preview, etc.
    const trxData = response.data || response;

    return res.status(200).json({
      status: 'success',
      provider: 'xoftware',
      order_id,
      transaction_id: trxData.transaction_id,
      channel_code: trxData.channel_code || channel_code,
      qris_text: trxData.qris_text || '',
      amount: trxData.amount || amount,
      expires_at: trxData.expires_at,
      payment_url: trxData.url || ''
    });

  } catch (err) {
    console.error('[Xoftware Create Transaction Error]:', err.message);
    return res.status(500).json({
      error: 'Failed to initiate Xoftware transaction',
      details: err.message
    });
  }
}
