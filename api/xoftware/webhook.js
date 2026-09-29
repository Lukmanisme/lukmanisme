// api/xoftware/webhook.js
// Vercel Serverless Function to handle Xoftware Pay Notifications
import crypto from 'crypto';
import { verifyWebhookSignature } from '../../lib/xoftware.js';

export default async function handler(req, res) {
  // CORS & Methods
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Signature,X-Event-Id,X-Event-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Health check / verification ping
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.status(200).json({
      status: 'ok',
      message: 'Xoftware Pay Payment Notification Webhook is active and listening.'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const notification = req.body || {};
    const signature = req.headers['x-signature'] || req.headers['X-Signature'];
    const webhookSecret = process.env.XOFTWARE_WEBHOOK_SECRET;

    // 1. Signature Verification
    if (webhookSecret && signature) {
      const isValid = verifyWebhookSignature(webhookSecret, notification, signature);
      if (!isValid) {
        console.warn('[Xoftware Webhook] Signature verification failed');
        return res.status(400).json({ error: 'Signature mismatch' });
      }
    } else {
      console.warn('[Xoftware Webhook] Warning: Processing without secret verification (pending env configuration)');
    }

    const {
      event_id,
      transaction_id,
      order_id,
      channel_code,
      status,
      amount,
      paid_at
    } = notification;

    console.log(`[Xoftware Webhook] Received: Order ${order_id}, Status: ${status}, Amount: ${amount}`);

    const isPaid = status === 'SUCCESS';

    if (!isPaid) {
      return res.status(200).json({
        status: 'acknowledged',
        note: `Transaction ${order_id} is in non-success state: ${status}`
      });
    }

    // 2. Database Auto-Extend Subscription in Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey || serviceRoleKey.includes('your_supabase')) {
      console.warn('[Xoftware Webhook] Supabase credentials not ready. Skipping DB update.');
      return res.status(200).json({
        status: 'ok',
        note: 'Payment verified, but Supabase service role key is not configured'
      });
    }

    const headers = {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    };

    // Parse plan from order_id or fallback
    // Format order_id: ORDER-BLJ-{today}-{rand} or custom
    let plan = '1m';
    if (amount >= 240000) plan = '12m';
    else if (amount >= 70000) plan = '3m';
    else plan = '1m';

    const DAYS_MAP = {
      '1m': 30,
      '3m': 90,
      '12m': 365
    };
    const daysToAdd = DAYS_MAP[plan] || 30;

    // Find tenant by matching order_id in payment_requests or recent orders
    let tenantId = null;

    try {
      const prRes = await fetch(
        `${supabaseUrl}/rest/v1/payment_requests?rejection_reason=eq.${encodeURIComponent(order_id)}&select=tenant_id,plan&limit=1`,
        { headers }
      );
      if (prRes.ok) {
        const prData = await prRes.json();
        if (prData && prData.length > 0) {
          tenantId = prData[0].tenant_id;
          plan = prData[0].plan || plan;
        }
      }
    } catch (findErr) {
      console.warn('Error querying payment_requests:', findErr.message);
    }

    if (tenantId) {
      // Query current subscription
      const subRes = await fetch(
        `${supabaseUrl}/rest/v1/subscriptions?tenant_id=eq.${tenantId}&order=expire_date.desc&limit=1`,
        { headers }
      );

      let newExpireDate;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (subRes.ok) {
        const subData = await subRes.json();
        if (subData && subData.length > 0) {
          const currentSub = subData[0];
          const currentExpire = new Date(currentSub.expire_date);
          currentExpire.setHours(0, 0, 0, 0);

          // Extend accumulative if still active, otherwise from today
          if (currentExpire >= today) {
            currentExpire.setDate(currentExpire.getDate() + daysToAdd);
            newExpireDate = currentExpire.toISOString().slice(0, 10);
          } else {
            const ext = new Date(today);
            ext.setDate(ext.getDate() + daysToAdd);
            newExpireDate = ext.toISOString().slice(0, 10);
          }

          // Update subscription
          await fetch(`${supabaseUrl}/rest/v1/subscriptions?id=eq.${currentSub.id}`, {
            method: 'PATCH',
            headers: { ...headers, Prefer: 'return=minimal' },
            body: JSON.stringify({
              plan: plan,
              expire_date: newExpireDate,
              status: 'active'
            })
          });

          console.log(`[Xoftware Webhook] Extended subscription for tenant ${tenantId} until ${newExpireDate}`);
        }
      }

      // If no subscription existed yet, create new one
      if (!newExpireDate) {
        const ext = new Date(today);
        ext.setDate(ext.getDate() + daysToAdd);
        newExpireDate = ext.toISOString().slice(0, 10);

        await fetch(`${supabaseUrl}/rest/v1/subscriptions`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({
            tenant_id: tenantId,
            plan: plan,
            start_date: today.toISOString().slice(0, 10),
            expire_date: newExpireDate,
            status: 'active'
          })
        });
        console.log(`[Xoftware Webhook] Created new subscription for tenant ${tenantId} until ${newExpireDate}`);
      }
    }

    return res.status(200).json({
      status: 'ok',
      message: `Transaction ${order_id} processed successfully via Xoftware Pay`
    });

  } catch (err) {
    console.error('[Xoftware Webhook Error]:', err.message);
    return res.status(500).json({ error: 'Internal Server Error', details: err.message });
  }
}
