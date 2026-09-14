# OneNat WorkBuddy — 独立部署镜像（不依赖 DSH）
#
# 构建:  docker build -t onenat-workbuddy .
# 运行:  docker run -d --name workbuddy -p 3081:3081 \
#          -e ONENAT_BASE_URL=https://onenat.sooncore.com \
#          -e ONENAT_API_KEY=onk-xxxx \
#          -e HOST=0.0.0.0 \
#          -v workbuddy-data:/data \
#          onenat-workbuddy
#
# 说明：容器内必须监听 0.0.0.0 才能被映射出来；本服务自身无鉴权，
# 请只在受信网络使用，或在前面挂一层带认证的反向代理。

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json tsconfig.json tsconfig.server.json ./
COPY src ./src
COPY scripts ./scripts
# 只用 typescript 构建（不装 DSH 相关 peer，独立部署与 DSH 无关）
RUN npm install --no-save --no-package-lock typescript@5 @types/node@24 \
    && npx tsc -p tsconfig.server.json \
    && test -f dist/server.js

FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3081 \
    WORKBUDDY_HOME=/data
WORKDIR /app
# ssh2 / undici 均为可选依赖：缺失时 SSH exec 降级 / SSE 长静默段使用默认超时，服务照常可用
COPY --from=build /src/dist ./dist
COPY package.json ./
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3081
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3081)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
