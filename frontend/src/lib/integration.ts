'use client';

// abu-api 集成模式核心模块（叶子模块：不 import 其他业务 lib，避免循环依赖）。
// 构建期由 NEXT_PUBLIC_INTEGRATED_MODE / NEXT_PUBLIC_BASE_PATH 烧入，
// 独立部署（两变量均未设置）时全部逻辑为空操作。

export const IS_INTEGRATED = process.env.NEXT_PUBLIC_INTEGRATED_MODE === 'true';
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/+$/, '');

/** 前端调用自家后端（经 abu-api 反代透传完整路径）时统一加挂载前缀 */
export function apiPath(path: string): string {
  return BASE_PATH ? `${BASE_PATH}${path}` : path;
}

export interface IntegrationPermissions {
  enabled: boolean;
  image: boolean;
  image_edit: boolean;
  text: boolean;
}

export interface IntegrationSessionData {
  userId: number;
  username: string;
  displayName: string;
  systemName: string;
  relayKey: string;
  permissions: IntegrationPermissions;
}

let sessionData: IntegrationSessionData | null = null;
let platformModels: string[] = [];

export function setIntegrationSession(data: IntegrationSessionData | null): void {
  sessionData = data;
}

export function getIntegrationSession(): IntegrationSessionData | null {
  return sessionData;
}

export function setIntegrationModels(models: string[]): void {
  platformModels = Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m) : [];
}

export function getIntegrationModels(): string[] {
  return platformModels;
}

export function isIntegrationCapabilityEnabled(key: keyof Omit<IntegrationPermissions, 'enabled'>): boolean {
  if (!IS_INTEGRATED) return true;
  const permissions = sessionData?.permissions;
  if (!permissions) return true;
  return permissions[key] !== false;
}

// ===== 与宿主（abu-api 控制台 iframe 父页面）的 postMessage 通信 =====
// 集成部署下 iframe 与宿主同源，targetOrigin 用自身 origin 即可。

function postToHost(type: string, extra?: Record<string, unknown>): void {
  if (!IS_INTEGRATED || typeof window === 'undefined') return;
  if (window.parent === window) return;
  try {
    window.parent.postMessage({ type, ...extra }, window.location.origin);
  } catch {
    // 宿主不存在或被浏览器拦截时静默
  }
}

export function notifyIntegrationReady(): void {
  postToHost('nova:ready');
}

// 同类信号做节流，避免并行任务批量失败时向宿主刷屏（宿主会跳转/弹提示）
const SIGNAL_THROTTLE_MS = 5000;
const lastSignalAt = new Map<string, number>();

function postThrottled(type: string): void {
  const now = Date.now();
  const last = lastSignalAt.get(type) || 0;
  if (now - last < SIGNAL_THROTTLE_MS) return;
  lastSignalAt.set(type, now);
  postToHost(type);
}

export function notifyIntegrationUnauthorized(): void {
  postThrottled('nova:unauthorized');
}

export function notifyIntegrationQuotaInsufficient(): void {
  postThrottled('nova:quota-insufficient');
}

// ===== 错误信号识别 =====
// 平台网关的鉴权/额度错误经 nova 后端转发后只剩文本：
// - 图片任务失败：task.error 形如 "API 请求失败: 401 {...登录状态已失效...}"
// - 文本代理失败：readHttpError 拼出 "401 Unauthorized: ..." / "403 ...额度不足..."
// 据此做保守的模式匹配，命中后向宿主发信号（宿主负责跳登录/充值）。

const UNAUTHORIZED_PATTERNS = [
  /API 请求失败:\s*401\b/,
  /^401[\s:]/,
  /\b401 unauthorized\b/i,
  /登录状态已失效/,
  /访问凭证/,
  /请重新登录/,
  /invalid session/i,
];

const QUOTA_PATTERNS = [
  /额度不足/,
  /余额不足/,
  /quota is not enough/i,
  /insufficient[_\s]?(user[_\s]?)?quota/i,
  /quota[_\s]?insufficient/i,
  /已欠费/,
];

export function reportIntegrationErrorSignal(message: string | undefined | null): void {
  if (!IS_INTEGRATED || !message) return;
  const msg = String(message);
  if (UNAUTHORIZED_PATTERNS.some((re) => re.test(msg))) {
    notifyIntegrationUnauthorized();
    return;
  }
  if (QUOTA_PATTERNS.some((re) => re.test(msg))) {
    notifyIntegrationQuotaInsufficient();
  }
}

// ===== 宿主主题跟随 =====
// 宿主发 { type: 'abu:theme-change', theme: 'dark' | 'light' }，
// 与站内 ThemeToggle 同一套 data-theme + localStorage 约定。

export function applyHostTheme(theme: unknown): void {
  if (theme !== 'dark' && theme !== 'light') return;
  try {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  } catch {
    // storage 不可用时仅设置属性
  }
}

export function setupHostThemeListener(): () => void {
  if (!IS_INTEGRATED || typeof window === 'undefined') return () => {};
  const handler = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as { type?: string; theme?: string } | null;
    if (data?.type === 'abu:theme-change') {
      applyHostTheme(data.theme);
    }
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}
