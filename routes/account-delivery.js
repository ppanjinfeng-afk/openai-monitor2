const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const alipayPagePay = require('../services/alipay-page-pay');

const router = express.Router();

const DEFAULT_CURRENCY = process.env.ACCOUNT_DELIVERY_CURRENCY || 'CNY';
const DEFAULT_PRICE_CENTS = Number.parseInt(process.env.ACCOUNT_DELIVERY_PRICE_CENTS || '500', 10) || 500;
const RESERVE_WINDOW_MINUTES = Math.max(5, Number.parseInt(process.env.ACCOUNT_DELIVERY_RESERVE_MINUTES || '30', 10) || 30);
const SUPPORTED_METHODS = new Set(['alipay', 'mock']);

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u3000/g, ' ')
    .replace(/[\uFF20\uFE6B]/g, '@')
    .replace(/[\u3002\uFF0E\uFF61\uFE52]/g, '.')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function normalizeQueryPassword(password) {
  return String(password || '').trim();
}

function isValidQueryPassword(password) {
  const value = normalizeQueryPassword(password);
  return value.length > 0 && value.length <= 128;
}

function makeOrderNo() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `ACC${stamp}${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

function makePublicToken() {
  return crypto.randomBytes(24).toString('hex');
}

function getMockPayEnabled() {
  return process.env.ENABLE_MOCK_PAY === 'true';
}

function getSettingValue(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function getPriceCents() {
  const configured = Number.parseInt(getSettingValue('account_delivery_price_cents', String(DEFAULT_PRICE_CENTS)), 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PRICE_CENTS;
}

function getPublicBaseUrl() {
  const configured = String(process.env.ACCOUNT_DELIVERY_PUBLIC_BASE_URL || '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  return 'https://business.xn--2team-cd2h.com';
}

function getPaymentQrUrl(method) {
  if (method === 'alipay' && !alipayPagePay.isAlipayPagePayReady()) {
    return process.env.ALIPAY_QR_URL || '/assets/pay/alipay-business-qr.jpg';
  }

  return '';
}

function isProviderConfigured(method, payUrl) {
  return method === 'mock' || Boolean(payUrl) || Boolean(getPaymentQrUrl(method));
}

function buildProviderPayUrl(method, order) {
  if (method === 'alipay' && alipayPagePay.isAlipayPagePayReady()) {
    const baseUrl = getPublicBaseUrl();
    return alipayPagePay.buildPagePayUrl({
      orderNo: order.order_no,
      amountText: (Number(order.amount_cents || 0) / 100).toFixed(2),
      subject: 'GPT Business 2人席位账号',
      notifyUrl: `${baseUrl}/api/account-delivery/alipay/notify`,
      returnUrl: `${baseUrl}/?orderNo=${encodeURIComponent(order.order_no)}&token=${encodeURIComponent(order.public_token || '')}`,
      passbackParams: order.public_token || '',
    });
  }

  return '';
}

function normalizeAmountCents(value) {
  if (value == null || value === '') {
    return 0;
  }

  if (typeof value === 'number' && Number.isInteger(value) && value > 100) {
    return value;
  }

  const normalized = String(value).replace(/[^\d.]/g, '').trim();
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }

  return Math.round(amount * 100);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function getSubmittedOrderToken(req) {
  return String(req.query.token || req.get('x-order-token') || '').trim();
}

function hasValidOrderToken(req, order) {
  const token = getSubmittedOrderToken(req);
  return Boolean(order?.public_token && token && safeEqual(token, order.public_token));
}

function releaseExpiredReservations() {
  const release = db.transaction(() => {
    const expired = db.prepare(`
      SELECT reserved_order_no
      FROM account_delivery_items
      WHERE status = 'reserved'
        AND reserved_until IS NOT NULL
        AND reserved_until <= datetime('now')
        AND COALESCE(reserved_order_no, '') != ''
    `).all().map(item => item.reserved_order_no).filter(Boolean);

    db.prepare(`
      UPDATE account_delivery_items
      SET status = 'available',
          reserved_order_no = '',
          reserved_until = NULL,
          updated_at = datetime('now')
      WHERE status = 'reserved'
        AND reserved_until IS NOT NULL
        AND reserved_until <= datetime('now')
    `).run();

    for (const orderNo of expired) {
      db.prepare(`
        UPDATE account_delivery_orders
        SET account_item_id = NULL,
            updated_at = datetime('now')
        WHERE order_no = ?
          AND status = 'pending'
      `).run(orderNo);
    }
  });

  release();
}

function getStats() {
  releaseExpiredReservations();
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) AS reserved,
      SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END) AS sold
    FROM account_delivery_items
  `).get();

  return {
    totalCount: Number(summary?.total || 0),
    stockCount: Number(summary?.available || 0),
    reservedCount: Number(summary?.reserved || 0),
    soldCount: Number(summary?.sold || 0),
    reserveWindowMinutes: RESERVE_WINDOW_MINUTES,
  };
}

