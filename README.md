# Muse 视频体验 API

买家发一段文字描述，付 ¥0.1，Muse 为你生成一段 10 秒竖屏视频（720×1280），返回下载地址。
这是 SkillHub Pay Skill 的后端：只管排队 + 支付宝收费关卡，**不生成视频**。
视频由 worker（Muse agent）在后台生成、上传，再通过 worker 回调把下载地址写回任务。

- 单价：¥0.1/次（`PRICE_CNY`）
- 视频：10 秒竖屏，默认 9:16（可选 16:9 / 1:1，时长 5–15 秒）
- 下载链接：48 小时内有效，请及时保存
- 生成需要几分钟：创建任务后请轮询查询，状态变为 `done` 后取 `download_url`

## 本地运行

```bash
node server.js
# 监听 0.0.0.0:$PORT，默认 3000
# 配置见 .env.example（复制为 .env 后填入）
```

零依赖（纯 `node:http`），Node ≥ 18。

## 接口

### GET /health

```bash
curl http://127.0.0.1:3000/health
# {"ok":true,"mode":"sandbox","price_cny":0.1,"product":"muse-video-10s","version":"1.0.0"}
```

### GET /

服务中文说明（纯文本）。

### POST /api/video/jobs — 创建任务（收费关卡）

请求：

```json
{
  "prompt": "一只红熊猫在清晨竹林里喝茶",
  "style": "cinematic",
  "aspect": "9:16",
  "duration": 10
}
```

- `prompt` 必填，1–500 字；`style` 可选（默认 `cinematic`，常用：`cinematic` / `cctv` / `anime` / `documentary`）；`aspect` 可选，默认 `9:16`；`duration` 可选，默认 10 秒（5–15）。
- 先校验请求体再收费：`prompt` 为空或超长直接返回 400，不会让用户为错误请求付费。

完整流程（沙箱）：

```bash
# 1. 无凭证创建 → 402 + Payment-Needed 账单（不创建任务）
curl -i -X POST http://127.0.0.1:3000/api/video/jobs \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"一只红熊猫在清晨竹林里喝茶","style":"cinematic"}'
# HTTP/1.1 402 Payment Required
# Payment-Needed: <Base64URL 账单，amount_cny=0.1，15 分钟有效>
# amtPaymentLink: https://aipay.alipay.com/pay?resource_id=...&out_trade_no=...

# 2. 用户在支付宝完成支付后，带 Payment-Proof 重试 → 201 任务已入队
curl -X POST http://127.0.0.1:3000/api/video/jobs \
  -H 'Content-Type: application/json' \
  -H 'Payment-Proof: SANDBOX-PROOF-OK' \
  -d '{"prompt":"一只红熊猫在清晨竹林里喝茶","style":"cinematic"}'
# {"job_id":"MV...","status":"queued","prompt":"...","style":"cinematic",
#  "aspect":"9:16","duration":10,"price_cny":0.1,"download_url":null,"error":null,
#  "created_at":"...","updated_at":"..."}
# 沙箱凭证就是字面值 SANDBOX-PROOF-OK；生产用真实支付凭证。

# 3. 轮询任务
curl http://127.0.0.1:3000/api/video/jobs/MV...
# {"job_id":"MV...","status":"queued"|"processing"|"done"|"failed", ...}
```

状态：`queued`（已入队）→ `processing`（生成中）→ `done`（完成，带 `download_url`）或 `failed`（失败，带 `error`）。
未知 id → 404。

### GET /api/video/jobs?status=queued — worker 拉取任务列表

需 `X-Worker-Token`（见下方）。返回 `{ jobs: [...], count }`，按创建时间升序。

### POST /api/video/jobs/:id/processing — worker 标记处理中

```bash
curl -X POST http://127.0.0.1:3000/api/video/jobs/MV.../processing \
  -H 'X-Worker-Token: <WORKER_TOKEN>' -H 'Content-Type: application/json' -d '{}'
# 200 {"job_id":"MV...","status":"processing",...}
```

### POST /api/video/jobs/:id/complete — worker 回报结果

```bash
# 成功：
curl -X POST http://127.0.0.1:3000/api/video/jobs/MV.../complete \
  -H 'X-Worker-Token: <WORKER_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"download_url":"https://example.com/files/muse-video-001.mp4"}'
# 失败：
curl -X POST http://127.0.0.1:3000/api/video/jobs/MV.../complete \
  -H 'X-Worker-Token: <WORKER_TOKEN>' -H 'Content-Type: application/json' \
  -d '{"error":"生成失败：模型超时"}'
```

`download_url` 必须是 `https` 链接；已结束的任务（`done` / `failed`）再次回报返回 409。

worker 接口统一规则：缺少或错误的 `X-Worker-Token` → 401；未知任务 → 404。
`WORKER_TOKEN` 未配置时 worker 接口一律 401（必须设置强随机值）。

## 收费流程（支付宝 AI 按量付费，HTTP 402）

