// HPC API 客户端：token 管理 + slurmdb 查询
// 凭据从环境变量读取（.env），不再硬编码。
// HPC_API_URL  / HPC_DOMAIN / HPC_OPERATOR / HPC_PASSWORD
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';

// 与 src/agent.mjs 相同的轻量 .env 解析：已存在的 process.env 优先
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const BASE = (process.env.HPC_API_URL || '').replace(/\/$/, '');
const CREDS = { domain: process.env.HPC_DOMAIN || '', operator: process.env.HPC_OPERATOR || '', password: process.env.HPC_PASSWORD || '' };

export function checkCreds() {
  if (!BASE || !CREDS.domain || !CREDS.operator || !CREDS.password) {
    throw new Error('HPC 配置缺失：请在 .env 设置 HPC_API_URL / HPC_DOMAIN / HPC_OPERATOR / HPC_PASSWORD');
  }
}

// ===== 按请求隔离的连接上下文 =====
// 用 AsyncLocalStorage 把「当前登录用户的 HPC 连接」绑定到每个请求的异步任务链。
// 两个用户并发操作时，各自的请求/重试始终使用各自身份，互不串号。
const als = new AsyncLocalStorage();
export const runWithHpc = (conn, fn) => als.run(conn || null, fn);
export function currentHpc() { return als.getStore() || null; }

// 凭据失效 / 需重新登录（用户登录态失效，刷 token 无用）
export class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; this.needReauth = true; }
}

// 每个 conn 独立缓存刷新后的 token（多用户并发互不覆盖）
function _cached(c) { if (!c._cache) c._cache = {}; return c._cache; }

// 当前上下文是否允许「静默刷新 token」（= 有登录用户且其即服务端 .env 用户）
function connCanRefresh() {
  const conn = currentHpc();
  return !!(conn && conn.token && conn.isServerUser && CREDS.operator === conn.operator);
}

// 用一组 operator/password 向 HPC 换 token（登录态失效时抛 AuthError）
async function _fetchToken(domain, operator, password) {
  const res = await fetch(BASE + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, operator, password }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new AuthError('HPC 凭据失效，请重新登录');
    throw new Error('token fail: ' + res.status + ' ' + text.slice(0, 200));
  }
  const token = text.replace(/^Bearer\s+/, '');
  let exp = Date.now() + 11 * 3600_000;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    exp = payload.exp * 1000;
  } catch {}
  return { token, exp };
}

// 取当前上下文里可用的 token。无用户连接（如 CLI/后台服务）时回退到 .env 凭据。
export async function getToken() {
  const conn = currentHpc();
  if (conn && conn.token) {
    if (conn.tokenExp && conn.tokenExp > Date.now() + 60_000) return conn.token; // 未过期
    // 过期：若该用户是服务端自身 .env 用户 → 可静默刷新（jaccount 只读）；否则需重新登录
    if (connCanRefresh()) {
      const c = _cached(conn);
      if (c.token && c.exp > Date.now() + 60_000) return c.token;
      const fresh = await _fetchToken(CREDS.domain, CREDS.operator, CREDS.password);
      c.token = fresh.token; c.exp = fresh.exp;
      return fresh.token;
    }
    throw new AuthError('HPC 会话已过期，请重新登录');
  }
  // 无登录上下文（CLI / 后台服务凭据）
  checkCreds();
  const c = _cached({});
  if (c.token && c.exp > Date.now() + 60_000) return c.token;
  const fresh = await _fetchToken(CREDS.domain, CREDS.operator, CREDS.password);
  c.token = fresh.token; c.exp = fresh.exp;
  return fresh.token;
}

async function api(path, tries = 4) {
  let token = await getToken();
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + path, {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        if (res.status === 401) {
          // 认证失败：若可刷新则重取新 token 再试；否则为凭据失效 → 需重新登录
          if (connCanRefresh()) { token = await getToken(); continue; }
          const e = new AuthError('HPC 凭据失效，请重新登录');
          e.noRetry = true;
          throw e;
        }
        const err = new Error(`GET ${path} -> ${res.status}: ${body}`);
        err.status = res.status;
        // 4xx（如 403 权限不足）：刷 token 也无用，标记不重试
        if (res.status >= 400 && res.status < 500) err.noRetry = true;
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e.noRetry) break; // 4xx / 凭据失效：直接失败，不重试不等待
      await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw new Error(`GET ${path} 重试${tries}次失败: ${lastErr?.message}`);
}

// 拉取失败时把窗口对半拆分重试
async function apiChunked(path) {
  try {
    return await api(path);
  } catch (e) {
    if (e.name === 'AuthError') throw e; // 凭据失效不拆窗口，直接抛
    const m = path.match(/start_time=(\d+)&end_time=(\d+)/);
    if (!m) throw e;
    const s = +m[1], en = +m[2];
    if (en - s <= 1200) throw e;
    const mid = Math.floor((s + en) / 2);
    const a = await apiChunked(path.replace(/end_time=\d+/, `end_time=${mid}`));
    const b = await apiChunked(path.replace(/start_time=\d+/, `start_time=${mid}`));
    return { jobs: [...(a.jobs || []), ...(b.jobs || [])] };
  }
}

// 压缩作业记录为紧凑字段
function compact(j) {
  const t = j.time || {};
  const tres = (j.tres && j.tres.requested) || [];
  const req = {};
  for (const r of tres) req[r.type] = r.count;
  const sys = t.system || {}, usr = t.user || {};
  return {
    id: j.job_id,
    name: j.name,
    user: j.user,
    account: j.account,
    partition: j.partition,
    qos: j.qos,
    state: (j.state && j.state.current && j.state.current[0]) || '',
    reason: (j.state && j.state.reason) || '',
    exit: (j.exit_code && j.exit_code.status) || [],
    submit: t.submission || 0,
    start: t.start || 0,
    end: t.end || 0,
    elapsed: t.elapsed || 0,        // 秒
    limit: (t.limit && t.limit.number) || 0, // 时限（**单位：分钟**），0=无限。用时需 ×60 转秒
    cpu_req: req.cpu || (j.required && j.required.CPUs) || 0,
    mem_req: req.mem || 0,          // MB
    node_req: req.node || 0,
    cpu_sec: (sys.seconds || 0) + (usr.seconds || 0) + ((sys.microseconds || 0) + (usr.microseconds || 0)) / 1e6,
  };
}

// 拉取 [startSec, endSec]，按 50min 切片（API 限制 ≤1h），失败自动对半拆
export async function fetchRange(startSec, endSec, { onProgress, conn } = {}) {
  const CH = 3000;
  const out = [];
  const run = (fn) => conn ? runWithHpc(conn, fn) : fn();
  for (let s = startSec; s < endSec; s += CH) {
    const e = Math.min(s + CH, endSec);
    const d = await run(() => apiChunked(`/slurmdb/jobs?start_time=${s}&end_time=${e}`));
    const jobs = (d.jobs || []).map(compact);
    out.push(...jobs);
    if (onProgress) onProgress(e, jobs.length);
    await new Promise(r => setTimeout(r, 200));
  }
  return out;
}

export { compact, api };