function toPublicOrder(order, options = {}) {
  if (!order) {
    return null;
  }

  const includeToken = Boolean(options.includeToken);
  const includeAccount = Boolean(options.includeAccount);
  const amountCents = Number(order.amount_cents || 0);
  return {
    orderNo: order.order_no,
    orderToken: includeToken ? order.public_token : undefined,
    buyerEmail: order.buyer_email,
    paymentMethod: order.payment_method,
    amountCents,
    amountText: `${(amountCents / 100).toFixed(2)} ${order.currency || DEFAULT_CURRENCY}`,
    currency: order.currency || DEFAULT_CURRENCY,
    status: order.status,
    payUrl: order.pay_url || '',
    payQrUrl: getPaymentQrUrl(order.payment_method),
    accountEmail: includeAccount && order.status === 'delivered' ? order.account_email || '' : '',
    paidAmountCents: options.includeReceipt ? Number(order.paid_amount_cents || 0) : undefined,
    paidAmountText: options.includeReceipt && Number(order.paid_amount_cents || 0) > 0
      ? `${(Number(order.paid_amount_cents || 0) / 100).toFixed(2)} ${order.currency || DEFAULT_CURRENCY}`
      : '',
    payerName: options.includeReceipt ? order.payer_name || '' : undefined,
    matchStatus: options.includeReceipt ? order.match_status || '' : undefined,
    queryPassword: options.includeQueryPassword ? order.query_password || '' : undefined,
    paidAt: order.paid_at,
    deliveredAt: order.delivered_at,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

function createPendingOrder({ buyerEmail, paymentMethod, queryPassword }) {
  releaseExpiredReservations();

  const normalizedBuyerEmail = normalizeEmail(buyerEmail);
  const normalizedQueryPassword = normalizeQueryPassword(queryPassword);
  const orderNo = makeOrderNo();
  const publicToken = makePublicToken();
  const pendingOrder = {
    order_no: orderNo,
    public_token: publicToken,
    buyer_email: normalizedBuyerEmail,
    payment_method: paymentMethod,
    amount_cents: getPriceCents(),
    currency: DEFAULT_CURRENCY,
    query_password: normalizedQueryPassword,
  };
  const payUrl = paymentMethod === 'mock' ? '' : buildProviderPayUrl(paymentMethod, pendingOrder);

  const create = db.transaction(() => {
    const item = db.prepare(`
      SELECT *
      FROM account_delivery_items
      WHERE status = 'available'
      ORDER BY id ASC
      LIMIT 1
    `).get();

    if (!item) {
      const err = new Error('当前账号库存不足，请稍后再试');
      err.statusCode = 409;
      throw err;
    }

    db.prepare(`
      INSERT INTO account_delivery_orders (
        order_no,
        buyer_email,
        payment_method,
        amount_cents,
        currency,
        public_token,
        pay_url,
        query_password,
        account_item_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pendingOrder.order_no,
      pendingOrder.buyer_email,
      pendingOrder.payment_method,
      pendingOrder.amount_cents,
      pendingOrder.currency,
      pendingOrder.public_token,
      payUrl,
      pendingOrder.query_password,
      item.id
    );

    const reserved = db.prepare(`
      UPDATE account_delivery_items
      SET status = 'reserved',
          buyer_email = ?,
          reserved_order_no = ?,
          reserved_until = datetime('now', ?),
          updated_at = datetime('now')
      WHERE id = ?
        AND status = 'available'
    `).run(
      pendingOrder.buyer_email,
      pendingOrder.order_no,
      `+${RESERVE_WINDOW_MINUTES} minutes`,
      item.id
    );

    if (!reserved.changes) {
      const err = new Error('账号库存刚被占用，请重新下单');
      err.statusCode = 409;
      throw err;
    }
  });

  create();
  return db.prepare('SELECT * FROM account_delivery_orders WHERE order_no = ?').get(orderNo);
}

function deliverPaidOrder(orderNo, paymentInfo = {}) {
  releaseExpiredReservations();

  const deliver = db.transaction(() => {
    const order = db.prepare('SELECT * FROM account_delivery_orders WHERE order_no = ?').get(orderNo);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }

    if (order.status === 'delivered') {
      return order;
    }

    if (order.status !== 'pending' && order.status !== 'paid') {
      const err = new Error(`Order cannot be delivered from status ${order.status}`);
      err.statusCode = 409;
      throw err;
    }

    let item = null;
    if (Number(order.account_item_id || 0) > 0) {
      item = db.prepare(`
        SELECT *
        FROM account_delivery_items
        WHERE id = ?
          AND (
            status = 'available'
            OR (status = 'reserved' AND reserved_order_no = ?)
          )
      `).get(order.account_item_id, order.order_no);
    }

    if (!item) {
      item = db.prepare(`
        SELECT *
        FROM account_delivery_items
        WHERE status = 'available'
        ORDER BY id ASC
        LIMIT 1
      `).get();
    }

    if (!item) {
      const err = new Error('账号库存不足，无法交付');
      err.statusCode = 409;
      throw err;
    }

    const sold = db.prepare(`
      UPDATE account_delivery_items
      SET status = 'sold',
          buyer_email = ?,
          sold_order_no = ?,
          reserved_order_no = '',
          reserved_until = NULL,
          sold_at = COALESCE(sold_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
        AND (
          status = 'available'
          OR (status = 'reserved' AND reserved_order_no = ?)
        )
    `).run(order.buyer_email, order.order_no, item.id, order.order_no);

    if (!sold.changes) {
      const err = new Error('账号库存刚被售出，请重新处理订单');
      err.statusCode = 409;
      throw err;
    }

    db.prepare(`
      UPDATE account_delivery_orders
      SET status = 'delivered',
          account_item_id = ?,
          account_email = ?,
          provider_trade_no = COALESCE(NULLIF(?, ''), provider_trade_no),
          paid_amount_cents = CASE WHEN ? > 0 THEN ? ELSE paid_amount_cents END,
          payer_name = COALESCE(NULLIF(?, ''), payer_name),
          match_status = COALESCE(NULLIF(?, ''), match_status),
          receipt_raw = COALESCE(NULLIF(?, ''), receipt_raw),
          paid_at = COALESCE(paid_at, datetime('now')),
          delivered_at = COALESCE(delivered_at, datetime('now')),
          updated_at = datetime('now')
      WHERE order_no = ?
    `).run(
      item.id,
      item.email,
      paymentInfo.providerTradeNo || '',
      Number(paymentInfo.paidAmountCents || 0),
      Number(paymentInfo.paidAmountCents || 0),
      paymentInfo.payerName || '',
      paymentInfo.matchStatus || '',
      paymentInfo.receiptRaw || '',
      order.order_no
    );

    return db.prepare('SELECT * FROM account_delivery_orders WHERE order_no = ?').get(order.order_no);
  });

  return deliver();
}

function normalizeInventoryItem(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function parseInventoryItems(input) {
  const rawItems = Array.isArray(input)
    ? input
    : String(input || '').split(/\r?\n/);
  const seen = new Set();
  const items = [];

  for (const raw of rawItems) {
    const item = normalizeInventoryItem(raw);
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    items.push(item);
  }

  return items;
}

router.get('/product', (req, res) => {
  const stats = getStats();
  const amountCents = getPriceCents();
  res.json({
    productType: 'account_delivery',
    title: 'GPT Business 2人席位账号',
    amountCents,
    amountText: `${(amountCents / 100).toFixed(2)} ${DEFAULT_CURRENCY}`,
    currency: DEFAULT_CURRENCY,
    mockPayEnabled: getMockPayEnabled(),
    officialPagePayEnabled: alipayPagePay.isAlipayPagePayReady(),
    ...stats,
  });
});

router.post('/orders', (req, res) => {
  const buyerEmail = normalizeEmail(req.body.buyer_email || req.body.email);
  const queryPassword = normalizeQueryPassword(req.body.query_password || req.body.password);
  const paymentMethod = String(req.body.payment_method || req.body.method || 'alipay').toLowerCase();

  if (!isValidEmail(buyerEmail)) {
    return res.status(400).json({ error: '请输入接收邮箱' });
  }

  if (!isValidQueryPassword(queryPassword)) {
    return res.status(400).json({ error: '请设置查询密码，最多 128 个字符' });
  }

  if (!SUPPORTED_METHODS.has(paymentMethod)) {
    return res.status(400).json({ error: '不支持的支付方式' });
  }

  if (paymentMethod === 'mock' && !getMockPayEnabled()) {
    return res.status(403).json({ error: '本地模拟支付未启用' });
  }

  try {
    const order = createPendingOrder({ buyerEmail, paymentMethod, queryPassword });
    res.status(201).json({
      order: toPublicOrder(order, { includeToken: true, includeAccount: true }),
      providerConfigured: isProviderConfigured(order.payment_method, order.pay_url),
      message: '订单已创建',
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/alipay/notify', express.urlencoded({ extended: false }), (req, res) => {
  const verifyResult = alipayPagePay.verifyNotifySignature(req.body || {});
  if (!verifyResult.valid) {
    return res.status(400).type('text/plain').send('failure');
  }

  const config = verifyResult.config || alipayPagePay.getAlipayConfig();
  const appId = String(req.body.app_id || '').trim();
  const orderNo = String(req.body.out_trade_no || '').trim();
  const providerTradeNo = String(req.body.trade_no || '').trim();
  const tradeStatus = String(req.body.trade_status || '').trim().toUpperCase();
  const totalAmountCents = normalizeAmountCents(req.body.total_amount);

  if (!appId || appId !== config.appId || !orderNo || !providerTradeNo) {
    return res.status(400).type('text/plain').send('failure');
  }

  if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') {
    return res.type('text/plain').send('success');
  }

  const order = db.prepare('SELECT * FROM account_delivery_orders WHERE order_no = ?').get(orderNo);
  if (!order) {
    return res.status(404).type('text/plain').send('failure');
  }

  if (order.payment_method !== 'alipay') {
    return res.status(409).type('text/plain').send('failure');
  }

  if (totalAmountCents <= 0 || Number(order.amount_cents || 0) !== totalAmountCents) {
    return res.status(409).type('text/plain').send('failure');
  }

  const passbackParams = String(req.body.passback_params || '').trim();
  if (passbackParams && passbackParams !== String(order.public_token || '').trim()) {
    return res.status(409).type('text/plain').send('failure');
  }

  try {
    deliverPaidOrder(orderNo, {
      providerTradeNo,
      paidAmountCents: totalAmountCents,
      payerName: String(req.body.buyer_logon_id || req.body.payer_logon_id || req.body.buyer_user_id || '').trim(),
      matchStatus: 'alipay_api_notify',
      receiptRaw: JSON.stringify(req.body || {}),
    });
    return res.type('text/plain').send('success');
  } catch {
    return res.status(500).type('text/plain').send('failure');
  }
});

function getOrderForPublicStatus(req, res, orderNo) {
  const order = db.prepare('SELECT * FROM account_delivery_orders WHERE order_no = ?').get(orderNo);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  if (req.isPublicHost && !hasValidOrderToken(req, order)) {
    return res.status(404).json({ error: 'Order not found' });
  }

  res.json({ order: toPublicOrder(order, { includeAccount: true }) });
}

router.get('/orders/:orderNo', (req, res) => {
  getOrderForPublicStatus(req, res, req.params.orderNo);
});

router.get('/status/:orderNo', (req, res) => {
  getOrderForPublicStatus(req, res, req.params.orderNo);
});

router.post('/query-by-email', (req, res) => {
  const buyerEmail = normalizeEmail(req.body.buyer_email || req.body.email);
  const queryPassword = normalizeQueryPassword(req.body.query_password || req.body.password);
  if (!isValidEmail(buyerEmail)) {
    return res.status(400).json({ error: '请输入下单邮箱' });
  }

  if (!isValidQueryPassword(queryPassword)) {
    return res.status(400).json({ error: '请输入查询密码' });
  }

  const orders = db.prepare(`
    SELECT *
    FROM account_delivery_orders
    WHERE buyer_email = ?
      AND query_password = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(buyerEmail, queryPassword);

  res.json({
    orders: orders.map(order => toPublicOrder(order, {
      includeToken: true,
      includeAccount: true,
    })),
  });
});

router.post('/orders/:orderNo/mock-pay', (req, res) => {
  if (!getMockPayEnabled()) {
    return res.status(403).json({ error: '本地模拟支付未启用' });
  }

  try {
    const order = db.prepare('SELECT * FROM account_delivery_orders WHERE order_no = ?').get(req.params.orderNo);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.payment_method !== 'mock') {
      return res.status(409).json({ error: '该订单不是本地模拟支付订单' });
    }

    const delivered = deliverPaidOrder(req.params.orderNo, {
      providerTradeNo: `MOCK-${Date.now()}`,
      matchStatus: 'mock_pay',
    });

    res.json({ order: toPublicOrder(delivered, { includeAccount: true }) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/items', (req, res) => {
  releaseExpiredReservations();
  const status = String(req.query.status || 'all').trim();
  const search = String(req.query.search || '').trim();
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * limit;
  const params = {};
  const where = [];

  if (status && status !== 'all') {
    where.push('status = @status');
    params.status = status;
  }

  if (search) {
    where.push(`(
      email LIKE @search
      OR buyer_email LIKE @search
      OR sold_order_no LIKE @search
      OR reserved_order_no LIKE @search
    )`);
    params.search = `%${search}%`;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM account_delivery_items
    ${whereSql}
  `).get(params);

  const items = db.prepare(`
    SELECT *
    FROM account_delivery_items
    ${whereSql}
    ORDER BY id DESC
    LIMIT @limit
    OFFSET @offset
  `).all({ ...params, limit, offset });

  res.json({
    items,
    summary: getStats(),
    total: Number(total?.count || 0),
    page,
    limit,
  });
});

router.post('/items', (req, res) => {
  const items = parseInventoryItems(req.body.items || req.body.emails || req.body.email || '');
  if (!items.length) {
    return res.status(400).json({ error: '请输入要添加的账号内容' });
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO account_delivery_items (email, status)
    VALUES (?, 'available')
  `);
  let inserted = 0;
  const skipped = [];
  const insertAll = db.transaction(() => {
    for (const item of items) {
      const result = insert.run(item);
      if (result.changes) {
        inserted += 1;
      } else {
        skipped.push(item);
      }
    }
  });
  insertAll();

  res.status(201).json({
    message: `已添加 ${inserted} 个账号${skipped.length ? `，跳过 ${skipped.length} 个重复邮箱` : ''}`,
    inserted,
    skipped,
    summary: getStats(),
  });
});

router.delete('/items/:id(\\d+)', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const item = db.prepare('SELECT * FROM account_delivery_items WHERE id = ?').get(id);
  if (!item) {
    return res.status(404).json({ error: '记录不存在' });
  }

  const remove = db.transaction(() => {
    if (item.status === 'reserved' && item.reserved_order_no) {
      db.prepare(`
        UPDATE account_delivery_orders
        SET status = 'failed',
            account_item_id = NULL,
            updated_at = datetime('now')
        WHERE order_no = ?
          AND status = 'pending'
      `).run(item.reserved_order_no);
    }

    return db.prepare('DELETE FROM account_delivery_items WHERE id = ?').run(id);
  });

  const result = remove();
  res.json({
    message: '已删除',
    deleted: result.changes,
    summary: getStats(),
  });
});

router.get('/orders', (req, res) => {
  releaseExpiredReservations();
  const status = String(req.query.status || 'all').trim();
  const search = String(req.query.search || '').trim();
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * limit;
  const params = {};
  const where = [];

  if (status && status !== 'all') {
    where.push('status = @status');
    params.status = status;
  }

  if (search) {
    where.push(`(
      order_no LIKE @search
      OR buyer_email LIKE @search
      OR account_email LIKE @search
      OR provider_trade_no LIKE @search
    )`);
    params.search = `%${search}%`;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM account_delivery_orders
    ${whereSql}
  `).get(params);

  const orders = db.prepare(`
    SELECT *
    FROM account_delivery_orders
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT @limit
    OFFSET @offset
  `).all({ ...params, limit, offset });

  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM account_delivery_orders
  `).get();

  res.json({
    orders: orders.map(order => toPublicOrder(order, {
      includeAccount: true,
      includeReceipt: true,
      includeQueryPassword: true,
    })),
    summary,
    total: Number(total?.count || 0),
    page,
    limit,
  });
});

router.post('/orders/:orderNo/manual-deliver', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM account_delivery_orders WHERE order_no = ?').get(req.params.orderNo);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.payment_method !== 'alipay') {
      return res.status(409).json({ error: '只有支付宝订单需要人工确认收款' });
    }

    const delivered = deliverPaidOrder(req.params.orderNo, {
      providerTradeNo: req.body.provider_trade_no || `MANUAL-${Date.now()}`,
      matchStatus: 'manual_deliver',
    });

    res.json({ order: toPublicOrder(delivered, { includeAccount: true }) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
