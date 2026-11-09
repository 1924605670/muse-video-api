/**
 * 账单（Payment-Needed）生成 — Muse 视频体验
 * 结构遵循支付宝 AI 按量付费官方契约（与 talkshow-audit 同源）：
 * Payment-Needed 为 Base64URL 编码的 JSON，必须包含 protocol 与 method 两部分。
 */

'use strict';

const crypto = require('node:crypto');

const SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
const SANDBOX_SERVICE_ID = 'api_mock_service_id';

function config() {
  return {
    mode: process.env.AIPAY_MODE || 'sandbox',
    appId: process.env.AIPAY_APP_ID || '',
    privateKey: process.env.AIPAY_PRIVATE_KEY || '',
    sellerId: process.env.AIPAY_SELLER_ID || '2088SANDBOX',
    serviceId: process.env.AIPAY_SERVICE_ID || SANDBOX_SERVICE_ID,
    gateway: process.env.AIPAY_GATEWAY || SANDBOX_GATEWAY,
    priceCny: Number(process.env.PRICE_CNY || 0.5),
    sellerName: process.env.AIPAY_SELLER_NAME || 'Muse 视频体验',
    merchant: 'skillhub-user_e5c819c8',
    product: 'Muse 视频体验（10秒竖屏）',
    resourcePrefix: 'muse-video',
  };
}

function base64UrlEncode(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

/** ISO 8601 带时区偏移（支付宝 pay_before 格式），如 2026-11-09T10:45:00+08:00 */
function formatISO8601WithTimezone(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
}

/**
 * 商家账单签名（RSA2）：字段按 key 字典序拼接后用商户私钥签名。
 * 无私钥时（沙箱默认）返回占位值 SANDBOX-UNSIGNED——沙箱不校验签名，
 * 生产必须配置 AIPAY_PRIVATE_KEY，否则账单不可用。
 */
function generateSellerSignature(params, privateKey) {
  if (!privateKey) return 'SANDBOX-UNSIGNED';
  const keys = Object.keys(params).sort();
  const signContent = keys
    .filter((k) => params[k] !== null && params[k] !== '')
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  try {
    let keyObj;
    const trimmed = privateKey.trim();
    if (trimmed.startsWith('-----BEGIN')) {
      keyObj = crypto.createPrivateKey(trimmed);
    } else {
      // 裸 PKCS#1 Base64
      keyObj = crypto.createPrivateKey({
        key: Buffer.from(trimmed, 'base64'),
        format: 'der',
        type: 'pkcs1',
      });
    }
    return crypto.createSign('RSA-SHA256').update(signContent, 'utf8').sign(keyObj, 'base64');
  } catch (e) {
    throw new Error(`账单签名失败：${e.message}`);
  }
}

/**
 * 生成一笔待支付订单 + 账单。
 * @returns {{ bill, order }} bill 为放入 Payment-Needed 的完整 JSON；order 为本地待持久化订单
 */
function createBill() {
  const cfg = config();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 分钟
  const outTradeNo = `MV${Date.now()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const resourceId = `${cfg.resourcePrefix}:${crypto.randomUUID()}`;
  const amount = cfg.priceCny.toFixed(2);
  const payBefore = formatISO8601WithTimezone(expiresAt);

  const signParams = {
    amount,
    currency: 'CNY',
    goods_name: cfg.product,
    out_trade_no: outTradeNo,
    pay_before: payBefore,
    resource_id: resourceId,
    seller_id: cfg.sellerId,
    service_id: cfg.serviceId,
  };
  const sellerSignature = generateSellerSignature(signParams, cfg.privateKey);

  const bill = {
    // 简化字段（便于客户端直接读取）
    amount_cny: cfg.priceCny,
    currency: 'CNY',
    product: cfg.product,
    resource_id: resourceId,
    expires_at: expiresAt.toISOString(),
    merchant: cfg.merchant,
    out_trade_no: outTradeNo,
    // 官方 A2M 契约字段
    protocol: {
      out_trade_no: outTradeNo,
      amount,
      currency: 'CNY',
      resource_id: resourceId,
      pay_before: payBefore,
      seller_signature: sellerSignature,
      seller_sign_type: 'RSA2',
      seller_unique_id: cfg.sellerId,
    },
    method: {
      seller_name: cfg.sellerName,
      seller_id: cfg.sellerId,
      seller_app_id: cfg.appId,
      goods_name: cfg.product,
      seller_unique_id_key: 'seller_id',
      service_id: cfg.serviceId,
    },
  };

  const order = {
    outTradeNo,
    amount,
    currency: 'CNY',
    resourceId,
    goodsName: cfg.product,
    payBefore,
    expiresAt: expiresAt.toISOString(),
    orderStatus: 'PENDING_PAYMENT',
    fulfillStatus: 'UNFULFILLED',
    createdAt: now.toISOString(),
  };

  return { bill, order };
}

/** amtPaymentLink 兼容头：携带同一 resource_id 的支付链接（占位格式，真实支付链接由智能体客户端据 Payment-Needed 账单发起）。 */
function paymentLinkFor(resourceId, outTradeNo) {
  return `https://aipay.alipay.com/pay?resource_id=${resourceId}&out_trade_no=${encodeURIComponent(outTradeNo)}`;
}

module.exports = {
  config,
  createBill,
  paymentLinkFor,
  base64UrlEncode,
  base64UrlDecode,
  formatISO8601WithTimezone,
  SANDBOX_GATEWAY,
  SANDBOX_SERVICE_ID,
};
