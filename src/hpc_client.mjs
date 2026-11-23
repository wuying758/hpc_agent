// HPC API 客户端：token 管理 + slurmdb 查询
// 凭据从环境变量读取（.env），不再硬编码。
// HPC_API_URL  / HPC_DOMAIN / HPC_OPERATOR / HPC_PASSWORD
import fs from 'node:fs';
import path from 'node:path';
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

let cached = null; // { token, exp }

export async function getToken() {
  checkCreds();
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch(BASE + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(CREDS),
  });
  if (!res.ok) throw new Error('token fail: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const text = await res.text();
  const token = text.replace(/^Bearer\s+/, '');
  let exp = Date.now() + 11 * 3600_000;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    exp = payload.exp * 1000;
  } catch {}
  cached = { token, exp };
  return token;
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
          // 认证失败：清缓存并重新获取新 token，下轮迭代用新 token 重试
          cached = null;
          token = await getToken();
          continue;
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
      if (e.noRetry) break; // 4xx（非 401）直接失败，不重试不等待
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
export async function fetchRange(startSec, endSec, { onProgress } = {}) {
  const CH = 3000;
  const out = [];
  for (let s = startSec; s < endSec; s += CH) {
    const e = Math.min(s + CH, endSec);
    const d = await apiChunked(`/slurmdb/jobs?start_time=${s}&end_time=${e}`);
    const jobs = (d.jobs || []).map(compact);
    out.push(...jobs);
    if (onProgress) onProgress(e, jobs.length);
    await new Promise(r => setTimeout(r, 200));
  }
  return out;
}

export { compact, api };
