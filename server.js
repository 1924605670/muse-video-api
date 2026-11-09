/**
 * Muse 视频体验 API — SkillHub Pay Skill 后端
 *
 * 买家通过 Skill 调 API 下单：POST /api/video/jobs（支付宝 AI 按量付费，
 * HTTP 402 流程，¥0.1/次）→ 任务入队 → worker（Muse agent）在后台生成
 * 10 秒竖屏视频并上传 → 买家轮询 GET /api/video/jobs/:id 取下载地址。
 * 本 API 只管排队 + 收费关卡，不生成视频。
 *
 *   GET  /                        服务说明（中文纯文本）
 *   GET  /health                  { ok, mode, price_cny, product }
 *   POST /api/video/jobs          创建任务（402 收费关卡）
 *   GET  /api/video/jobs/:id      查询任务
 *   GET  /api/video/jobs?status=  worker 拉取任务列表（需 X-Worker-Token）
 *   POST /api/video/jobs/:id/processing  worker 标记处理中（需 X-Worker-Token）
 *   POST /api/video/jobs/:id/complete    worker 回报结果（需 X-Worker-Token）
 *
 * 零依赖（纯 node:http），Node >= 18。配置全部走环境变量，见 .env.example。
 * 监听 0.0.0.0:$PORT（Zeabur 注入 PORT），默认 3000。
 */

'use strict';

const http = require('node:http');
const { createBill, paymentLinkFor, base64UrlEncode, config } = require('./src/bill');
const { verifyPaymentProof } = require('./src/verify');
const { confirmFulfillment } = require('./src/fulfill');
const { JobStore, publicJob } = require('./src/jobs');

const MAX_BODY_BYTES = 64 * 1024;
const VERSION = '1.0.0';
const PRODUCT = 'muse-video-10s';
const ALLOWED_STYLES = ['cinematic', 'cctv', 'anime', 'documentary'];
const ALLOWED_ASPECTS = ['9:16', '16:9', '1:1'];

const jobStore = new JobStore();
// 待支付订单（内存）：out_trade_no → order。402 时创建，验付成功后标记。
// 试用规模够用；上量后应随任务一起持久化到数据库。
const pendingOrders = new Map();

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    sendJson(res, e.message === 'BODY_TOO_LARGE' ? 413 : 400, { code: 'BAD_BODY', message: '请求体过大或读取失败' });
    return null;
  }
  if (!raw || !raw.trim()) return {};
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { code: 'BAD_JSON', message: '请求体必须是 JSON 对象' });
      return null;
    }
    return body;
  } catch {
    sendJson(res, 400, { code: 'BAD_JSON', message: '请求体不是合法 JSON' });
    return null;
  }
}

/** 校验创建任务的请求体。先校验再收费：无效请求直接 400，不让用户为错误请求付费。 */
function validateCreateJob(body) {
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return 'prompt 必填（视频内容描述，1–500 字）';
  }
  if (body.prompt.trim().length > 500) {
    return 'prompt 最多 500 字';
  }
  if (body.style !== undefined) {
    if (typeof body.style !== 'string' || !body.style.trim()) return 'style 必须是字符串';
    if (body.style.trim().length > 50) return 'style 最多 50 字';
  }
  if (body.aspect !== undefined && !ALLOWED_ASPECTS.includes(body.aspect)) {
    return `aspect 必须是 ${ALLOWED_ASPECTS.join(' / ')} 之一`;
  }
  if (body.duration !== undefined) {
    if (typeof body.duration !== 'number' || !Number.isFinite(body.duration)) return 'duration 必须是数字（秒）';
    if (body.duration < 5 || body.duration > 15) return 'duration 必须是 5–15 秒';
  }
  return null;
}

/** 无有效凭证时返回 402 + 账单（并生成一笔待支付订单）。 */
function respondPaymentNeeded(req, res, reason) {
  const { bill, order } = createBill();
  pendingOrders.set(order.outTradeNo, order);
  const paymentNeeded = base64UrlEncode(JSON.stringify(bill));
  sendJson(
    res,
    402,
    {
      code: 'Payment-Needed',
      message: `需要支付 ¥${config().priceCny} 后重试${reason ? `（${reason}）` : ''}`,
      amount_cny: config().priceCny,
      currency: 'CNY',
      product: bill.product,
      resource_id: bill.resource_id,
      out_trade_no: bill.out_trade_no,
      expires_at: bill.expires_at,
    },
    {
      'Payment-Needed': paymentNeeded,
      amtPaymentLink: paymentLinkFor(bill.resource_id, bill.out_trade_no),
    },
  );
}