1. 无 `Payment-Proof` → 返回 `402 Payment Required`，`Payment-Needed` 头携带 Base64URL 编码账单（金额 ¥0.1、商品名、资源 ID、15 分钟有效期、商家 RSA2 签名），同时给 `amtPaymentLink` 头。此时**不创建任务**。
2. 买家在支付宝完成支付，智能体带 `Payment-Proof` 重试。
3. 服务端调用 `alipay.aipay.agent.payment.verify` 验付（沙箱接受字面凭证 `SANDBOX-PROOF-OK`；生产走真实接口并校验金额 / 订单号 / 资源 ID / trade_no 未重复履约）。
4. 验付通过 → 创建任务（201），同一笔真实支付重复重试只返回已创建的任务（按 `trade_no` 幂等）。
5. 调用 `alipay.aipay.agent.fulfillment.confirm` 确认履约（沙箱只记日志）。

实现见 `src/bill.js`（账单）、`src/verify.js`（验付）、`src/fulfill.js`（履约确认），
与姊妹项目 `talkshow-audit` 同源（支付宝官方 `alipay-aipay` 集成 Skill 的 A2M 契约）。

## worker 如何工作（给 Muse agent 的约定）

1. 定期拉取 `GET /api/video/jobs?status=queued`（带 `X-Worker-Token`）。
2. 取最早的 `queued` 任务，先调 `/processing` 标记处理中。
3. 用 Muse 视频模型生成 10 秒竖屏视频（720×1280），按任务的 `prompt` / `style` / `aspect` / `duration`。
4. 把成片上传到文件直链服务（如 Muse 内置存储，48 小时有效），拿到 `https` 下载地址。
5. 调 `/complete` 回报 `download_url`（成功）或 `error`（失败）。
6. 买家轮询 `GET /api/video/jobs/:id`，状态 `done` 后取 `download_url`。

注意：Muse 视频单次最多 6 条，worker 一次只处理一个任务；生成单条约几分钟，
买家需等待，skill 侧应说明等待时间并轮询，不要承诺秒出。

## Zeabur 部署

1. 把本目录推到 GitHub 仓库（或用 Zeabur 直接上传 / CLI 部署）。
2. 在 Zeabur 新建服务 → 选 Node.js（自动识别 `package.json` 的 `start`），或选 Dockerfile 部署（仓库里已带 `Dockerfile`，node:20-alpine）。
3. 服务会注入 `PORT`，本服务监听 `0.0.0.0:$PORT`，无需改代码。
4. 在 Zeabur 服务的环境变量里设置：
   - `AIPAY_MODE=sandbox`（上线前）/ `production`（接真支付宝后）
   - `PRICE_CNY=0.1`
   - `WORKER_TOKEN=<强随机值>`（必填，否则 worker 接口全部 401）
   - 生产再加：`AIPAY_APP_ID` / `AIPAY_PRIVATE_KEY` / `AIPAY_PUBLIC_KEY` / `AIPAY_SELLER_ID` / `AIPAY_SERVICE_ID` / `AIPAY_GATEWAY=https://openapi.alipay.com/gateway.do`
   - 不要把真实密钥写进仓库；只通过 Zeabur 环境变量注入。
5. 部署后拿到 Zeabur 的公开 `https` 域名（如 `https://muse-video-xxxx.zeabur.app`），
   先测 `GET /health`，再按上面流程跑一遍沙箱下单。

**注意：任务存在 `data/jobs.json` 文件里，只适合试用。Zeabur 容器文件系统在重新
部署后会丢失，上量后应换成数据库（Postgres / KV），并把 `trade_no → job_id`
的幂等映射一并迁过去。**

## 测试

```bash
npm test   # node test/video.test.js，纯 node:assert
```

13 组断言：health、中文说明、402 账单（¥0.1）与 amtPaymentLink、错误凭证 402、
空 prompt 400、沙箱凭证 201 入队、轮询、worker 口令 401/200、完成（https 校验）、
重复 complete 409、失败上报、worker 列表、任务文件持久化。

## 生产前还缺什么

1. **真实支付宝密钥**：在支付宝开放平台建应用，配 `AIPAY_APP_ID / AIPAY_PRIVATE_KEY /
   AIPAY_PUBLIC_KEY / AIPAY_SELLER_ID / AIPAY_SERVICE_ID`，`AIPAY_MODE=production`，
   生产网关，并 `npm install alipay-sdk`（`src/verify.js` 与 `src/fulfill.js` 里的
   TODO 调用点已写好）。沙箱完整跑通（402 → 支付 → 验付 → 履约）后再切生产。
2. **履约确认时机**：当前在任务创建时确认履约（确认「已受理并承诺交付」）。
   若支付宝要求「生成完成才确认」，需把 `confirmFulfillment` 移到 worker 的
   `/complete` 步骤，并把 `trade_no` 存进任务记录。
3. **持久化数据库**：替换 `data/jobs.json`（见上），并持久化待支付订单与幂等映射。
4. **worker 定时任务**：一个 cron/常驻任务定期拉取 `queued` 任务并生成视频
   （Muse 视频每次最多 6 条，单条几分钟，需排队与限流）。
5. **Pay Skill 打包发布**：写 SKILL.md（调本 API + 402 支付流程 + 轮询取下载地址），
   走 SkillHub Pay Skill 发布流程，买家验证需用**另一个**支付宝账号（不能是卖家自己的）。
6. 仓库里**没有任何真实密钥**；`.env.example` 只有占位值。
