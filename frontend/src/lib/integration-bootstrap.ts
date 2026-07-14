'use client';

// abu-api 集成模式引导：
// 1. 经 iframe 同源 cookie 调平台会话桥 /api/nova/session（注意：平台根路径，不加挂载前缀）
//    拿身份、能力开关与 relay_key（平台 session token，作为后续所有上游调用的 apiKey）
// 2. 调 /api/nova/models 拿当前分组可用模型，按启发式规则播种本地模型注册表
// 3. 播种完成后放行工作台渲染（IntegrationGate 控制）

import {
  BUILTIN_IMAGE_PRESETS,
  loadRegistry,
  saveRegistry,
  type ImageModelConfig,
  type NovaModelRegistry,
  type TextModelConfig,
} from '@/lib/nova-models';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';
import {
  notifyIntegrationUnauthorized,
  setIntegrationModels,
  setIntegrationSession,
  type IntegrationPermissions,
  type IntegrationSessionData,
} from '@/lib/integration';

export type IntegrationBootstrapStatus = 'ready' | 'unauthorized' | 'disabled' | 'error';

export interface IntegrationBootstrapResult {
  status: IntegrationBootstrapStatus;
  message?: string;
}

interface SessionResponse {
  success?: boolean;
  message?: string;
  data?: {
    id?: number;
    username?: string;
    display_name?: string;
    system_name?: string;
    logo?: string;
    relay_key?: string;
    permissions?: Record<string, unknown>;
  };
}

interface ModelsResponse {
  success?: boolean;
  message?: string;
  data?: unknown;
}

// ===== 平台模型 → nova 模型注册表 的启发式映射 =====

// Gemini 系原生图像模型（nano-banana 家族）：走 google 协议（generateContent + responseModalities）
const GOOGLE_IMAGE_PATTERN = /(gemini[\w.-]*image|nano[-_.]?banana)/i;
// 其余常见文生图模型：走 openai 协议（/v1/images/generations|edits，由平台按渠道适配）
const OPENAI_IMAGE_PATTERN = /(gpt-image|dall-e|dalle|flux|seedream|seededit|kolors|cogview|janus|stable-diffusion|sd3|sdxl|recraft|ideogram|hidream|qwen-image|grok[\w.-]*image|irag)/i;
// 明确不是对话模型的关键字（从文本模型候选中剔除）
const NON_TEXT_PATTERN = /(embed|embedding|rerank|moderation|tts|whisper|audio|realtime|video|sora|veo|kling|luma|wan[\w.-]*video|pixverse|runway|hailuo|vidu|suno|midjourney|mj_|image|imagen|dall-e|dalle|flux|seedream|seededit|kolors|cogview|janus|stable-diffusion|sd3|sdxl|recraft|ideogram|hidream|banana)/i;
// 文本默认模型优先级：偏好轻量对话模型，命中越靠前越优先
const PREFERRED_TEXT_PATTERNS = [
  /^gpt-4o-mini/i,
  /^gpt-4\.1-mini/i,
  /^gemini-2\.5-flash(?!.*image)/i,
  /^gemini-[\w.]*flash(?!.*image)/i,
  /^deepseek-chat/i,
  /^gpt-4o\b/i,
  /^claude[\w.-]*(haiku|sonnet)/i,
];

function classifyImageModel(modelName: string): 'google' | 'openai' | null {
  if (GOOGLE_IMAGE_PATTERN.test(modelName)) return 'google';
  if (OPENAI_IMAGE_PATTERN.test(modelName)) return 'openai';
  return null;
}

function isTextModelCandidate(modelName: string): boolean {
  return !NON_TEXT_PATTERN.test(modelName);
}

function textProtocolFor(modelName: string): TextProviderProtocol {
  if (/^gemini/i.test(modelName)) return 'google-gemini';
  if (/^claude/i.test(modelName)) return 'anthropic-messages';
  return 'openai-chat-completions';
}

function textModelRank(modelName: string): number {
  const index = PREFERRED_TEXT_PATTERNS.findIndex((re) => re.test(modelName));
  return index === -1 ? PREFERRED_TEXT_PATTERNS.length : index;
}

function buildImageModelConfig(modelName: string, apiKey: string, baseUrl: string): ImageModelConfig {
  const protocol = classifyImageModel(modelName) || 'openai';
  const preset = BUILTIN_IMAGE_PRESETS[modelName as keyof typeof BUILTIN_IMAGE_PRESETS];
  if (preset) {
    return {
      id: modelName,
      protocol: preset.protocol,
      name: preset.name,
      modelId: modelName,
      apiKey,
      baseUrl,
      builtinPreset: preset.id,
      maxRefImages: preset.maxRefImages,
      maxOutputSize: preset.maxOutputSize,
      supportsAdvancedParams: preset.supportsAdvancedParams,
    };
  }
  const isGptImage = /gpt-image/i.test(modelName);
  return {
    id: modelName,
    protocol,
    name: modelName,
    modelId: modelName,
    apiKey,
    baseUrl,
    builtinPreset: protocol === 'google' ? 'gemini-3-pro-image-preview' : 'gpt-image-2',
    maxRefImages: protocol === 'google' ? 3 : (isGptImage ? 16 : 3),
    maxOutputSize: isGptImage ? '4K' : '1K',
    supportsAdvancedParams: protocol === 'openai' && isGptImage,
  };
}