function workerTokenValid(req) {
  const expected = process.env.WORKER_TOKEN || '';
  if (!expected) return false; // 未配置 WORKER_TOKEN 时 worker 接口一律拒绝
  const got = req.headers['x-worker-token'];
  return typeof got === 'string' && got.length > 0 && got === expected;
}

async function handleCreateJob(req, res) {
  // 1) 先解析并校验请求体（无效请求直接 400，不收费）
  const body = await readJsonBody(req, res);
  if (body === null) return;
  const err = validateCreateJob(body);
  if (err) {
    return sendJson(res, 400, { code: 'INVALID_REQUEST', message: err });
  }

  const prompt = body.prompt.trim();
  const style = (body.style || 'cinematic').trim();
  const aspect = body.aspect || '9:16';
  const duration = body.duration === undefined ? 10 : body.duration;

  // 2) 无凭证 → 402，不创建任务
  const proof = req.headers['payment-proof'];
  if (!proof || !String(proof).trim()) {
    return respondPaymentNeeded(req, res, '');
  }

  // 3) 验付
  const verified = await verifyPaymentProof(proof, null);
  if (!verified.ok) {
    if (verified.reason === 'PRODUCTION_SDK_MISSING' || verified.reason === 'PRODUCTION_NOT_CONFIGURED') {
      return sendJson(res, 500, {
        code: verified.reason,
        message: `生产验付未配置：${verified.detail}`,
      });
    }
    return respondPaymentNeeded(req, res, verified.detail || verified.reason);
  }

  // 4) 幂等：同一笔真实支付只创建一个任务（重试返回已创建的任务）
  const tradeNo = verified.tradeNo || '';
  if (tradeNo && tradeNo !== 'SANDBOX-TRADE') {
    const existing = jobStore.findByTradeNo(tradeNo);
    if (existing) {
      return sendJson(res, 200, publicJob(existing));
    }
  }

  // 5) 创建任务
  const cfg = config();
  const outTradeNo = verified.outTradeNo || `SANDBOX-${Date.now()}`;
  const resourceId = verified.resourceId || `${cfg.resourcePrefix}:${outTradeNo}`;
  const job = jobStore.create({
    prompt,
    style,
    aspect,
    duration,
    priceCny: cfg.priceCny,
    tradeNo,
    outTradeNo,
    resourceId,
  });
  if (pendingOrders.has(outTradeNo)) {
    const order = pendingOrders.get(outTradeNo);
    order.orderStatus = 'PAID';
    order.fulfillStatus = 'FULFILLING';
  }

  // 6) 履约确认（沙箱只记日志；生产调用支付宝 confirm）
  const confirmed = await confirmFulfillment({ tradeNo, outTradeNo, resourceId });
  if (!confirmed.ok) {
    // 任务已入队，客户端用同一 Payment-Proof 重试会命中幂等返回同一任务
    return sendJson(res, 502, {
      code: 'FULFILLMENT_CONFIRM_FAILED',
      message: `任务已创建（${job.job_id}）但履约确认失败，请稍后使用同一 Payment-Proof 重试：${confirmed.detail || confirmed.reason}`,
      job_id: job.job_id,
    });
  }
  if (pendingOrders.has(outTradeNo)) {
    pendingOrders.get(outTradeNo).fulfillStatus = 'FULFILLED';
  }

  const paymentValidation = base64UrlEncode(JSON.stringify({
    trade_no: tradeNo,
    out_trade_no: outTradeNo,
    validated: true,
    resource_id: resourceId,
  }));

  return sendJson(res, 201, publicJob(job), { 'Payment-Validation': paymentValidation });
}

function handleGetJob(req, res, jobId) {
  const job = jobStore.get(jobId);
  if (!job) {
    return sendJson(res, 404, { code: 'NOT_FOUND', message: `任务不存在：${jobId}` });
  }
  return sendJson(res, 200, publicJob(job));
}

function handleListJobs(req, res, url) {
  if (!workerTokenValid(req)) {
    return sendJson(res, 401, { code: 'UNAUTHORIZED', message: '缺少或错误的 X-Worker-Token' });
  }
  const status = url.searchParams.get('status') || undefined;
  const allowed = ['queued', 'processing', 'done', 'failed'];
  if (status && !allowed.includes(status)) {
    return sendJson(res, 400, { code: 'INVALID_REQUEST', message: `status 必须是 ${allowed.join(' / ')} 之一` });
  }
  const jobs = jobStore.list(status).map(publicJob);
  return sendJson(res, 200, { jobs, count: jobs.length });
}

