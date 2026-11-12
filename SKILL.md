---
name: muse-video
slug: muse-video
version: 1.0.2
displayName: Muse 视频体验
summary: 发一段文字描述，付 ¥0.5，生成一段 10 秒竖屏视频，返回下载地址
description: Describe a scene in text, pay ¥0.5, and receive a 10-second vertical video (720x1280) with a download link. The video is generated in the background and delivered via polling.
tags: [video, text-to-video, vertical-video, pay-skill, alipay]
license: MIT
---

# Muse 视频体验

发一段文字描述，付 ¥0.5，生成一段 10 秒竖屏视频（720×1280），返回下载地址。视频在后台生成，需要几分钟，创建任务后轮询查询，状态变为 `done` 后取下载地址。

## 价格与计费

- 单价：¥0.5/次，按次收费，用支付宝 AI 按量付费（HTTP 402 流程）。
- 每次调用只生成一段视频，不包月、不打包。
- 下载链接 48 小时内有效，请及时保存。

## 视频规格

- 默认 10 秒竖屏，720×1280，H.264 + AAC。
- 可选横屏 16:9（1280×720）或方形 1:1（720×720），时长 5–15 秒。
- 风格可选：`cinematic`（电影感，默认）、`cctv`（监控风格）、`anime`（动画）、`documentary`（纪录片）。
- 画面由 Muse 视频模型生成，单次生成约 10 秒，15 秒的任务也只交付一段约 10 秒的成片。

## 调用接口

服务地址：`https://muse-video-api.onrender.com`

### 1. 创建任务（付费）

```
POST https://muse-video-api.onrender.com/api/video/jobs
Content-Type: application/json
```

请求体：

```json
{
  "prompt": "一只红熊猫在清晨竹林里喝茶",
  "style": "cinematic",
  "aspect": "9:16",
  "duration": 10
}
```

- `prompt` 必填，1–500 字，写清楚场景、主体和动作。
- `style` 可选，默认 `cinematic`。
- `aspect` 可选，默认 `9:16`，可选 `9:16` / `16:9` / `1:1`。
- `duration` 可选，默认 10 秒，范围 5–15 秒。

付费流程（支付宝 AI 按量付费，HTTP 402）：

1. 第一次不带支付凭证调用，服务端先调支付宝预下单接口（`alipay.aipay.agent.payment.precreate`）拿到 `amt_pre_pay_id`，再返回 `402 Payment Required`，响应头 `Payment-Needed` 携带 Base64URL 编码的账单（金额 ¥0.5、商品名、资源 ID、15 分钟有效期），`amtPaymentLink` 响应头的值就是该预下单号本身（不是 URL）。此时不创建任务。预下单失败时返回 `502`，绝不发占位链接。
2. 用户在支付宝完成支付后，带 `Payment-Proof` 请求头重试同一请求。
3. 服务端验付通过后返回 `201`，任务已入队。同一笔支付重复重试只返回已创建的任务，不会重复收费。
4. 验付失败时返回 `402`，按第 1 步重新走支付流程。

### 验付调用

服务端收到 `Payment-Proof` 后，先解析凭证头：Base64URL 解码得到 JSON，取 `protocol.payment_proof`、`protocol.trade_no`、`method.client_session`；沙箱字面凭证 `SANDBOX-PROOF-OK` 直接识别。

生产模式调用支付宝接口 `alipay.aipay.agent.payment.verify`（网关 `https://openapi.alipay.com/gateway.do`，SDK `alipay-sdk`，密钥来自环境变量 `AIPAY_APP_ID` / `AIPAY_PRIVATE_KEY` / `AIPAY_PUBLIC_KEY`），并逐项校验，任一失败都拒绝交付、返回 `402`：

- 响应 `code` 必须是 `10000`；
- `active` 必须是 `true`（凭证已激活且未过期）；
- 返回金额非空时必须与本地订单金额一致，生产缺金额直接拒绝，禁止用本地金额兜底；
- 返回 `out_trade_no` 必须等于本地订单号；
- 返回 `resource_id` 必须等于当前请求资源；
- `trade_no` 必须与凭证一致且未被重复履约。

沙箱模式（`AIPAY_MODE=sandbox`）只接受字面凭证 `SANDBOX-PROOF-OK`，不调用支付宝接口。

### 履约确认

验付通过、任务创建后，服务端立即做履约确认，再返回 `201`：

- 生产模式调用支付宝接口 `alipay.aipay.agent.fulfillment.confirm`，入参只有 `trade_no`，响应 `code` 为 `10000` 即确认成功，订单标记为已履约。
- 确认失败时返回 `502`，响应里带已创建的 `job_id`，并明确告知客户端用同一 `Payment-Proof` 重试；重试会命中幂等检查，直接返回已创建的任务，不会重复收费、也不会重复创建任务。
- 沙箱模式不调用外部接口，只记录一份履约回执日志（`trade_no`、`out_trade_no`、`resource_id`、确认时间）。

