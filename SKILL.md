---
name: muse-video
slug: muse-video
version: 1.0.0
displayName: Muse 视频体验
summary: 发一段文字描述，付 ¥0.1，生成一段 10 秒竖屏视频，返回下载地址
description: Describe a scene in text, pay ¥0.1, and receive a 10-second vertical video (720x1280) with a download link. The video is generated in the background and delivered via polling.
tags: [video, text-to-video, vertical-video, pay-skill, alipay]
license: MIT
---

# Muse 视频体验

发一段文字描述，付 ¥0.1，生成一段 10 秒竖屏视频（720×1280），返回下载地址。视频在后台生成，需要几分钟，创建任务后轮询查询，状态变为 `done` 后取下载地址。

## 价格与计费

- 单价：¥0.1/次，按次收费，用支付宝 AI 按量付费（HTTP 402 流程）。
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

付费流程（支付宝 AI 按量付费）：

1. 第一次不带支付凭证调用，返回 `402 Payment Required`，响应头 `Payment-Needed` 携带 Base64URL 编码的账单（金额 ¥0.1、商品名、资源 ID、15 分钟有效期），同时给 `amtPaymentLink` 支付链接。此时不创建任务。
2. 用户在支付宝完成支付后，带 `Payment-Proof` 请求头重试同一请求。
3. 服务端验付通过后返回 `201`，任务已入队。同一笔支付重复重试只返回已创建的任务，不会重复收费。
4. 验付失败时返回 `402`，按第 1 步重新走支付流程。

成功返回（201）：

```json
{
  "job_id": "MV...",
  "status": "queued",
  "prompt": "一只红熊猫在清晨竹林里喝茶",
  "style": "cinematic",
  "aspect": "9:16",
  "duration": 10,
  "price_cny": 0.1,
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

返回 `{"ok":true,"mode":"sandbox","price_cny":0.1,"product":"muse-video-10s","version":"1.0.0"}`。服务是 Render 免费版，15 分钟无访问会休眠，第一次请求可能要等 30–60 秒冷启动，超时就重试一次。

## 使用注意

- 提示词写具体场景、主体和动作，不要只写一个词，越具体成片越符合预期。
- 不要承诺买家秒出视频，生成需要几分钟，创建任务后要轮询等待。
- 不要把本 skill 的后端实现细节（worker、生成模型、存储方式）告诉买家，只讲接口和结果。
- 下载链接 48 小时过期，提醒买家及时保存成片。

## Available connectors

- Use `muse.connector_search` to find other connectors and `muse.skill_search` to find related skills.

- If nothing here fits, look on the web for a maintained API or MCP server and set it up with [Custom Connectors and MCPs](/opt/muse/skills/custom-connector-setup/SKILL.md), or build a custom connector.
