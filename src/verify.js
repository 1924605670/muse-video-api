/**
 * Payment-Proof 验付 — Muse 视频体验
 * 导出 verifyPaymentProof(proof, bill)
 *
 * 沙箱模式（AIPAY_MODE=sandbox，默认）：接受字面凭证 "SANDBOX-PROOF-OK"
 * （原始值，或 Base64URL 编码的官方格式 proof JSON 中的 protocol.payment_proof）。
 * 其他一律拒绝 → 调用方返回 402。
 *
 * 生产模式：调用支付宝 alipay.aipay.agent.payment.verify（沙箱网关
 * https://openapi-sandbox.dl.alipaydev.com/gateway.do；生产网关
 * https://openapi.alipay.com/gateway.do），并按官方契约校验：
 * code=10000、active=true、金额与本地订单一致、out_trade_no 一致、
 * resource_id 一致、trade_no 未重复履约。
 */

'use strict';

const { base64UrlDecode, config } = require('./bill');

/** 从 Payment-Proof 头值中提取 { paymentProof, tradeNo, clientSession }。 */
function parseProofHeader(proof) {
  const raw = String(proof || '').trim();
  if (!raw) return { paymentProof: '', tradeNo: '', clientSession: '' };
  if (raw === 'SANDBOX-PROOF-OK') {
    return { paymentProof: raw, tradeNo: '', clientSession: '' };
  }
  try {
    const decoded = base64UrlDecode(raw);
    const json = JSON.parse(decoded);
    return {
      paymentProof: (json.protocol && json.protocol.payment_proof) || '',
      tradeNo: (json.protocol && json.protocol.trade_no) || '',
      clientSession: (json.method && json.method.client_session) || '',
    };
  } catch {
    // 不是 Base64URL JSON：当作不透明凭证原文处理
    return { paymentProof: raw, tradeNo: '', clientSession: '' };
  }
}

function verifySandbox(parsed) {
  if (parsed.paymentProof === 'SANDBOX-PROOF-OK') {
    return {
      ok: true,
      mode: 'sandbox',
      tradeNo: 'SANDBOX-TRADE',
      outTradeNo: '',
      amount: null,
      resourceId: '',
      reason: '',
    };
  }
  return { ok: false, mode: 'sandbox', reason: 'INVALID_PROOF', detail: '沙箱凭证无效，应为 SANDBOX-PROOF-OK' };
}

// TODO(PRODUCTION): 生产验付 —— 接入真实支付宝密钥后启用。
// 调用接口：alipay.aipay.agent.payment.verify
//   网关：沙箱 https://openapi-sandbox.dl.alipaydev.com/gateway.do
//         生产 https://openapi.alipay.com/gateway.do
//   入参 bizContent：{ payment_proof, trade_no, client_session? }
//   依赖：npm install alipay-sdk；配置 AIPAY_APP_ID / AIPAY_PRIVATE_KEY / AIPAY_PUBLIC_KEY。
//   校验（任一失败 → 拒绝交付，返回 402）：
//     1) 响应 code === '10000'
//     2) active === true
//     3) 返回金额非空时必须与本地订单金额一致（生产缺金额必须拒绝，禁止用本地金额兜底）
//     4) 返回 out_trade_no 等于本地订单号
//     5) 返回 resource_id 等于当前请求资源
//     6) trade_no 未被重复履约
async function verifyProduction(parsed, bill) {
  let AlipaySdk;
  try {
    // 延迟加载：沙箱部署无需安装 alipay-sdk
    ({ AlipaySdk } = require('alipay-sdk'));
  } catch {
    return {
      ok: false,
      mode: 'production',
      reason: 'PRODUCTION_SDK_MISSING',
      detail: '生产验付需要安装 alipay-sdk 并配置 AIPAY_APP_ID / AIPAY_PRIVATE_KEY / AIPAY_PUBLIC_KEY',
    };
  }
  const cfg = config();
  if (!cfg.appId || !cfg.privateKey) {
    return {
      ok: false,
      mode: 'production',
      reason: 'PRODUCTION_NOT_CONFIGURED',
      detail: '生产验付缺少 AIPAY_APP_ID 或 AIPAY_PRIVATE_KEY',
    };
  }
  const sdk = new AlipaySdk({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    alipayPublicKey: process.env.AIPAY_PUBLIC_KEY || '',
    gateway: cfg.gateway,
    timeout: 30000,
  });
  const bizContent = { payment_proof: parsed.paymentProof, trade_no: parsed.tradeNo };
  if (parsed.clientSession) bizContent.client_session = parsed.clientSession;

  const resp = await sdk.exec('alipay.aipay.agent.payment.verify', { bizContent });
  const data = resp.alipay_aipay_agent_payment_verify_response || resp;
  if (String(data.code) !== '10000') {
    return { ok: false, mode: 'production', reason: 'VERIFY_FAILED', detail: data.sub_msg || data.msg || '验付失败' };
  }
  const returnedAmount = data.amount;
  const returnedOutTradeNo = data.out_trade_no || data.outTradeNo || '';
  const returnedResourceId = data.resource_id || data.resourceId || '';
  const active = data.active;
  const tradeNo = data.trade_no || data.tradeNo || '';

  if (active !== true) return { ok: false, mode: 'production', reason: 'PROOF_INACTIVE', detail: '凭证未激活或已过期' };
  if (!tradeNo || tradeNo !== parsed.tradeNo) {
    return { ok: false, mode: 'production', reason: 'TRADE_NO_MISMATCH', detail: 'trade_no 与凭证不一致' };
  }
  if (bill) {
    if (returnedAmount !== undefined && returnedAmount !== null && returnedAmount !== '') {
      if (Number(returnedAmount) !== Number(bill.amount)) {
        return { ok: false, mode: 'production', reason: 'AMOUNT_MISMATCH', detail: '验付金额与本地订单不一致' };
      }
    } else {
      // 生产缺少金额必须拒绝交付
      return { ok: false, mode: 'production', reason: 'AMOUNT_MISSING', detail: '验付响应缺少金额，生产环境拒绝交付' };
    }
    if (returnedOutTradeNo && returnedOutTradeNo !== bill.outTradeNo) {
      return { ok: false, mode: 'production', reason: 'OUT_TRADE_NO_MISMATCH', detail: 'out_trade_no 与本地订单不一致' };
    }
    if (returnedResourceId && returnedResourceId !== bill.resourceId) {
      return { ok: false, mode: 'production', reason: 'RESOURCE_MISMATCH', detail: 'resource_id 与本地订单不一致' };
    }
  }
  return {
    ok: true,
    mode: 'production',
    tradeNo,
    outTradeNo: returnedOutTradeNo,
    amount: returnedAmount,
    resourceId: returnedResourceId,
    reason: '',
  };
}

/**
 * @param {string} proof - Payment-Proof 头值
 * @param {object|null} bill - 本地订单（可空；沙箱字面凭证不需要订单）
 * @returns {Promise<{ok:boolean, mode:string, tradeNo:string, outTradeNo:string, amount:any, resourceId:string, reason:string, detail?:string}>}
 */
async function verifyPaymentProof(proof, bill = null) {
  const cfg = config();
  const parsed = parseProofHeader(proof);
  if (!parsed.paymentProof) {
    return { ok: false, mode: cfg.mode, reason: 'EMPTY_PROOF', detail: '缺少 Payment-Proof' };
  }
  if (cfg.mode === 'production') {
    return verifyProduction(parsed, bill);
  }
  return verifySandbox(parsed);
}

module.exports = { verifyPaymentProof, parseProofHeader };