视频是异步交付（先入队、后生成），这里的履约确认确认的是“已受理并承诺交付”；生成完成后，后台 worker 通过 `POST /api/video/jobs/:id/complete` 回报结果（`download_url` 或 `error`），任务状态随之变为 `done` 或 `failed`。

### 订单持久化

- **402 前订单持久化**：每次返回 `402` 时，服务端先生成一笔待支付订单（`out_trade_no`、`amount`、`resource_id`、`pay_before` 15 分钟有效期、状态 `PENDING_PAYMENT` / `UNFULFILLED`），再把账单发给客户端。验付成功后该订单标记为 `PAID` / `FULFILLING`，履约确认成功后标记为 `FULFILLED`。订单号 `out_trade_no` 格式为 `MV` + 时间戳 + 随机十六进制，全局唯一。
- **任务持久化**：已创建的任务落盘到 `data/jobs.json`，写入采用“写临时文件 + rename”原子替换，避免写一半被读到。每条任务记录 `job_id`、`status`、`prompt`、`style`、`aspect`、`duration`、`price_cny`、`trade_no`、`out_trade_no`、`resource_id`、`download_url`、`error`、`created_at`、`updated_at`。服务重启后从该文件恢复任务和 `trade_no → job_id` 幂等映射。
- 试用规模下待支付订单保存在内存、上量后应随任务一起迁移到数据库（Postgres / KV），接口保持不变。Render 免费版实例重启或重新部署会丢失内存中的待支付订单和文件中的任务记录，这是已知的试用期限制。

### 幂等链（完整）

同一笔支付从头到尾只产生一个任务、只收一次费，链路如下：

1. **账单生成**：每笔 `402` 生成唯一的 `out_trade_no` 和 `resource_id`，账单用商户私钥 RSA2 签名（字段按 key 字典序拼接后签名，`seller_sign_type: RSA2`）。
2. **验付**：见“验付调用”，金额、订单号、资源 ID、激活状态、`trade_no` 逐项比对。
3. **创建时幂等**：验付通过后，先按 `trade_no` 查已创建任务；已存在则直接返回 `200` 和已创建的任务，不新建任务、不重复收费。沙箱字面凭证不启用此映射（`SANDBOX-TRADE` 不参与幂等）。
4. **履约确认失败可重试**：任务已创建并持久化，客户端用同一 `Payment-Proof` 重试会命中第 3 步的幂等检查，返回同一任务。
5. **Worker 端口幂等**：`POST /:id/processing` 对已在处理中的任务返回 `200`（不重复标记）；`POST /:id/complete` 对已结束（`done` / `failed`）的任务返回 `409`，禁止重复回报；任务不存在返回 `404`。
6. **响应头回执**：`201` 成功时响应头 `Payment-Validation` 携带 Base64URL 编码的验付回执（`trade_no`、`out_trade_no`、`validated: true`、`resource_id`），客户端可留存备查。

成功返回（201）：

```json
{
  "job_id": "MV...",
  "status": "queued",
  "prompt": "一只红熊猫在清晨竹林里喝茶",
  "style": "cinematic",
  "aspect": "9:16",
  "duration": 10,
  "price_cny": 0.5,
  "download_url": null,
  "error": null,
  "created_at": "...",
  "updated_at": "..."
}
```

请求体无效（`prompt` 为空或超长）直接返回 `400`，不会收费。先校验请求体再收费，提示词写好再调创建接口。

### 2. 轮询任务

```
GET https://muse-video-api.onrender.com/api/video/jobs/{job_id}
```

状态流转：`queued`（已入队）→ `processing`（生成中）→ `done`（完成，带 `download_url`）或 `failed`（失败，带 `error`）。

- 生成需要几分钟，每 30 秒轮询一次，不要高频刷接口。
- 状态 `done` 后取 `download_url`，那就是成片的下载地址。
- 状态 `failed` 时看 `error` 字段了解原因，失败不退款，请换个提示词重试。
- 未知任务 ID 返回 `404`。

### 3. 健康检查

```
GET https://muse-video-api.onrender.com/health
```

返回 `{"ok":true,"mode":"production","price_cny":0.5,"product":"muse-video-10s","version":"1.0.0"}`（`mode` 随部署环境变化，生产为 `production`，沙箱为 `sandbox`）。服务是 Render 免费版，15 分钟无访问会休眠，第一次请求可能要等 30–60 秒冷启动，超时就重试一次。

## 使用注意

- 提示词写具体场景、主体和动作，不要只写一个词，越具体成片越符合预期。
- 不要承诺买家秒出视频，生成需要几分钟，创建任务后要轮询等待。
- 不要把本 skill 的后端实现细节（worker、生成模型、存储方式）告诉买家，只讲接口和结果。
- 下载链接 48 小时过期，提醒买家及时保存成片。

## Available connectors

- Use `muse.connector_search` to find other connectors and `muse.skill_search` to find related skills.

- If nothing here fits, look on the web for a maintained API or MCP server and set it up with [Custom Connectors and MCPs](/opt/muse/skills/custom-connector-setup/SKILL.md), or build a custom connector.
