// api/midtrans/webhook.js
// Vercel Serverless Function to handle Midtrans Payment Notifications (Webhook)
import crypto from 'crypto';

export default async function handler(req, res) {
  // CORS & Methods
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Handle health check / GET / HEAD from monitoring tools or Midtrans URL validation
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.status(200).json({
      status: 'ok',
      message: 'Midtrans Payment Notification Webhook is active and listening.'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const notification = req.body || {};

    // 1. Handle Midtrans Dashboard "Test Notification URL" ping
    // Midtrans test pings often send minimal or dummy payloads to verify HTTP 200 response
    const isTestPing =
      !notification ||
      Object.keys(notification).length === 0 ||
      notification.test === true ||
      (notification.order_id && notification.order_id.toLowerCase().includes('test')) ||
      !notification.signature_key;

    if (isTestPing) {
      console.log('[Midtrans Webhook] Test notification ping acknowledged:', notification);
      return res.status(200).json({
        status: 'ok',
        message: 'Test notification acknowledged successfully'
      });
    }

    const {
      order_id,
      status_code,
      gross_amount,
      signature_key,
      transaction_status,
      fraud_status,
      payment_type,
      custom_field1, // tenant_id
      custom_field2, // plan
      custom_field3  // store_name
    } = notification;

    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    if (!serverKey) {
      console.warn('[Midtrans Webhook] MIDTRANS_SERVER_KEY is not set in environment yet.');
      return res.status(200).json({
        status: 'ok',
        warning: 'Webhook reachable, but MIDTRANS_SERVER_KEY is pending in Vercel environment'
      });
    }

    // 2. Verify Midtrans SHA512 Signature
    // Format: SHA512(order_id + status_code + gross_amount + ServerKey)
    const rawSignatureString = `${order_id}${status_code}${gross_amount}${serverKey}`;
    const calculatedSignature = crypto
      .createHash('sha512')
      .update(rawSignatureString)
      .digest('hex');

    if (calculatedSignature !== signature_key) {
      console.warn('Invalid signature received for order:', order_id);
      // Still return 200 so Midtrans retry loop does not hammer the server, but log warning
      return res.status(200).json({
        status: 'ignored',
        message: 'Signature mismatch'
      });
    }

    console.log(`[Midtrans Webhook] Verified Order: ${order_id}, Status: ${transaction_status}, Fraud: ${fraud_status}, Type: ${payment_type}`);

    // 3. Check if payment is successful
    const isPaid =
      transaction_status === 'settlement' ||
      (transaction_status === 'capture' && fraud_status === 'accept');

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey || serviceRoleKey.includes('your_supabase')) {
      console.warn('Supabase service credentials not configured. Skipping DB update.');
      return res.status(200).json({
        status: 'ok',
        note: 'Signature valid, but Supabase service role key is not configured yet.'
      });
    }

    const headers = {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    };

    let tenantId = custom_field1;
    let plan = custom_field2 || '1m';
    const customerEmail = custom_field3 || (notification.customer_details && notification.customer_details.email) || '';

    // If tenantId was not in custom_field1, attempt lookup from profiles by email!
    if (!tenantId && customerEmail) {
      try {
        const profRes = await fetch(
          `${supabaseUrl}/rest/v1/profiles?email=eq.${encodeURIComponent(customerEmail)}&select=id,tenant_id,name&limit=1`,
          { headers }
        );
        if (profRes.ok) {
          const profData = await profRes.json();
          if (profData && profData.length > 0 && profData[0].tenant_id) {
            tenantId = profData[0].tenant_id;
            console.log(`[Midtrans Webhook] Linked tenant ${tenantId} via profile email ${customerEmail}`);
          }
        }
      } catch (profErr) {
        console.warn('Error querying profile by email:', profErr.message);
      }
    }

    // Fallback: lookup from payment_requests by order_id
    if (!tenantId) {
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
        console.warn('Error querying payment_requests for order:', findErr.message);
      }
    }

    // If user paid on web before creating an account, pre-create tenant so it is ready upon signup!
    if (!tenantId && customerEmail && isPaid) {
      try {
        const newTenantId = crypto.randomUUID();
        const tenantCode = 'T' + newTenantId.replace(/-/g, '').substring(0, 9).toUpperCase();
        const storeName = notification.customer_details?.first_name || customerEmail.split('@')[0];

        const tRes = await fetch(`${supabaseUrl}/rest/v1/tenants`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({
            id: newTenantId,
            code: tenantCode,
            name: storeName,
            owner_name: storeName,
            owner_phone: notification.customer_details?.phone || '',
            admin_wa: customerEmail,
            is_active: true
          })
        });

        if (tRes.ok) {
          tenantId = newTenantId;
          console.log(`[Midtrans Webhook] Auto-created tenant ${tenantId} (${tenantCode}) for email ${customerEmail}`);
        }
      } catch (tErr) {
        console.warn('Error auto-creating tenant for email:', tErr.message);
      }
    }

    if (isPaid) {
      // Calculate duration days based on package
      const DAYS_MAP = {
        '1m': 30,
        '3m': 90,
        '12m': 365
      };
      const daysToAdd = DAYS_MAP[plan] || 30;

      if (tenantId) {
        // Query latest subscription for this tenant
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

            // If current subscription is still valid in the future, extend from expire_date
            if (currentExpire >= today) {
              currentExpire.setDate(currentExpire.getDate() + daysToAdd);
              newExpireDate = currentExpire.toISOString().slice(0, 10);
            } else {
              // Expired already: extend from today
              const ext = new Date(today);
              ext.setDate(ext.getDate() + daysToAdd);
              newExpireDate = ext.toISOString().slice(0, 10);
            }

            // Update existing subscription
            await fetch(
              `${supabaseUrl}/rest/v1/subscriptions?id=eq.${currentSub.id}`,
              {
                method: 'PATCH',
                headers: { ...headers, Prefer: 'return=minimal' },
                body: JSON.stringify({
                  plan: plan,
                  expire_date: newExpireDate,
                  status: 'active'
                })
              }
            );
          }
        }

        // If no subscription existed, insert a new one
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
        }

        // Record approved payment request
        await fetch(`${supabaseUrl}/rest/v1/payment_requests`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({
            tenant_id: tenantId,
            plan: plan,
            amount: Math.round(Number(gross_amount)),
            bank_name: `Midtrans (${payment_type || 'auto'})`,
            account_name: `Order: ${order_id}`,
            wa_proof_sent: false,
            status: 'approved',
            reviewed_by: 'Midtrans Webhook',
            reviewed_at: new Date().toISOString()
          })
        });

        console.log(`[Midtrans Webhook] Successfully updated subscription for tenant ${tenantId} to ${newExpireDate}`);
      } else {
        console.warn(`[Midtrans Webhook] Order ${order_id} is paid, but tenant_id is unknown.`);
      }
    } else if (transaction_status === 'expire' || transaction_status === 'cancel' || transaction_status === 'deny') {
      // Payment failed/expired
      if (tenantId) {
        await fetch(
          `${supabaseUrl}/rest/v1/payment_requests?rejection_reason=eq.${encodeURIComponent(order_id)}`,
          {
            method: 'PATCH',
            headers: { ...headers, Prefer: 'return=minimal' },
            body: JSON.stringify({
              status: 'rejected',
              rejection_reason: `Midtrans status: ${transaction_status}`
            })
          }
        );
      }
    }

    return res.status(200).json({ status: 'ok', transaction_status });
  } catch (err) {
    console.error('[Midtrans Webhook] Error processing webhook:', err);
    // Respond with 200 OK so Midtrans does not flag error
    return res.status(200).json({ status: 'error_caught', error: err.message });
  }
}
