require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { initializeTransaction, verifyTransaction, verifyWebhookSignature, IS_DEMO_MODE } = require('./services/paystack');
const { syncToGoogleSheet, getStoredRecords } = require('./services/googleSheets');
const { dispatchNotifications } = require('./services/notifications');

const app = express();

// Enable CORS
app.use(cors());

// Capture raw body for Paystack webhook signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Serve static assets from public
app.use(express.static(path.join(__dirname, '..', 'public')));

// In-memory status tracker for real-time customer polling
const activeOrderStatuses = new Map();

// Helper: Sync to Supabase skincare_orders table
async function syncToSupabase(orderData) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { synced: false, reason: 'Supabase credentials not configured' };
  }

  try {
    const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/skincare_orders`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        reference: orderData.reference,
        security_pin: orderData.securityPin,
        seal_number: orderData.sealNumber,
        courier_name: orderData.courierName,
        customer_name: orderData.customerName,
        customer_phone: orderData.customerPhone,
        customer_email: orderData.customerEmail,
        fulfillment_type: orderData.fulfillmentType,
        shipping_zone: orderData.shippingZone,
        delivery_address: orderData.address,
        items: orderData.items,
        items_summary: orderData.itemsSummary,
        subtotal: orderData.subtotal,
        shipping_fee: orderData.shippingFee,
        total_amount: orderData.amount,
        payment_status: orderData.paymentStatus,
        status: orderData.status,
        notes: orderData.notes
      })
    });

    if (response.ok) {
      const data = await response.json();
      console.log('[Supabase] Skincare Order stored successfully:', orderData.reference);
      return { synced: true, data };
    } else {
      const errText = await response.text();
      console.warn('[Supabase Sync Warning]:', response.status, errText);
      return { synced: false, error: errText };
    }
  } catch (err) {
    console.warn('[Supabase Exception]:', err.message);
    return { synced: false, error: err.message };
  }
}

// 1. Health Endpoint
app.get(['/api/health', '/health'], (req, res) => {
  res.json({
    status: 'online',
    brand: 'GlowCraft Organics • Handcrafted Botanicals',
    timestamp: new Date().toISOString(),
    demoMode: IS_DEMO_MODE,
    hasGoogleSheetWebhook: !!process.env.GOOGLE_SHEET_WEBHOOK_URL,
    hasSupabase: !!process.env.SUPABASE_URL,
    hasTelegram: !!process.env.TELEGRAM_BOT_TOKEN
  });
});

// 2. Skincare Order Creation Endpoint
app.post(['/api/orders/create', '/orders/create'], async (req, res) => {
  try {
    const {
      customerName,
      customerPhone,
      customerEmail,
      fulfillmentType,
      address,
      shippingZone,
      items,
      subtotal,
      shippingFee,
      totalAmount,
      notes,
      reference
    } = req.body;

    if (!customerName || !customerPhone || !items || !items.length) {
      return res.status(400).json({ error: 'Missing required order details or empty bag.' });
    }

    const itemsSummary = items
      .map(it => `• ${it.quantity}x ${it.name} ${it.variant ? `(${it.variant})` : ''} - ₦${(it.price * it.quantity).toLocaleString()}`)
      .join('\n');

    const finalRef = reference || `GLOW_${Date.now()}`;
    const securityPin = Math.floor(1000 + Math.random() * 9000).toString();
    const sealNumber = `SEAL-BOTANICAL-${Math.floor(1000 + Math.random() * 9000)}`;

    const orderPayload = {
      type: 'SKINCARE_ORDER',
      reference: finalRef,
      securityPin,
      sealNumber,
      courierName: 'GlowCraft Direct Courier (Osogbo) / GIG Waybill',
      customerName,
      customerPhone,
      customerEmail: customerEmail || '',
      fulfillmentType: fulfillmentType || 'DELIVERY',
      shippingZone: shippingZone || 'Zone 1: Osogbo Metro (Same-Day Doorstep)',
      address: fulfillmentType === 'PICKUP' ? 'GlowCraft Apothecary Pickup' : (address || 'Address provided'),
      items,
      itemsSummary,
      subtotal: Number(subtotal) || Number(totalAmount),
      shippingFee: Number(shippingFee) || 0,
      amount: Number(totalAmount) || 0,
      paymentStatus: 'PAID',
      status: 'FORMULATING', // Initial apothecary state
      notes: notes || '',
      createdAt: new Date().toISOString()
    };

    activeOrderStatuses.set(finalRef, {
      ...orderPayload,
      status: 'FORMULATING',
      updatedAt: new Date().toISOString()
    });

    // Parallel sync to Google Sheets, Supabase, and Notifications
    const [sheetSync] = await Promise.all([
      syncToGoogleSheet(orderPayload),
      syncToSupabase(orderPayload),
      dispatchNotifications('SKINCARE_ORDER', orderPayload).catch(e => console.warn('[Notification Error]:', e.message))
    ]);

    res.json({
      success: true,
      message: 'Apothecary batch order confirmed and logged.',
      order: orderPayload,
      sheetSync
    });
  } catch (error) {
    console.error('[API] Skincare Order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Live Order & Waybill Tracking Endpoint
app.get(['/api/orders/track/:ref', '/orders/track/:ref'], async (req, res) => {
  try {
    const { ref } = req.params;
    if (!ref) {
      return res.status(400).json({ error: 'Missing order reference' });
    }

    // 1. In-memory check
    if (activeOrderStatuses.has(ref)) {
      return res.json({
        success: true,
        order: activeOrderStatuses.get(ref)
      });
    }

    // 2. Supabase check
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
      try {
        const queryUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/skincare_orders?reference=eq.${encodeURIComponent(ref)}&select=*`;
        const sbRes = await fetch(queryUrl, {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          }
        });
        if (sbRes.ok) {
          const rows = await sbRes.json();
          if (rows && rows.length > 0) {
            const r = rows[0];
            const fallbackPin = (Math.abs(ref.split('').reduce((acc, c) => acc + c.charCodeAt(0), 1000)) % 9000 + 1000).toString();
            const orderData = {
              reference: r.reference,
              securityPin: r.security_pin || fallbackPin,
              sealNumber: r.seal_number || `SEAL-BOTANICAL-${fallbackPin}`,
              courierName: r.courier_name || 'GlowCraft Direct Courier (Osogbo)',
              customerName: r.customer_name,
              customerPhone: r.customer_phone,
              fulfillmentType: r.fulfillment_type,
              shippingZone: r.shipping_zone,
              address: r.delivery_address,
              items: r.items,
              itemsSummary: r.items_summary,
              amount: r.total_amount,
              paymentStatus: r.payment_status,
              status: r.status || 'FORMULATING',
              createdAt: r.created_at
            };
            activeOrderStatuses.set(ref, orderData);
            return res.json({ success: true, order: orderData });
          }
        }
      } catch (err) {
        console.warn('[Tracking Supabase]', err.message);
      }
    }

    // 3. Local records check
    const { orders } = getStoredRecords();
    const local = orders.find(o => o.reference === ref);
    if (local) {
      return res.json({
        success: true,
        order: {
          ...local,
          status: 'FORMULATING'
        }
      });
    }

    // 4. Default simulated demo tracker
    const demoPin = (Math.abs(ref.split('').reduce((acc, c) => acc + c.charCodeAt(0), 1000)) % 9000 + 1000).toString();
    res.json({
      success: true,
      simulated: true,
      order: {
        reference: ref,
        securityPin: demoPin,
        sealNumber: `SEAL-BOTANICAL-${demoPin}`,
        customerName: 'Amina Adeleke',
        customerPhone: '08149640122',
        fulfillmentType: 'DELIVERY',
        shippingZone: 'Zone 1: Osogbo Metro (Same-Day Doorstep)',
        address: 'Plot 14, Ring Road GRA, Osogbo',
        items: [
          { name: 'Whipped Vanilla Shea Butter (250g)', quantity: 1, price: 6500 },
          { name: 'Turmeric & Kojic Brightening Body Polish', quantity: 1, price: 5800 }
        ],
        amount: 13300,
        paymentStatus: 'PAID',
        status: 'DISPATCHED',
        courierName: 'Ibrahim K. (GlowCraft Express #02)',
        courierPhone: '08149640122',
        estimatedTime: 'Delivering this afternoon (2:00 PM – 4:00 PM)',
        createdAt: new Date(Date.now() - 40 * 60 * 1000).toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Vendor Status Update Endpoint (FORMULATING -> PACKAGED -> DISPATCHED -> DELIVERED)
app.post(['/api/orders/status', '/orders/status'], async (req, res) => {
  try {
    const { reference, status } = req.body;
    if (!reference || !status) {
      return res.status(400).json({ error: 'Missing reference or status' });
    }

    const current = activeOrderStatuses.get(reference) || { reference };
    current.status = status;
    current.updatedAt = new Date().toISOString();
    activeOrderStatuses.set(reference, current);

    // Update in Supabase if connected
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
      try {
        const updateUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/skincare_orders?reference=eq.${encodeURIComponent(reference)}`;
        await fetch(updateUrl, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          },
          body: JSON.stringify({ status, updated_at: new Date().toISOString() })
        });
      } catch (e) {
        console.warn('[Supabase Status Update]', e.message);
      }
    }

    res.json({ success: true, reference, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Admin Data Records
app.get(['/api/records', '/records'], (req, res) => {
  const records = getStoredRecords();
  const inMemoryOrders = Array.from(activeOrderStatuses.values());
  const combined = inMemoryOrders.length ? inMemoryOrders : (records.orders || []);
  res.json({
    orders: combined,
    count: combined.length
  });
});

// 6. Clean Page Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/shop', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'shop.html')));
app.get('/routine', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'routine.html')));
app.get(['/order', '/checkout'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'order.html')));
app.get('/track', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'track.html')));
app.get(['/story', '/about'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'story.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));

module.exports = app;
