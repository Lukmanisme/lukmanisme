// lib/xoftware.js
// Utility SDK helper for Xoftware Pay (https://pay.xoftware.id)
import crypto from 'crypto';

const XOFTWARE_BASE_URL = process.env.XOFTWARE_BASE_URL || 'https://payment.xoftware.id';

/**
 * Generate HMAC-SHA256 signature for outbound Merchant API requests
 * Message format: TIMESTAMP + "\n" + HTTP_METHOD + "\n" + REQUEST_PATH + "\n" + RAW_JSON_BODY
 */
export function generateSignature(apiKey, timestamp, method, path, body) {
  const rawBody = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
  const message = `${timestamp}\n${method.toUpperCase()}\n${path}\n${rawBody}`;

  return crypto
    .createHmac('sha256', apiKey)
    .update(message, 'utf8')
    .digest('base64');
}

/**
 * Verify inbound webhook signature from Xoftware Pay
 * Hex-encoded HMAC-SHA256 of the raw body using WEBHOOK_SECRET
 */
export function verifyWebhookSignature(webhookSecret, rawBody, receivedSignature) {
  if (!webhookSecret || !receivedSignature) return false;

  const payload = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
  const calculated = crypto
    .createHmac('sha256', webhookSecret)
    .update(payload, 'utf8')
    .digest('hex');

  return calculated.toLowerCase() === receivedSignature.toLowerCase();
}

/**
 * Create a transaction on Xoftware Pay (QRIS or Virtual Account)
 */
export async function createXoftwareTransaction({
  orderId,
  amount,
  storeName,
  customerEmail,
  phone = '',
  channelCode = 'QRIS',
  notifyUrl,
  returnUrl
}) {
  const apiKey = (process.env.XOFTWARE_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  const merchantId = Number(String(process.env.XOFTWARE_MERCHANT_ID || '').trim().replace(/^["']|["']$/g, ''));
  const baseUrl = (process.env.XOFTWARE_BASE_URL || 'https://payment.xoftware.id').trim().replace(/\/+$/, '');

  if (!apiKey || !merchantId) {
    throw new Error('XOFTWARE_API_KEY or XOFTWARE_MERCHANT_ID is not configured');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const path = '/v1/api/transactions';
  const method = 'POST';

  const payload = {
    merchant_id: merchantId,
    channel_code: channelCode,
    amount: Math.round(Number(amount)),
    ref_id: orderId,
    fee_direction: 'merchant',
    notify_url: notifyUrl || `${process.env.APP_URL || 'https://lukmanisme.vercel.app'}/api/xoftware/webhook`,
    return_url: returnUrl || `${process.env.APP_URL || 'https://lukmanisme.vercel.app'}/balanjo/success.html`,
    expires_in_minutes: 60,
    note: `Langganan Kasir Balanjo POS - ${storeName || 'Toko'}`,
    metadata: {
      customer: {
        id: customerEmail,
        name: storeName || 'Pelanggan Kasir',
        email: customerEmail,
        phone: phone || ''
      },
      products: [
        {
          product_code: 'BALANJO-POS-SUB',
          product_name: 'Langganan Balanjo POS'
        }
      ]
    }
  };

  const rawBody = JSON.stringify(payload);
  const signature = generateSignature(apiKey, timestamp, method, path, rawBody);

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      'X-Timestamp': timestamp.toString(),
      'X-Signature': signature
    },
    body: rawBody
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.message || `Xoftware error HTTP ${res.status}`);
  }

  return data;
}

/**
 * Check transaction status on Xoftware Pay
 */
export async function checkXoftwareStatus(refId) {
  const apiKey = process.env.XOFTWARE_API_KEY;
  if (!apiKey) throw new Error('XOFTWARE_API_KEY is not configured');

  const timestamp = Math.floor(Date.now() / 1000);
  const path = '/v1/api/transactions/status';
  const method = 'POST';
  const payload = { ref_id: refId };

  const signature = generateSignature(apiKey, timestamp, method, path, payload);

  const res = await fetch(`${XOFTWARE_BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      'X-Timestamp': timestamp.toString(),
      'X-Signature': signature
    },
    body: JSON.stringify(payload)
  });

  return await res.json();
}