async function handleProcessing(req, res, jobId) {
  if (!workerTokenValid(req)) {
    return sendJson(res, 401, { code: 'UNAUTHORIZED', message: '缺少或错误的 X-Worker-Token' });
  }
  const job = jobStore.get(jobId);
  if (!job) {
    return sendJson(res, 404, { code: 'NOT_FOUND', message: `任务不存在：${jobId}` });
  }
  if (job.status === 'done' || job.status === 'failed') {
    return sendJson(res, 409, { code: 'INVALID_STATE', message: `任务已结束（${job.status}），不能再标记处理中` });
  }
  if (job.status === 'processing') {
    return sendJson(res, 200, publicJob(job)); // 幂等
  }
  const updated = jobStore.update(jobId, { status: 'processing' });
  return sendJson(res, 200, publicJob(updated));
}

async function handleComplete(req, res, jobId) {
  if (!workerTokenValid(req)) {
    return sendJson(res, 401, { code: 'UNAUTHORIZED', message: '缺少或错误的 X-Worker-Token' });
  }
  const job = jobStore.get(jobId);
  if (!job) {
    return sendJson(res, 404, { code: 'NOT_FOUND', message: `任务不存在：${jobId}` });
  }
  if (job.status === 'done' || job.status === 'failed') {
    return sendJson(res, 409, { code: 'INVALID_STATE', message: `任务已结束（${job.status}），不能重复回报` });
  }
  const body = await readJsonBody(req, res);
  if (body === null) return;

  if (typeof body.download_url === 'string' && body.download_url.trim()) {
    let parsed;
    try {
      parsed = new URL(body.download_url.trim());
    } catch {
      return sendJson(res, 400, { code: 'INVALID_REQUEST', message: 'download_url 不是合法 URL' });
    }
    if (parsed.protocol !== 'https:') {
      return sendJson(res, 400, { code: 'INVALID_REQUEST', message: 'download_url 必须是 https 链接' });
    }
    const updated = jobStore.update(jobId, { status: 'done', download_url: body.download_url.trim(), error: null });
    return sendJson(res, 200, publicJob(updated));
  }
  if (typeof body.error === 'string' && body.error.trim()) {
    const updated = jobStore.update(jobId, { status: 'failed', error: body.error.trim(), download_url: null });
    return sendJson(res, 200, publicJob(updated));
  }
  return sendJson(res, 400, { code: 'INVALID_REQUEST', message: 'complete 需要 download_url（成功）或 error（失败）' });
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && path === '/health') {
        const cfg = config();
        return sendJson(res, 200, {
          ok: true,
          mode: cfg.mode,
          price_cny: cfg.priceCny,
          product: PRODUCT,
          version: VERSION,
        });
      }

      if (req.method === 'GET' && path === '/') {
        const cfg = config();
        return sendText(res, 200,
          'Muse 视频体验\n' +
          '发一段文字描述，付 ¥0.1，Muse 为你生成一段 10 秒竖屏视频（720x1280），返回下载地址。\n' +
          `当前模式：${cfg.mode}，单价：¥${cfg.priceCny}/次。\n` +
          '接口：POST /api/video/jobs（创建任务，需支付宝按量付费凭证）\n' +
          '     GET /api/video/jobs/:id（轮询任务状态与下载地址）\n' +
          '视频生成需要几分钟，请创建任务后轮询查询，状态变为 done 后取 download_url。\n' +
          '下载链接 48 小时内有效，请及时保存。\n');
      }

      if (req.method === 'GET' && path === '/api/video/jobs') {
        return handleListJobs(req, res, url);
      }

      if (req.method === 'POST' && path === '/api/video/jobs') {
        return handleCreateJob(req, res);
      }

      const m = path.match(/^\/api\/video\/jobs\/([^/]+)\/(processing|complete)$/);
      if (m) {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST' });
        }
        return m[2] === 'processing'
          ? handleProcessing(req, res, decodeURIComponent(m[1]))
          : handleComplete(req, res, decodeURIComponent(m[1]));
      }

      const m2 = path.match(/^\/api\/video\/jobs\/([^/]+)$/);
      if (m2) {
        if (req.method === 'GET') {
          return handleGetJob(req, res, decodeURIComponent(m2[1]));
        }
        return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET' });
      }

      return sendJson(res, 404, { code: 'NOT_FOUND', message: `未知路由 ${req.method} ${url.pathname}` });
    } catch (e) {
      console.error('[server] 未处理异常：', e);
      if (!res.headersSent) {
        sendJson(res, 500, { code: 'INTERNAL_ERROR', message: e.message || '服务器内部错误' });
      }
    }
  });
  return server;
}

function start(port) {
  const listenPort = port || Number(process.env.PORT || 3000);
  const server = createServer();
  server.listen(listenPort, '0.0.0.0', () => {
    console.log(`muse-video v${VERSION} listening on http://0.0.0.0:${server.address().port} (mode=${config().mode}, price=¥${config().priceCny})`);
  });
  return server;
}

if (require.main === module) {
  start();
}

module.exports = { createServer, start, jobStore };
