FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src/package.json src/package-lock.json* ./src/
RUN cd src && npm install
COPY src/ ./src/
# 前端构建时需要读取项目根 config/security-policy.json（单一数据源），
# 该目录不在 src/ 内，需显式拷入构建阶段，否则 vite/rollup 解析失败。
COPY config/ ./config/
RUN cd src && npm run build


FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
# 容器内监听端口
ENV PORT=3000
COPY . .
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web/dist ./web/dist

EXPOSE 3000
CMD ["node", "server.js"]
