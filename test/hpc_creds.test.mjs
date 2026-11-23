// 凭据管理 mock 验证：配置读取 → 认证头/参数组装 → 数据转换
// 运行：node --test test/hpc_creds.test.mjs
// 全程 mock global fetch，不发真实请求；只断言不打印凭据。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// 用假 env 值（在 spawn 前设置）加载模块，覆盖任何真实 .env
const FAKE = {
  HPC_API_URL: 'https://fake-hpc.test:8443/api',
  HPC_DOMAIN: 'fakedom',
  HPC_OPERATOR: 'fake.op',
  HPC_PASSWORD: 'fake-pass-123',
};

// mock fetch 请求记录
const calls = [];

describe('hpc_client 凭据管理（mock fetch）', () => {
  let client;

  before(async () => {
    for (const [k, v] of Object.entries(FAKE)) process.env[k] = v;
    // mock 全局 fetch
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      if (url.endsWith('/token')) {
        // 返回一个伪 JWT（exp 为未来时间）
        const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.' + payload + '.sig';
        return new Response('Bearer ' + jwt, { status: 200, statusText: 'OK' });
      }
      return new Response(JSON.stringify({ jobs: [{
        job_id: 42, name: 'fakejob', user: 'p-xxx', account: 'acc', partition: 'cpu', qos: 'normal',
        state: { current: ['COMPLETED'], reason: 'NONE' }, exit_code: { status: ['COMPLETED'] },
        time: {
          submission: 1700000000, start: 1700000100, end: 1700003700,
          elapsed: 3600, limit: { number: 60, unit: 'MINUTE' },
          system: { seconds: 1000, microseconds: 0 }, user: { seconds: 500, microseconds: 0 },
        },
        tres: { requested: [{ type: 'cpu', count: 4 }, { type: 'mem', count: 8192 }, { type: 'node', count: 1 }] },
        required: { CPUs: 4 },
      }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    client = await import('../src/hpc_client.mjs');
  });

  after(() => {
    // 清理
    delete globalThis.fetch;
    for (const k of Object.keys(FAKE)) delete process.env[k];
  });

  test('1. 配置从 env 读取（BASE 无尾斜杠）', async () => {
    // 触发一次请求，看 URL 是否用 env 的 base
    await client.api('/slurm/job/1');
    assert.ok(calls.length >= 1, '应有 fetch 调用');
    const tokenCall = calls.find(c => c.url.endsWith('/token'));
    assert.ok(tokenCall, '应有 token 请求');
    assert.equal(tokenCall.url, FAKE.HPC_API_URL + '/token');
    const jobCall = calls.find(c => c.url.endsWith('/slurm/job/1'));
    assert.equal(jobCall.url, FAKE.HPC_API_URL + '/slurm/job/1', 'job 请求 URL 应来自 env HPC_API_URL');
  });

  test('2. token 请求体 = env 凭据（domain/operator/password）', async () => {
    const tokenCall = calls.find(c => c.url.endsWith('/token'));
    const body = JSON.parse(tokenCall.opts.body);
    assert.deepEqual(body, { domain: FAKE.HPC_DOMAIN, operator: FAKE.HPC_OPERATOR, password: FAKE.HPC_PASSWORD });
    assert.equal(tokenCall.opts.method, 'POST');
    assert.equal(tokenCall.opts.headers['Content-Type'], 'application/json');
  });

  test('3. 业务请求带 Bearer 认证头，token 去掉 Bearer 前缀', async () => {
    await client.api('/slurmdb/jobs?start_time=1&end_time=2');
    const jobCall = calls.find(c => c.url.includes('/slurmdb/jobs'));
    const auth = jobCall.opts.headers.Authorization;
    assert.ok(auth.startsWith('Bearer '), '应有 Bearer 前缀');
    const tok = auth.slice(7);
    assert.ok(tok.split('.').length === 3, 'token 为伪 JWT 三段式');
    assert.ok(!tok.startsWith('Bearer'), 'token 不应含 Bearer 前缀');
  });

  test('4. token 缓存：短时间内重复调用不再请求 /token', async () => {
    const beforeCount = calls.filter(c => c.url.endsWith('/token')).length;
    await client.api('/slurm/job/2');
    const afterCount = calls.filter(c => c.url.endsWith('/token')).length;
    assert.equal(afterCount, beforeCount, 'token 有效期内应命中缓存，不再请求 /token');
  });

  test('5. compact 数据转换正确（limit 单位保持分钟）', () => {
    const raw = {
      job_id: 7, name: 'j', user: 'p-a', account: 'a', partition: 'gpu', qos: 'q',
      state: { current: ['RUNNING'], reason: 'NONE' }, exit_code: { status: [] },
      time: { submission: 1, start: 2, end: 3, elapsed: 100, limit: { number: 120, unit: 'MINUTE' },
        system: { seconds: 10, microseconds: 500000 }, user: { seconds: 20, microseconds: 0 } },
      tres: { requested: [{ type: 'cpu', count: 8 }, { type: 'mem', count: 16384 }] },
      required: { CPUs: 8 },
    };
    const c = client.compact(raw);
    assert.equal(c.id, 7);
    assert.equal(c.state, 'RUNNING');
    assert.equal(c.limit, 120, 'limit 保持分钟单位（原始 number），不做 ×60');
    assert.equal(c.elapsed, 100, 'elapsed 保持秒');
    assert.equal(c.cpu_req, 8);
    assert.equal(c.mem_req, 16384);
    assert.equal(c.node_req, 0);
    // cpu_sec = 10 + 20 + 0.5 = 30.5
    assert.ok(Math.abs(c.cpu_sec - 30.5) < 1e-9);
    assert.equal(c.submit, 1);
  });

  test('6. fetchRange 切片 + compact 端到端（3000s 窗口 → 1 片）', async () => {
    const jobs = await client.fetchRange(1700000000, 1700003000);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, 42);
    assert.equal(jobs[0].limit, 60, 'limit 单位仍是分钟');
    assert.ok(calls.some(c => c.url.includes('/slurmdb/jobs?start_time=1700000000&end_time=1700003000')), '应发出正确切片的查询');
  });

  test('7. 缺少配置时抛错且不发请求（子进程验证）', async () => {
    // 子进程方式：删掉 HPC_* env，且在临时目录放一份模块副本（父目录无真实 .env）
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpc-noenv-'));
    const modPath = path.resolve(new URL('../src/hpc_client.mjs', import.meta.url).pathname);
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.copyFileSync(modPath, path.join(tmp, 'src', 'hpc_client.mjs'));
    // 临时 .env 中不含 HPC_* 变量（模拟配置缺失）
    fs.writeFileSync(path.join(tmp, '.env'), '# empty\n');
    const scriptPath = path.join(tmp, 't.mjs');
    fs.writeFileSync(scriptPath, `
      for (const k of ['HPC_API_URL','HPC_DOMAIN','HPC_OPERATOR','HPC_PASSWORD']) delete process.env[k];
      let hit = false;
      globalThis.fetch = async () => { hit = true; return new Response('{}'); };
      const { getToken } = await import('./src/hpc_client.mjs');
      try {
        await getToken();
        console.log('FAIL:no-throw');
      } catch (e) {
        console.log(/HPC 配置缺失/.test(e.message) && !hit ? 'OK' : 'FAIL:' + e.message);
      }
    `);
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', env: { ...process.env, HPC_API_URL: '', HPC_DOMAIN: '', HPC_OPERATOR: '', HPC_PASSWORD: '' } });
    assert.match(out.trim(), /^OK$/, '缺少配置时应抛错且不发请求: ' + out);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---- token 401 刷新 / 403 不刷新（mock fetch 脚本化响应）----
  test('8. 业务 401 → 重新获取 token 并用新 token 重试成功', async () => {
    const origFetch = globalThis.fetch;
    let tokenN = 0;
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      if (url.endsWith('/token')) {
        tokenN += 1;
        const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, n: tokenN })).toString('base64url');
        return new Response('Bearer eyJ.eyJ' + payload + '.sig', { status: 200 });
      }
      const n = calls.filter(c => c.url.includes('/slurm/job/401case')).length;
      if (n === 1) return new Response('unauthorized', { status: 401 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    try {
      const r = await client.api('/slurm/job/401case');
      assert.equal(r.ok, true, '第二次请求应成功');
      const biz = calls.filter(c => c.url.includes('/slurm/job/401case'));
      assert.equal(biz.length, 2, '业务请求应为 2 次（401 后重试 1 次）');
      // 第一次业务请求（401）与重试之间应有一次新的 /token 刷新调用
      const b0idx = calls.findIndex(c => c.url.includes('/slurm/job/401case'));
      const b1idx = calls.findIndex((c, i) => i > b0idx && c.url.includes('/slurm/job/401case'));
      const newTokenBetween = calls.slice(b0idx, b1idx).some(c => c.url.endsWith('/token'));
      assert.ok(newTokenBetween, '401 与重试之间应重新请求 /token');
      assert.ok(tokenN >= 1, '应有至少 1 次刷新 /token 调用，实际 ' + tokenN);
      assert.notEqual(biz[0].opts.headers.Authorization, biz[1].opts.headers.Authorization, '重试应带刷新后的新 token');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('9. 连续 401 超过重试次数 → 抛错且 /token 调用次数有界', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      if (url.endsWith('/token')) {
        const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
        return new Response('Bearer eyJ.eyJ' + payload + '.sig', { status: 200 });
      }
      return new Response('unauthorized', { status: 401 });
    };
    const beforeTokens = calls.filter(c => c.url.endsWith('/token')).length;
    // 加速重试等待
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, 1);
    try {
      await assert.rejects(() => client.api('/slurm/job/always401', 3), /重试3次失败/);
      const tokenCalls = calls.filter(c => c.url.endsWith('/token')).length - beforeTokens;
      const bizCalls = calls.filter(c => c.url.includes('/slurm/job/always401')).length;
      assert.equal(bizCalls, 3, '业务请求应恰好 tries=3 次，不是无限');
      assert.ok(tokenCalls >= 1 && tokenCalls <= 3, '/token 刷新次数应有界（1~3）, 实际 ' + tokenCalls);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.fetch = origFetch;
    }
  });

  test('10. 403 权限不足 → 不刷新 token，立即抛错', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      if (url.endsWith('/token')) {
        const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
        return new Response('Bearer eyJ.eyJ' + payload + '.sig', { status: 200 });
      }
      return new Response('forbidden', { status: 403 });
    };
    const beforeTokens = calls.filter(c => c.url.endsWith('/token')).length;
    try {
      await assert.rejects(() => client.api('/slurm/job/forbidden'), /403/);
      const tokenCalls = calls.filter(c => c.url.endsWith('/token')).length - beforeTokens;
      // token 可能命中缓存（0 次）或最多 1 次（缓存过期后取一次），绝不刷新重试
      assert.ok(tokenCalls <= 1, '403 不应触发 token 刷新，实际新增 /token 调用 ' + tokenCalls);
      const bizCalls = calls.filter(c => c.url.includes('/slurm/job/forbidden')).length;
      assert.equal(bizCalls, 1, '403 应直接失败不重试');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
