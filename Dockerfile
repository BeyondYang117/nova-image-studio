FROM node:22-slim AS frontend-builder

WORKDIR /app

# abu-api 集成模式构建参数（独立版留空即可）：
# NEXT_PUBLIC_INTEGRATED_MODE=true 启用集成模式（平台会话桥/模型播种/禁用 PWA）
# NEXT_PUBLIC_BASE_PATH=/nova-app  挂载子路径，需与平台反代路径一致
ARG NEXT_PUBLIC_INTEGRATED_MODE=""
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_INTEGRATED_MODE=${NEXT_PUBLIC_INTEGRATED_MODE} \
    NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH}

COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package-lock.json ./frontend/
COPY frontend/ ./frontend/

RUN cd frontend && npm ci && npm run build

FROM node:22-slim AS backend-deps

WORKDIR /app/backend

# better-sqlite3 需要在安装阶段使用 python3、make、g++
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json ./

RUN npm ci --omit=dev \
  && apt-get purge -y --auto-remove python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

FROM node:22-slim AS production

WORKDIR /app

# 后端挂载前缀与前端构建保持一致（可被运行时环境变量覆盖）
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NODE_ENV=production \
    NOVA_BASE_PATH=${NEXT_PUBLIC_BASE_PATH}

COPY backend/ ./backend/
COPY --from=backend-deps /app/backend/node_modules/ ./backend/node_modules/
COPY --from=frontend-builder /app/frontend/out/ ./frontend/out/

RUN mkdir -p /app/backend/data

EXPOSE 3000

CMD ["node", "backend/server.js"]
