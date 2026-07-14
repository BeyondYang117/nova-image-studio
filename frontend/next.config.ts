import type { NextConfig } from "next";
import path from "node:path";
import fs from "node:fs";
import withPWA from "next-pwa";

const dev = process.env.NODE_ENV !== "production";

// 从根目录 package.json 读取版本号，编译时自动注入
const rootPkgPath = path.join(__dirname, "..", "package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf-8"));
const appVersion = rootPkg.version || "0.0.0";

// abu-api 集成模式（构建期烧入）：
// - NEXT_PUBLIC_BASE_PATH：挂载子路径（如 /nova-app），静态资源与路由统一加前缀，
//   需与后端 NOVA_BASE_PATH 一致
// - NEXT_PUBLIC_INTEGRATED_MODE=true：iframe 内运行，禁用 PWA/Service Worker
//   （避免与宿主站点的 SW 作用域纠缠，iframe 场景也无安装意义）
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");
const integratedMode = process.env.NEXT_PUBLIC_INTEGRATED_MODE === "true";

const nextConfig: NextConfig = {
  // 显式声明追踪根目录，避免 Next.js 16 在 monorepo/多 lockfile 场景下产生警告
  outputFileTracingRoot: path.join(__dirname),
  // 仅在生产构建时启用静态导出，开发模式关闭以支持 HMR 热更新
  ...(dev ? {} : { output: "export" }),
  ...(basePath ? { basePath } : {}),
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  // 编译时自动注入版本号，前端通过 process.env.NEXT_PUBLIC_APP_VERSION 访问
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
  },
};

export default withPWA({
  dest: "public",
  disable: dev || integratedMode,
  register: true,
  skipWaiting: true,
})(nextConfig);
