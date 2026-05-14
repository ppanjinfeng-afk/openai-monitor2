#!/usr/bin/env node

const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'db'));
const alipayPagePay = require(path.join(__dirname, '..', '..', 'services', 'alipay-page-pay'));

const DEFAULT_PUBLIC_BASE_URL = 'https://xn--2team-cd2h.com';
const DEFAULT_OLD_DOMAIN = 'penqda.com';
const DEFAULT_CURRENCY = process.env.CDK_TEAM_CURRENCY || 'CNY';
const PRODUCT_TYPE = 'team_invite';

function normalizeBaseUrl(value) {
  const baseUrl = String(value || DEFAULT_PUBLIC_BASE_URL).trim();
  return (baseUrl || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
}

function getPublicBaseUrl() {
  return normalizeBaseUrl(process.env.PUBLIC_BASE_URL);
}

function getOldDomainPattern() {
  const oldDomain = String(process.env.OLD_PAYMENT_DOMAIN || DEFAULT_OLD_DOMAIN).trim();
  return `%${oldDomain || DEFAULT_OLD_DOMAIN}%`;
}

function buildCurrentPayUrl(order) {
  const publicBaseUrl = getPublicBaseUrl();
  const itemCount = Math.max(1, Number(order.item_count || 1));
  const amountText = (Number(order.amount_cents || 0) / 100).toFixed(2);
  const subject = itemCount > 1 ? `ChatGPT Team CDK x${itemCount}` : 'ChatGPT Team CDK';

  return alipayPagePay.buildPagePayUrl({
    orderNo: order.order_no,
    amountText,
    subject,
    notifyUrl: `${publicBaseUrl}/api/payments/alipay/notify`,
    returnUrl: `${publicBaseUrl}/buy?orderNo=${encodeURIComponent(order.order_no)}&token=${encodeURIComponent(order.public_token || '')}`,
    passbackParams: order.public_token || '',
  });
}

function repairOrders() {
  const oldPattern = getOldDomainPattern();
  const orders = db.prepare(`
    SELECT *
    FROM cdk_orders
    WHERE pay_url LIKE ?
    ORDER BY datetime(created_at) DESC, id DESC
  `).all(oldPattern);

  const updatePending = db.prepare(`
    UPDATE cdk_orders
    SET pay_url = ?,
        updated_at = datetime('now')
    WHERE order_no = ?
  `);
  const clearInactive = db.prepare(`
    UPDATE cdk_orders
    SET pay_url = ''
    WHERE order_no = ?
  `);

  const summary = {
    scanned: orders.length,
    regeneratedPending: 0,
    clearedNonPending: 0,
    skipped: 0,
    publicBaseUrl: getPublicBaseUrl(),
    alipayReady: alipayPagePay.isAlipayPagePayReady(),
  };

  const run = db.transaction(() => {
    for (const order of orders) {
      const status = String(order.status || '');
      const paymentMethod = String(order.payment_method || '');
      const productType = String(order.product_type || PRODUCT_TYPE);

      if (status === 'pending' && paymentMethod === 'alipay' && productType === PRODUCT_TYPE) {
        const newPayUrl = buildCurrentPayUrl(order);
        if (!newPayUrl) {
          summary.skipped += 1;
          continue;
        }
        updatePending.run(newPayUrl, order.order_no);
        summary.regeneratedPending += 1;
        continue;
      }

      clearInactive.run(order.order_no);
      summary.clearedNonPending += 1;
    }
  });

  run();

  const remaining = db.prepare(`
    SELECT COUNT(*) AS count
    FROM cdk_orders
    WHERE pay_url LIKE ?
  `).get(oldPattern);

  summary.remainingOldPayUrls = Number(remaining?.count || 0);
  return summary;
}

const summary = repairOrders();
console.log(JSON.stringify(summary, null, 2));
