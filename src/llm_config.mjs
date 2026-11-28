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
      fs.appendFileSync(envPath, (exists && !fs.readFileSync(envPath, 'utf8').endsWith('\n') ? '\n' : '') + line, { mode: 0o600 });
      console.log('[llm_config] 已生成并写入 .env 的 LLM_ENCRYPTION_KEY（部署侧主密钥）');
    } catch {
      const error = new Error('模型加密主密钥无法持久化，请部署方设置 LLM_ENCRYPTION_KEY 后重试');
      error.status = 503;
      throw error;
    }
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
// 只允许部署方配置的服务 origin（协议、主机与端口一起匹配）。
function allowedOrigins() {
  const origins = new Set();
  const add = value => {
    if (!value) return;
    try { origins.add(new URL(value.includes('://') ? value : 'https://' + value).origin); } catch {}
  };
  add(process.env.LLM_BASE_URL);
  for (const value of (process.env.LLM_ALLOWED_HOSTS || '').split(',')) add(value.trim());
  return origins;
}

export function validateTarget(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { return { ok: false, reason: '服务地址格式不正确' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: '仅支持 http/https 地址' };
  if (u.username || u.password || u.search || u.hash) return { ok: false, reason: '服务地址不能包含用户名、密码、查询参数或片段' };
  const allowed = allowedOrigins();
  if (!allowed.size) return { ok: false, reason: '部署方尚未设置允许的模型服务地址，请配置 LLM_ALLOWED_HOSTS' };
  if (!allowed.has(u.origin)) return { ok: false, reason: '该服务地址未获部署方允许，请联系管理员添加到 LLM_ALLOWED_HOSTS' };
  return { ok: true };
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
      redirect: 'error',
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
      const ids = [...new Set(list.map(m => (typeof m === 'string' ? m : m?.id || m?.name)).filter(id => typeof id === 'string' && id.trim()))];
      if (ids.length) return { state: 'ok', models: ids };
    }
    // 200 但结构不是模型列表 → 视为不支持
    return { state: 'no-models', note: '该服务未返回可识别的模型列表，可手动填写模型名称后保存' };
  } catch (e) {
    return { state: 'error', error: maskError(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Web 请求必须使用该账号的个人配置；CLI 仍可直接使用 agent.mjs 的部署配置。
export async function resolveLlmSnapshot(owner) {
  const { getUserLlmConfig } = await import('./store.mjs');
  const row = owner ? getUserLlmConfig(owner) : null;
  const key = row?.api_key_enc ? decryptApiKey(row.api_key_enc) : null;
  if (!row?.base_url || !row.model || !key) {
    const error = new Error('请先在设置 → 模型 API 中保存服务地址、API Key 和默认模型');
    error.status = 422;
    error.code = 'MODEL_NOT_CONFIGURED';
    throw error;
  }
  const target = validateTarget(row.base_url);
  if (!target.ok) {
    const error = new Error(target.reason);
    error.status = 422;
    throw error;
  }
  return { baseUrl: row.base_url.replace(/\/+$/, ''), apiKey: key, model: row.model, configured: true, version: row.version };
}
