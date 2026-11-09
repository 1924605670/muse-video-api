/**
 * 任务存储 — Muse 视频体验
 * 任务以 JSON 文件持久化（data/jobs.json，路径可用 JOBS_FILE 环境变量覆盖）。
 * 写入采用「写临时文件 + rename」原子替换，避免写一半被读到。
 *
 * 注意：文件存储只适合试用规模。Zeabur 的容器文件系统在重新部署后会丢失，
 * 上量后应换成数据库（Postgres / KV），并把 trade_no → job_id 的幂等映射
 * 一并迁过去。接口保持不变。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_JOBS_FILE = path.join(__dirname, '..', 'data', 'jobs.json');

function jobsFilePath() {
  return process.env.JOBS_FILE || DEFAULT_JOBS_FILE;
}

function newJobId() {
  return `MV${Date.now()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function publicJob(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    status: job.status,
    prompt: job.prompt,
    style: job.style,
    aspect: job.aspect,
    duration: job.duration,
    price_cny: job.price_cny,
    download_url: job.download_url || null,
    error: job.error || null,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

class JobStore {
  constructor(filePath) {
    this.filePath = filePath || jobsFilePath();
    this.jobs = new Map(); // job_id → job
    this.byTradeNo = new Map(); // trade_no → job_id（真实支付的幂等映射；沙箱不启用）
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw || '{}');
      const list = Array.isArray(data.jobs) ? data.jobs : [];
      for (const job of list) {
        if (!job || !job.job_id) continue;
        this.jobs.set(job.job_id, job);
        if (job.trade_no && job.trade_no !== 'SANDBOX-TRADE') {
          this.byTradeNo.set(job.trade_no, job.job_id);
        }
      }
    } catch (e) {
      console.error(`[jobs] 读取 ${this.filePath} 失败，按空库启动：`, e.message);
      this.jobs = new Map();
      this.byTradeNo = new Map();
    }
  }

  _save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const payload = JSON.stringify(
      { version: 1, updated_at: new Date().toISOString(), jobs: [...this.jobs.values()] },
      null,
      2,
    );
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  create({ prompt, style, aspect, duration, priceCny, tradeNo, outTradeNo, resourceId }) {
    const now = new Date().toISOString();
    const job = {
      job_id: newJobId(),
      status: 'queued',
      prompt,
      style,
      aspect,
      duration,
      price_cny: priceCny,
      download_url: null,
      error: null,
      trade_no: tradeNo || '',
      out_trade_no: outTradeNo || '',
      resource_id: resourceId || '',
      created_at: now,
      updated_at: now,
    };
    this.jobs.set(job.job_id, job);
    if (job.trade_no && job.trade_no !== 'SANDBOX-TRADE') {
      this.byTradeNo.set(job.trade_no, job.job_id);
    }
    this._save();
    return job;
  }

  get(jobId) {
    return this.jobs.get(jobId) || null;
  }

  findByTradeNo(tradeNo) {
    if (!tradeNo || tradeNo === 'SANDBOX-TRADE') return null;
    const id = this.byTradeNo.get(tradeNo);
    return id ? this.jobs.get(id) || null : null;
  }

  /** 按状态列出任务（worker 拉取待处理任务用），按创建时间升序。 */
  list(status) {
    const all = [...this.jobs.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return status ? all.filter((j) => j.status === status) : all;
  }

  update(jobId, patch) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    Object.assign(job, patch, { updated_at: new Date().toISOString() });
    this._save();
    return job;
  }
}

module.exports = { JobStore, publicJob, newJobId, DEFAULT_JOBS_FILE };
