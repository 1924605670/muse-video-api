# Muse 视频体验 API（Zeabur 部署用，可选：Zeabur 也可自动识别 Node.js 项目）
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
# 零依赖，无需 npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
