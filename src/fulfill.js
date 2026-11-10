/**
 * 履约确认（fulfillment）— Muse 视频体验
 * 资源交付后调用，向支付宝确认本次履约已完成。
 *
 * 沙箱模式：仅记录回执日志，不调用外部接口。
 * 生产模式：调用 alipay.aipay.agent.fulfillment.confirm，入参只有 trade_no。
 *   确认成功后订单方可标记为最终完成；确认失败时允许同一 Payment-Proof 重试。
 *
 * 注意：视频是异步交付（先入队、后生成）。履约确认在「任务创建」时调用，
 * 确认的是「已受理并承诺交付」；生成完成后 worker 通过 /complete 回报结果。
 * 生产若要求「生成完成才确认履约」，应把 confirmFulfillment 移到 worker
 * 的 complete 步骤，见 README 的生产注意事项。
 */

'use strict';

const { config } = require('./bill');

/**
 * @param {{ tradeNo: string, outTradeNo: string, resourceId: string }} params
 * @returns {Promise<{ ok: boolean, mode: string, receipt?: object, reason?: string, detail?: string }>}
 */
async function confirmFulfillment({ tradeNo, outTradeNo, resourceId }) {
  const cfg = config();
  if (cfg.mode !== 'production') {
    const receipt = {
      trade_no: tradeNo || 'SANDBOX-TRADE',
      out_trade_no: outTradeNo || '',
      resource_id: resourceId || '',
      fulfilled_at: new Date().toISOString(),
      mode: 'sandbox',
    };
    console.log('[fulfill:sandbox] 履约回执已记录：', JSON.stringify(receipt));
    return { ok: true, mode: 'sandbox', receipt };
  }

  // TODO(PRODUCTION): 生产履约确认 —— 接入真实支付宝密钥后启用。
  // 调用接口：alipay.aipay.agent.fulfillment.confirm
  //   入参 bizContent：{ trade_no }
  //   依赖：npm install alipay-sdk；配置 AIPAY_APP_ID / AIPAY_PRIVATE_KEY / AIPAY_PUBLIC_KEY。
  //   成功条件：响应 code === '10000'；失败时返回 { ok:false }，调用方应返回 502
  //   并提示客户端用同一 Payment-Proof 重试，禁止重复创建任务。
  let AlipaySdk;
  try {
    ({ AlipaySdk } = require('alipay-sdk'));
  } catch {
    return {
      ok: false,
      mode: 'production',
      reason: 'PRODUCTION_SDK_MISSING',
      detail: '生产履约确认需要安装 alipay-sdk 并配置真实密钥',
    };
  }
  if (!cfg.appId || !cfg.privateKey) {
    return {
      ok: false,
      mode: 'production',
      reason: 'PRODUCTION_NOT_CONFIGURED',
      detail: '生产履约确认缺少 AIPAY_APP_ID 或 AIPAY_PRIVATE_KEY',
    };
  }
  const sdk = new AlipaySdk({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    alipayPublicKey: process.env.AIPAY_PUBLIC_KEY || '',
    gateway: cfg.gateway,
    timeout: 30000,
    // 密钥是 PKCS#8，SDK 默认按 PKCS#1 格式化会损坏密钥导致签名崩溃，见 verify.js。
    keyType: 'PKCS8',
  });
  let resp;
  try {
    resp = await sdk.exec('alipay.aipay.agent.fulfillment.confirm', {
      bizContent: { trade_no: tradeNo },
    });
  } catch (e) {
    return {
      ok: false,
      mode: 'production',
      reason: 'FULFILLMENT_CONFIRM_FAILED',
      detail: e.message || '履约确认调用失败',
    };
  }
  const data = resp.alipay_aipay_agent_fulfillment_confirm_response || resp;
  if (String(data.code) === '10000') {
    return {
      ok: true,
      mode: 'production',
      receipt: { trade_no: tradeNo, out_trade_no: outTradeNo, resource_id: resourceId, fulfilled_at: new Date().toISOString() },
    };
  }
  return {
    ok: false,
    mode: 'production',
    reason: 'FULFILLMENT_CONFIRM_FAILED',
    detail: data.sub_msg || data.msg || '履约确认失败',
  };
}

module.exports = { confirmFulfillment };
