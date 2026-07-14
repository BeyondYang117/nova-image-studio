import type { NovaTaskResponse, NovaTaskStatus } from '@/lib/ccode-task-client';
import { reportIntegrationErrorSignal } from '@/lib/integration';

export type FailureReason = 'restart' | 'expired' | 'api' | 'network' | 'rate_limit' | 'queue_full' | 'unknown';

export interface FailureClassification {
  /** true 表示后端已经明确判定不可恢复，前端不应再展示"查看进度"按钮 */
  terminal: boolean;
  reason: FailureReason;
}

const SERVER_RESTART_MARKERS = [
  '服务器重启，任务已中断',
  '服务器重启，任务已中断，请重新生成',
];

const API_FAILURE_PATTERNS = [
  /^API 请求失败:\s*\d{3}/,
  /^所有图片生成失败/,
  /响应中无图片数据/,
];

const RATE_LIMIT_MARKERS = [
  '请求太频繁',
];

const QUEUE_FULL_MARKERS = [
  '当前排队任务较多',
  '你已有较多任务正在排队或生成',
  '暂不接受新任务',
];

// 网络/超时关键字（覆盖前端 fetch 抛出的英文消息和 normalizeError 改写后的中文消息）
const NETWORK_ERROR_FRAGMENTS = [
  'failed to fetch',
  'fetch failed',
  'networkerror',
  'network request failed',
  'load failed',
  'network connection was lost',
  'econnreset',
  'socket hang up',
  'terminated',
  '网络连接失败',
  '网络连接',
];

const TIMEOUT_ERROR_FRAGMENTS = [
  'timeout',
  'timed out',
  'abort',
  '请求超时',
  '高分辨率图片生成需要更长时间',
];

function isServerRestartError(message: string): boolean {
  return SERVER_RESTART_MARKERS.some(marker => message.includes(marker));
}

function isApiFailureMessage(message: string): boolean {
  return API_FAILURE_PATTERNS.some(re => re.test(message));
}

function isRateLimitMessage(message: string): boolean {
  return RATE_LIMIT_MARKERS.some(marker => message.includes(marker));
}

function isQueueFullMessage(message: string): boolean {
  return QUEUE_FULL_MARKERS.some(marker => message.includes(marker));
}

function isNetworkErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return NETWORK_ERROR_FRAGMENTS.some(fragment => lower.includes(fragment.toLowerCase()));
}

function isTimeoutErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return TIMEOUT_ERROR_FRAGMENTS.some(fragment => lower.includes(fragment.toLowerCase()));
}

function classifyFailureMessage(message: string | undefined): FailureClassification {
  const msg = (message || '').trim();
  if (!msg) return { terminal: false, reason: 'unknown' };
  // 集成模式：任务失败文本里若携带平台的鉴权/额度错误，向宿主发信号（独立部署为空操作）
  reportIntegrationErrorSignal(msg);
  if (isServerRestartError(msg)) return { terminal: true, reason: 'restart' };
  if (isRateLimitMessage(msg)) return { terminal: true, reason: 'rate_limit' };
  if (isQueueFullMessage(msg)) return { terminal: true, reason: 'queue_full' };
  if (isNetworkErrorMessage(msg) || isTimeoutErrorMessage(msg)) return { terminal: false, reason: 'network' };
  if (isApiFailureMessage(msg)) return { terminal: true, reason: 'api' };
  return { terminal: false, reason: 'unknown' };
}

/**
 * 根据后端推送的任务状态判断失败是否"终态"。
 * - terminal=true 表示后端已经明确告诉我们任务无法恢复，前端不应再展示"查看进度"按钮
 * - terminal=false 表示可能是网络瞬态/前端解析问题，应该允许用户手动再查询一次后端状态
 */
export function classifyTaskFailure(task: Pick<NovaTaskResponse, 'status' | 'error'>): FailureClassification {
  const status = task.status as NovaTaskStatus;
  if (status === 'expired') return { terminal: true, reason: 'expired' };
  if (status !== 'failed') return { terminal: false, reason: 'unknown' };
  return classifyFailureMessage(task.error);
}

/**
 * 从前端已经构造好的错误消息（多数来自 socket fallback / HTTP 抛错）反推 terminal 标记。
 * 用于 useWorkspaceJobs.failJob 在没有完整 task 对象时也能合理设置 terminal。
 */
export function classifyFailureFromMessage(message: string | undefined): FailureClassification {
  return classifyFailureMessage(message);
}

/** 404 等价于任务已被删除/过期，不可恢复 */
export const TASK_NOT_FOUND_FAILURE: FailureClassification = { terminal: true, reason: 'expired' };