function buildTextModelConfig(modelName: string, apiKey: string, baseUrl: string): TextModelConfig {
  return {
    id: modelName,
    protocol: textProtocolFor(modelName),
    name: modelName,
    modelId: modelName,
    apiKey,
    baseUrl,
  };
}

/**
 * 用平台模型列表播种本地注册表：
 * - 平台已下线的模型移除；新增的模型追加
 * - 已存在的条目保留用户微调（名称/参考图上限/分辨率等），但 apiKey/baseUrl 一律
 *   刷成平台值（relay_key 每次登录会轮换）
 * - defaults 交由 saveRegistry 内的 ensureDefaults 自动校正
 */
export function seedRegistryFromPlatform(models: string[], relayKey: string, upstreamBaseUrl: string): void {
  const platformSet = new Set(models);
  const stored = loadRegistry();

  const imageNames = models.filter((name) => classifyImageModel(name) !== null);
  const textNames = models
    .filter((name) => classifyImageModel(name) === null && isTextModelCandidate(name))
    .sort((a, b) => textModelRank(a) - textModelRank(b) || a.localeCompare(b));

  const keptImage = stored.imageModels
    .filter((model) => platformSet.has(model.modelId))
    .map((model) => ({ ...model, apiKey: relayKey, baseUrl: upstreamBaseUrl }));
  const keptImageModelIds = new Set(keptImage.map((model) => model.modelId));
  const imageModels: ImageModelConfig[] = [
    ...keptImage,
    ...imageNames
      .filter((name) => !keptImageModelIds.has(name))
      .map((name) => buildImageModelConfig(name, relayKey, upstreamBaseUrl)),
  ];

  const keptText = stored.textModels
    .filter((model) => platformSet.has(model.modelId))
    .map((model) => ({ ...model, apiKey: relayKey, baseUrl: upstreamBaseUrl }));
  const keptTextModelIds = new Set(keptText.map((model) => model.modelId));
  const textModels: TextModelConfig[] = [
    ...keptText,
    ...textNames
      .filter((name) => !keptTextModelIds.has(name))
      .map((name) => buildTextModelConfig(name, relayKey, upstreamBaseUrl)),
  ];

  const next: NovaModelRegistry = {
    imageModels,
    textModels,
    defaults: stored.defaults,
  };
  saveRegistry(next);
}

function normalizePermissions(raw: Record<string, unknown> | undefined): IntegrationPermissions {
  return {
    enabled: raw?.enabled !== false,
    image: raw?.image !== false,
    image_edit: raw?.image_edit !== false,
    text: raw?.text !== false,
  };
}

/** 集成模式上游地址：平台公网入口的 nova relay 段（后端可用 NOVA_UPSTREAM_BASE_URL 覆写为内网地址） */
export function getIntegrationUpstreamBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/api/nova`;
}

export async function runIntegrationBootstrap(): Promise<IntegrationBootstrapResult> {
  let sessionPayload: SessionResponse;
  try {
    const response = await fetch('/api/nova/session', { cache: 'no-store' });
    if (response.status === 401) {
      notifyIntegrationUnauthorized();
      return { status: 'unauthorized', message: '请先登录平台后再使用 Nova 绘图工作台' };
    }
    if (response.status === 403) {
      return { status: 'disabled', message: 'Nova 绘图工作台暂未开放，请联系管理员启用' };
    }
    sessionPayload = (await response.json()) as SessionResponse;
    if (!response.ok || !sessionPayload?.success || !sessionPayload.data) {
      return { status: 'error', message: sessionPayload?.message || '无法获取平台会话' };
    }
  } catch {
    return { status: 'error', message: '无法连接平台，请确认从平台控制台进入' };
  }

  const data = sessionPayload.data;
  const permissions = normalizePermissions(data.permissions);
  if (!permissions.enabled) {
    return { status: 'disabled', message: 'Nova 绘图工作台暂未开放，请联系管理员启用' };
  }

  const relayKey = String(data.relay_key || '');
  if (!relayKey) {
    notifyIntegrationUnauthorized();
    return { status: 'unauthorized', message: '当前登录会话不支持集成调用，请退出后重新登录平台' };
  }

  const session: IntegrationSessionData = {
    userId: Number(data.id || 0),
    username: String(data.username || ''),
    displayName: String(data.display_name || data.username || ''),
    systemName: String(data.system_name || ''),
    logo: String(data.logo || ''),
    relayKey,
    permissions,
  };

  let models: string[] = [];
  try {
    const response = await fetch('/api/nova/models', { cache: 'no-store' });
    if (response.status === 403) {
      return { status: 'disabled', message: 'Nova 绘图工作台暂未开放，请联系管理员启用' };
    }
    const payload = (await response.json()) as ModelsResponse;
    if (!response.ok || !payload?.success || !Array.isArray(payload.data)) {
      return { status: 'error', message: payload?.message || '无法获取平台模型列表' };
    }
    models = (payload.data as unknown[]).filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return { status: 'error', message: '无法获取平台模型列表' };
  }

  setIntegrationSession(session);
  setIntegrationModels(models);
  seedRegistryFromPlatform(models, relayKey, getIntegrationUpstreamBaseUrl());

  return { status: 'ready' };
}
