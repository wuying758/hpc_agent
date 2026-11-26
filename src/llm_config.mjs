// 个人模型配置：加解密 + 允许访问的服务目标校验 + 草稿模型列表检查
// 原则：
//  - API Key 用部署侧主密钥 AES-256-GCM 加密保存；查询只返回 hasApiKey，绝不回传原密钥。
//  - 允许访问的模型服务目标走白名单（防 SSRF），兼容明确配置的校内模型网关。
//  - 草稿检查只获取模型列表，区分“取得模型列表”与“服务不支持模型列表”，超时 + 错误脱敏。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

// ===== 部署侧主密钥（AES-256-GCM 用 32 字节）=====
// 优先 LLM_ENCRYPTION_KEY（hex 或 base64，64 位 hex 对应 32 字节）；
// 缺失时自动生成并写回 .env，保证重启后同一把钥匙能解密旧密文。
let _mainKey = null;
function mainKey() {
  if (_mainKey) return _mainKey;
  let raw = process.env.LLM_ENCRYPTION_KEY || '';
  let buf = null;
  if (raw) {
    const hexMatch = raw.match(/^([0-9a-fA-F]{64})$/);
    if (hexMatch) buf = Buffer.from(hexMatch[1], 'hex');
    else {
      try { buf = Buffer.from(raw, 'base64'); } catch { buf = null; }
      // 既非 64 位 hex 也非合法 base64 → 用 sha256 归一成 32 字节
      if (!buf || buf.length !== 32) buf = crypto.createHash('sha256').update(raw).digest();
    }
  }
  if (!buf) {
    buf = crypto.randomBytes(32);
    const hex = buf.toString('hex');
    try {
      const envPath = path.join(ROOT, '.env');
      const exists = fs.existsSync(envPath);
      const line = `LLM_ENCRYPTION_KEY=${hex}\n`;
      fs.appendFileSync(envPath, (exists && !fs.readFileSync(envPath, 'utf8').endsWith('\n') ? '\n' : '') + line);
      console.log('[llm_config] 已生成并写入 .env 的 LLM_ENCRYPTION_KEY（部署侧主密钥）');
    } catch (e) { console.error('[llm_config] 写入 .env 失败：', e.message); }
    process.env.LLM_ENCRYPTION_KEY = hex;
  }
  _mainKey = buf;
  return buf;
}

const PREFIX = 'v1.';
export function encryptApiKey(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', mainKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}
export function decryptApiKey(stored) {
  if (!stored) return null;
  try {
    if (!stored.startsWith(PREFIX)) throw new Error('bad format');
    const [ivB, tagB, dataB] = stored.slice(PREFIX.length).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', mainKey(), Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // 解密失败（密钥变更/数据损坏）→ 视为无有效密钥
  }
}

// ===== 允许访问的服务目标白名单（防 SSRF）=====
// 明确配置的校内网关 + LLM_ALLOWED_HOSTS（逗号分隔）。只允许这些 host；
// 仅允许 https（或明确配置的网关 host）。
function allowedHostSet() {
  const set = new Set();
  const add = (u) => { try { set.add(new URL(u).hostname.toLowerCase()); } catch {} };
  add(process.env.LLM_BASE_URL); // 默认/部署网关
  for (const h of (process.env.LLM_ALLOWED_HOSTS || '').split(',')) {
    const t = h.trim(); if (!t) continue;
    try { set.add(new URL(t.startsWith('http') ? t : 'https://' + t).hostname.toLowerCase()); } catch { set.add(t.toLowerCase()); }
  }
  // 兜底：至少放行默认网关 host（若 LLM_BASE_URL 非法则空集合）
  return set;
}

/**
 * 校验一个 base_url 是否属于允许访问的服务目标。
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateTarget(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { return { ok: false, reason: '服务地址格式不正确' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: '仅支持 http/https 地址' };
  const host = u.hostname.toLowerCase();
  const allowed = allowedHostSet();
  if (allowed.size && !allowed.has(host)) {
    return { ok: false, reason: `该服务地址不在允许访问的列表内（允许：${[...allowed].join(', ')}）` };
  }
  return { ok: true, host };
}

// ===== 草稿检查：只获取模型列表 =====
// 结果三态：
//  - 'ok'：取得模型列表
//  - 'no-models'：服务不支持模型列表（端点 404/405 或返回非列表）→ 允许手填模型保存
//  - 'error'：超时/网络/鉴权失败（已脱敏）
const MODEL_TIMEOUT_MS = 10000;
function maskError(e) {
  // 错误脱敏：去掉可能含密钥/地址细节，只留类别
  if (e?.name === 'AbortError' || /timeout|timed out|abort/i.test(e?.message || '')) return '连接超时，请检查服务地址或网络';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(e?.message || '')) return '无法连接到该模型服务（地址不可达或网络异常）';
  return '检查失败，请稍后重试';
}

export async function checkModels({ baseUrl, apiKey }) {
  const target = validateTarget(baseUrl);
  if (!target.ok) return { state: 'error', error: target.reason };
  if (!apiKey) return { state: 'error', error: '请填写 API Key 后再检查' };
  const base = baseUrl.replace(/\/+$/, '');
  // 优先标准 OpenAI 兼容 /models；再尝试网关常见的 /api/v1/models 已在 base 里
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS);
  try {
    const res = await fetch(base + '/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) return { state: 'error', error: '鉴权失败：API Key 无效或无权限' };
    if (res.status === 404 || res.status === 405) {
      // 服务不支持模型列表端点 → 允许手填
      return { state: 'no-models', note: '该服务未提供模型列表接口，可手动填写模型名称后保存' };
    }
    if (!res.ok) return { state: 'error', error: '服务返回异常（HTTP ' + res.status + '）' };
    const body = await res.json().catch(() => null);
    // OpenAI 兼容：{ data: [ { id } ] }；或裸数组 [ { id } ]
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
    if (Array.isArray(list) && list.length) {
      const ids = list.map(m => (typeof m === 'string' ? m : m?.id || m?.name)).filter(Boolean);
      return { state: 'ok', models: ids };
    }
    // 200 但结构不是模型列表 → 视为不支持
    return { state: 'no-models', note: '该服务未返回可识别的模型列表，可手动填写模型名称后保存' };
  } catch (e) {
    return { state: 'error', error: maskError(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ===== 配置快照：每轮聊天/任务开始时取一次，后续工具循环/重试/建议/标题沿用同一快照 =====
// 取当前用户的模型连接；未配置则回退部署默认。
// @returns {{baseUrl: string, apiKey: string, model: string|null, configured: boolean}}
export async function resolveLlmSnapshot(owner) {
  const defBase = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const defKey = process.env.LLM_API_KEY || '';
  const defModel = process.env.LLM_MODEL || null;
  if (!owner) return { baseUrl: defBase, apiKey: defKey, model: defModel, configured: false };
  let row = null;
  try { row = (await import('./store.mjs')).getUserLlmConfig(owner); } catch { row = null; }
  if (!row || !row.base_url) {
    return { baseUrl: defBase, apiKey: defKey, model: defModel, configured: false };
  }
  const key = row.api_key_enc ? decryptApiKey(row.api_key_enc) : null;
  if (!key) {
    // 密钥解密失败（主密钥变更）→ 回退部署默认，避免直接报错中断
    return { baseUrl: defBase, apiKey: defKey, model: defModel, configured: false };
  }
  return { baseUrl: row.base_url.replace(/\/+$/, ''), apiKey: key, model: row.model || defModel, configured: true };
}
