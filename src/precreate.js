/**
 * 按量付费预下单 — Muse 视频体验
 * 导出 createPrePayOrder(order)
 *
 * 官方流程（支付宝 AI 按量付费接入指南）：
 *   商家在返回 402 之前，先调用 alipay.aipay.agent.payment.precreate，
 *   由支付宝创建预下单并返回 amt_pre_pay_id；再把该预下单号通过
 *   amtPaymentLink 响应头传给调用方，同时返回 HTTP 402。
 *   amtPaymentLink 的值就是 amt_pre_pay_id 本身，不是一个 URL。
 *
 * 历史教训：此前 amtPaymentLink 放的是自行拼出的
 * https://aipay.alipay.com/pay?resource_id=...&out_trade_no=...，
 * 该地址并不存在，真实用户点开返回 404，无法付款。
 * 自此版本起，402 必须先成功预下单才返回；预下单失败返回 502，
 * 绝不再发占位链接。
 *
 * 沙箱模式（AIPAY_MODE=sandbox，默认）：不调用支付宝，直接返回
 * SANDBOX-PREPAY，供本地测试使用。
 *
 * 生产模式：调用支付宝 alipay.aipay.agent.payment.precreate
 * （生产网关 https://openapi.alipay.com/gateway.do），
 * 依赖 npm install alipay-sdk；配置 AIPAY_APP_ID / AIPAY_PRIVATE_KEY /
 * AIPAY_PUBLIC_KEY。密钥是 PKCS#8，需 keyType: 'PKCS8'
 *（SDK 默认按 PKCS#1 格式化会使进程崩溃，见 verify.js 同款注释）。
 */

'use strict';

const { config } = require('./bill');

/**
 * @param {object} order - createBill() 返回的 order：
 *   { outTradeNo, amount, goodsName, payBefore, ... }
 * @returns {Promise<{ok:boolean, amtPrePayId:string, reason:string, detail?:string}>}
 */
async function createPrePayOrder(order) {
  const cfg = config();

  // 沙箱：不调支付宝，返回占位预下单号
  if (cfg.mode !== 'production') {
    return { ok: true, amtPrePayId: 'SANDBOX-PREPAY', reason: '' };
  }

  let AlipaySdk;
  try {
    // 延迟加载：沙箱部署无需安装 alipay-sdk
    ({ AlipaySdk } = require('alipay-sdk'));
  } catch {
    return {
      ok: false,
      amtPrePayId: '',
      reason: 'PRODUCTION_SDK_MISSING',
      detail: '生产预下单需要安装 alipay-sdk 并配置 AIPAY_APP_ID / AIPAY_PRIVATE_KEY / AIPAY_PUBLIC_KEY',
    };
  }
  if (!cfg.appId || !cfg.privateKey) {
    return {
      ok: false,
      amtPrePayId: '',
      reason: 'PRODUCTION_NOT_CONFIGURED',
      detail: '生产预下单缺少 AIPAY_APP_ID 或 AIPAY_PRIVATE_KEY',
    };
  }
  const sdk = new AlipaySdk({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    alipayPublicKey: process.env.AIPAY_PUBLIC_KEY || '',
    gateway: cfg.gateway,
    timeout: 30000,
    keyType: 'PKCS8',
  });

  const bizContent = {
    pay_before: order.payBefore,
    amount: order.amount,
    goods_name: order.goodsName,
    service_id: cfg.serviceId,
    out_trade_no: order.outTradeNo,
    currency: 'CNY',
  };

  let resp;
  try {
    resp = await sdk.exec('alipay.aipay.agent.payment.precreate', { bizContent });
  } catch (e) {
    return { ok: false, amtPrePayId: '', reason: 'PRECREATE_FAILED', detail: e.message || '预下单调用失败' };
  }
  const data = resp.alipay_aipay_agent_payment_precreate_response || resp;
  if (String(data.code) !== '10000') {
    return {
      ok: false,
      amtPrePayId: '',
      reason: 'PRECREATE_FAILED',
      detail: data.sub_msg || data.msg || '预下单失败',
    };
  }
  const amtPrePayId = data.amt_pre_pay_id || data.amtPrePayId || '';
  if (!amtPrePayId) {
    return { ok: false, amtPrePayId: '', reason: 'PRECREATE_FAILED', detail: '预下单响应缺少 amt_pre_pay_id' };
  }
  return { ok: true, amtPrePayId, reason: '' };
}

module.exports = { createPrePayOrder };
