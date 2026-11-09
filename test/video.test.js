/**
 * Muse 视频体验 API 测试（纯 node:assert，无框架）
 * 启动真实服务器（测试端口 + 临时任务文件），覆盖：
 *  health / 402 收费关卡 / 201 建任务 / 轮询 / worker 加工 / 完成 / 400 校验 / 失败上报
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_PORT = 18765;
const WORKER_TOKEN = 'test-worker-token';
const JOBS_FILE = path.join(os.tmpdir(), `muse-video-test-${process.pid}.json`);

// 必须在 require server 之前设置环境变量（JobStore 在模块加载时读 JOBS_FILE）
process.env.AIPAY_MODE = 'sandbox';
process.env.PRICE_CNY = '0.5';
process.env.WORKER_TOKEN = WORKER_TOKEN;
process.env.JOBS_FILE = JOBS_FILE;

const { start } = require('../server');

const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PROOF = 'SANDBOX-PROOF-OK';

let passed = 0;
let failed = 0;

async function req(method, p, { headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

async function main() {
  const server = start(TEST_PORT);
  await new Promise((r) => server.on('listening', r));

  let jobId = null;
  let job2Id = null;

  await check('GET /health 返回 200，mode=sandbox，price_cny=0.5，product=muse-video-10s', async () => {
    const r = await req('GET', '/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.mode, 'sandbox');
    assert.strictEqual(r.json.price_cny, 0.5);
    assert.strictEqual(r.json.product, 'muse-video-10s');
  });

  await check('GET / 返回中文服务说明', async () => {
    const r = await req('GET', '/');
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /Muse 视频体验/);
    assert.match(r.text, /¥0.5/);
  });

  await check('无 Payment-Proof 创建任务 → 402 + Payment-Needed 账单（¥0.5）+ amtPaymentLink，不建任务', async () => {
    const r = await req('POST', '/api/video/jobs', {
      body: { prompt: '一只红熊猫在清晨竹林里喝茶', style: 'cinematic' },
    });
    assert.strictEqual(r.status, 402);
    const needed = r.headers.get('payment-needed');
    assert.ok(needed, '缺少 Payment-Needed 头');
    const bill = JSON.parse(b64urlDecode(needed));
    assert.strictEqual(bill.amount_cny, 0.5);
    assert.strictEqual(bill.currency, 'CNY');
    assert.strictEqual(bill.product, 'Muse 视频体验（10秒竖屏）');
    assert.ok(bill.resource_id);
    assert.ok(r.headers.get('amtpaymentlink'), '缺少 amtPaymentLink 头');
    // 没有任务被创建：查一个不存在的 id 应为 404
    const g = await req('GET', '/api/video/jobs/MV-DOES-NOT-EXIST');
    assert.strictEqual(g.status, 404);
  });

  await check('错误凭证 → 402', async () => {
    const r = await req('POST', '/api/video/jobs', {
      headers: { 'Payment-Proof': 'WRONG-PROOF' },
      body: { prompt: '一只红熊猫在清晨竹林里喝茶' },
    });
    assert.strictEqual(r.status, 402);
  });

  await check('空 prompt → 400（先校验再收费，不用凭证）', async () => {
    const r = await req('POST', '/api/video/jobs', { body: { prompt: '   ' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.code, 'INVALID_REQUEST');
  });

  await check('沙箱凭证创建任务 → 201 queued，字段完整', async () => {
    const r = await req('POST', '/api/video/jobs', {
      headers: { 'Payment-Proof': PROOF },
      body: { prompt: '一只红熊猫在清晨竹林里喝茶', style: 'cinematic', aspect: '9:16', duration: 10 },
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.json.status, 'queued');
    assert.strictEqual(r.json.prompt, '一只红熊猫在清晨竹林里喝茶');
    assert.strictEqual(r.json.style, 'cinematic');
    assert.strictEqual(r.json.aspect, '9:16');
    assert.strictEqual(r.json.duration, 10);
    assert.strictEqual(r.json.price_cny, 0.5);
    assert.strictEqual(r.json.download_url, null);
    assert.ok(r.json.job_id, '缺少 job_id');
    assert.ok(r.json.created_at, '缺少 created_at');
    jobId = r.json.job_id;
  });

  await check('GET 任务 → queued，字段与创建时一致', async () => {
    const r = await req('GET', `/api/video/jobs/${jobId}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.job_id, jobId);
    assert.strictEqual(r.json.status, 'queued');
    assert.strictEqual(r.json.prompt, '一只红熊猫在清晨竹林里喝茶');
  });

  await check('worker /processing：错误口令 → 401，正确口令 → 200 processing', async () => {
    const bad = await req('POST', `/api/video/jobs/${jobId}/processing`, {
      headers: { 'X-Worker-Token': 'wrong-token' },
      body: {},
    });
    assert.strictEqual(bad.status, 401);
    const noToken = await req('POST', `/api/video/jobs/${jobId}/processing`, { body: {} });
    assert.strictEqual(noToken.status, 401);
    const ok = await req('POST', `/api/video/jobs/${jobId}/processing`, {
      headers: { 'X-Worker-Token': WORKER_TOKEN },
      body: {},
    });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.status, 'processing');
  });

  await check('worker /complete：非 https 下载地址 → 400；https 地址 → 200 done，GET 能取到下载地址', async () => {
    const bad = await req('POST', `/api/video/jobs/${jobId}/complete`, {
      headers: { 'X-Worker-Token': WORKER_TOKEN },
      body: { download_url: 'http://example.com/video.mp4' },
    });
    assert.strictEqual(bad.status, 400);
    const ok = await req('POST', `/api/video/jobs/${jobId}/complete`, {
      headers: { 'X-Worker-Token': WORKER_TOKEN },
      body: { download_url: 'https://example.com/files/muse-video-001.mp4' },
    });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.json.status, 'done');
    assert.strictEqual(ok.json.download_url, 'https://example.com/files/muse-video-001.mp4');
    const g = await req('GET', `/api/video/jobs/${jobId}`);
    assert.strictEqual(g.status, 200);
    assert.strictEqual(g.json.status, 'done');
    assert.strictEqual(g.json.download_url, 'https://example.com/files/muse-video-001.mp4');
  });

  await check('已完成的任务再次 complete → 409', async () => {
    const r = await req('POST', `/api/video/jobs/${jobId}/complete`, {
      headers: { 'X-Worker-Token': WORKER_TOKEN },
      body: { download_url: 'https://example.com/files/other.mp4' },
    });
    assert.strictEqual(r.status, 409);
  });

  await check('第二个任务 complete 带 error → failed，GET 显示 error', async () => {
    const c = await req('POST', '/api/video/jobs', {
      headers: { 'Payment-Proof': PROOF },
      body: { prompt: '夜里下雪的火车站' },
    });
    assert.strictEqual(c.status, 201);
    job2Id = c.json.job_id;
    const done = await req('POST', `/api/video/jobs/${job2Id}/complete`, {
      headers: { 'X-Worker-Token': WORKER_TOKEN },
      body: { error: '生成失败：模型超时' },
    });
    assert.strictEqual(done.status, 200);
    assert.strictEqual(done.json.status, 'failed');
    assert.strictEqual(done.json.error, '生成失败：模型超时');
    const g = await req('GET', `/api/video/jobs/${job2Id}`);
    assert.strictEqual(g.status, 200);
    assert.strictEqual(g.json.status, 'failed');
    assert.strictEqual(g.json.error, '生成失败：模型超时');
  });

  await check('worker 列表接口：无口令 → 401；带口令 + status=queued → 只剩已完成的任务不在列', async () => {
    const noToken = await req('GET', '/api/video/jobs?status=queued');
    assert.strictEqual(noToken.status, 401);
    const ok = await req('GET', '/api/video/jobs?status=queued', {
      headers: { 'X-Worker-Token': WORKER_TOKEN },
    });
    assert.strictEqual(ok.status, 200);
    assert.ok(Array.isArray(ok.json.jobs));
    assert.ok(!ok.json.jobs.some((j) => j.job_id === jobId), '已完成任务不应出现在 queued 列表');
    assert.ok(!ok.json.jobs.some((j) => j.job_id === job2Id), '失败任务不应出现在 queued 列表');
  });

  await check('任务持久化：jobs 文件已写入，重启后可读回', async () => {
    assert.ok(fs.existsSync(JOBS_FILE), 'jobs 文件不存在');
    const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    assert.ok(Array.isArray(data.jobs));
    assert.ok(data.jobs.some((j) => j.job_id === jobId && j.status === 'done'));
    assert.ok(data.jobs.some((j) => j.job_id === job2Id && j.status === 'failed'));
  });

  await new Promise((r) => server.close(r));
  try {
    fs.unlinkSync(JOBS_FILE);
  } catch {
    // 忽略清理失败
  }

  console.log(`\n${failed === 0 ? '全部通过' : '失败'}：${passed} 组通过，${failed} 组失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试运行异常：', e);
  process.exit(1);
});
