// HPC 作业分析工作台 — Web 服务
// 统一入口：对话、会话、作业、任务、证据、工单、数据连接
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { agentChat, cfg, tools, validateTicketAction, llmFetch } from './agent.mjs';
import { analyze, loadJobs, getAnalysis } from './analyze.mjs';
import * as store from './store.mjs';
import { checkCreds, getToken, runWithHpc } from './hpc_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.PORT || 8899);

// 启动：初始化 DB + 标记中断任务
store.getDB();
store.markInterruptedTasks();

// ===== 会话 Cookie 辅助 =====
const COOKIE_NAME = 'hpc_sid';
// Cookie 有效期 12 小时（与 HPC token 一致）；非本地回环时加 Secure
function cookieOpts(req) {
  const host = (req.headers.host || '').split(':')[0];
  const secure = !(host === '127.0.0.1' || host === 'localhost') ? '; Secure' : '';
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 3600}` + secure;
}
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// 返回当前请求对应的登录会话（未登录/已过期返回 null）
function currentLogin(req) {
  const sid = parseCookies(req)[COOKIE_NAME];
  if (!sid) return null;
  const s = store.getLoginSession(sid);
  if (!s) return null;
  // token 已过期且无法刷新 → 视为未登录（对话时会自动重取）
  return { sid, ...s };
}

// 会话归属校验：返回 { ok, session }。
// 会话属于该用户（owner===username）→ ok；否则 404（隐藏存在性）。
function ownSession(req, id) {
  const login = currentLogin(req);
  const s = store.getSessionMeta(id);
  if (!s) return { ok: false, code: 404, reason: '会话不存在' };
  if (!login) return { ok: false, code: 401, reason: '未登录' };
  if (s.owner === login.username) return { ok: true, session: s, login };
  return { ok: false, code: 404, reason: '会话不存在' };
}

// 任务归属校验
function ownTask(req, id) {
  const login = currentLogin(req);
  if (!login) return { ok: false, code: 401 };
  const t = store.getDB().prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!t) return { ok: false, code: 404 };
  if (t.owner !== login.username) return { ok: false, code: 404 };
  return { ok: true, task: t, login };
}

// 证据归属校验（直接 owner，或经所属任务/会话推断）
function ownEvidence(req, id) {
  const login = currentLogin(req);
  if (!login) return { ok: false, code: 401 };
  const ev = store.getEvidence(id);
  if (!ev) return { ok: false, code: 404 };
  if (ev.owner === login.username) return { ok: true, evidence: ev, login };
  // 无直接 owner：经任务校验
  if (ev.task_id) {
    const t = store.getDB().prepare('SELECT owner FROM tasks WHERE id=?').get(ev.task_id);
    if (t && t.owner === login.username) return { ok: true, evidence: ev, login };
  }
  // 经会话校验
  if (ev.session_id) {
    const s = store.getSessionMeta(ev.session_id);
    if (s && s.owner === login.username) return { ok: true, evidence: ev, login };
  }
  return { ok: false, code: 404 };
}

// 工单归属校验
function ownTicket(req, id) {
  const login = currentLogin(req);
  if (!login) return { ok: false, code: 401 };
  const t = store.getDB().prepare('SELECT * FROM tickets WHERE id=?').get(id);
  if (!t) return { ok: false, code: 404 };
  if (t.owner !== login.username) return { ok: false, code: 404 };
  return { ok: true, ticket: t, login };
}

// 后台任务执行器（进程内队列）
const runningTasks = new Map(); // taskId -> { abort: AbortController, timer }

async function executeTask(taskId, userMsg, days, conn) {
  const task = store.getTask(taskId);
  if (!task) return;
  const ac = new AbortController();
  runningTasks.set(taskId, { abort: ac });
  let stepSeq = 0;
  let fullReply = '';
  let evCounter = 0;
  try {
    // 后台任务启动时固定所属用户的 HPC 连接上下文，整个执行过程始终用该身份
    await runWithHpc(conn, async () => {
      for await (const ev of agentChat(store.getSessionHistory(task.session_id || ''), userMsg, { days })) {
        if (ac.signal.aborted) { store.updateTask(taskId, { status: 'cancelled', finished_at: new Date().toISOString() }); return; }
        if (ev.type === 'narrate') { stepSeq++; store.addTaskStep(taskId, stepSeq, 'narrate', ev.text); }
        if (ev.type === 'tool_done') {
          stepSeq++;
          // 生成证据
          const evId = store.createEvidence({
            taskId, sessionId: task.session_id, owner: task.owner, toolName: ev.name,
            query: JSON.stringify(ev.args || {}).slice(0, 200),
            window: task.days ? task.days + 'd' : '7d',
            source: 'local-cache', dataCollectedAt: null,
            keyFields: null, calculation: null,
            conclusion: (ev.result || '').slice(0, 500), kind: 'fact',
          });
          store.addTaskStep(taskId, stepSeq, 'tool_done', ev.name, (ev.result || '').slice(0, 2000), evId);
          evCounter++;
        }
        if (ev.type === 'text') fullReply += ev.text;
        if (ev.type === 'reasoning') { /* 不存步骤，但保留在回复里 */ }
      }
    });
    // 完成
    if (task.session_id) store.addMessage(task.session_id, 'assistant', fullReply.slice(0, 5000));
    store.updateTask(taskId, { status: 'completed', conclusion: fullReply.slice(0, 5000), finished_at: new Date().toISOString() });
  } catch (e) {
    if (ac.signal.aborted) store.updateTask(taskId, { status: 'cancelled', finished_at: new Date().toISOString() });
    else store.updateTask(taskId, { status: 'failed', error: e.needReauth ? '登录已过期，请重新登录后重试。' : e.message, finished_at: new Date().toISOString() });
  }
  runningTasks.delete(taskId);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, data, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  };
  try {
    // ===== 登录（HPC 认证成功后建立服务端会话 + HttpOnly Cookie）=====
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
      const { operator, password } = JSON.parse(body || '{}');
      if (!operator || !password) return send(400, { error: '请填写用户名和密码' });
      try {
        const BASE = (process.env.HPC_API_URL || '').replace(/\/$/, '');
        const authRes = await fetch(BASE + '/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: 'jaccount', operator, password }),
        });
        const text = await authRes.text();
        if (!authRes.ok) return send(401, { error: text || '用户名或密码错误' });
        // HPC 认证成功 → 解析 token 与用户身份
        const token = text.replace(/^Bearer\s+/, '');
        let username = operator, exp = Date.now() + 12 * 3600_000;
        try {
          const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
          exp = payload.exp * 1000;
          const sub = payload.sub || ''; // jaccount:wuying.hao
          if (sub.includes(':')) username = sub.split(':').pop();
        } catch {}
        // 建立服务端会话，HPC token 保存在服务端
        const sid = crypto.randomBytes(24).toString('hex');
        store.createLoginSession({ sid, username, hpc_token: token, token_exp: exp });
        return send(200, { username, expires: exp }, {
          'Set-Cookie': `${COOKIE_NAME}=${sid}; ${cookieOpts(req)}`,
        });
      } catch (e) {
        return send(500, { error: 'HPC 服务不可达: ' + e.message });
      }
    }

    // ===== 当前登录状态 =====
    if (url.pathname === '/api/auth/status') {
      const cur = currentLogin(req);
      if (!cur) return send(200, { logged_in: false });
      return send(200, { logged_in: true, username: cur.username, expires: cur.token_exp });
    }

    // ===== 退出登录 =====
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const cur = currentLogin(req);
      if (cur) store.deleteLoginSession(cur.sid);
      return send(200, { ok: true }, {
        'Set-Cookie': `${COOKIE_NAME}=; ${cookieOpts(req).replace(`Max-Age=${12 * 3600}`, 'Max-Age=0')}`,
      });
    }

    // ===== 对话（流式 NDJSON）=====
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
      const { session_id, message, model } = JSON.parse(body || '{}');
      // 对话需要登录（HPC token 从服务端会话读取，不再由前端携带）
      const login = currentLogin(req);
      if (!login) return send(401, { error: '未登录，请先登录 JAccount' });
      // 会话归属：引用已有 session_id 必须属于当前用户；否则新建并归属当前用户
      let sid;
      if (session_id) {
        const s = store.getSessionMeta(session_id);
        if (!s || s.owner !== login.username) return send(404, { error: '会话不存在或无权访问' });
        sid = session_id;
      } else {
        sid = store.createSession(message.slice(0, 20), login.username);
      }
      const hist = store.getSessionHistory(sid);
      store.addMessage(sid, 'user', message);
      // 更新会话标题
      if (hist.length === 0) store.renameSession(sid, message.slice(0, 30));

      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
      req.socket?.setNoDelay?.(true);
      let reply = '', reasoning = '', clientGone = false;
      let suggest = null;
      req.on('close', () => { clientGone = true; });
      const tick = () => new Promise(r => setImmediate(r));
      const write = (obj) => { try { if (!clientGone && !res.writableEnded) res.write(JSON.stringify(obj) + '\n'); } catch {} };

      // 以该登录用户的 HPC 连接上下文运行整个对话（含工具调用），按请求隔离
      const conn = { token: login.hpc_token, tokenExp: login.token_exp, operator: login.username, isServerUser: login.username === process.env.HPC_OPERATOR };
      await runWithHpc(conn, async () => {
        for await (const ev of agentChat(hist, message, { model })) {
          if (clientGone) break;
          if (ev.type === 'reasoning') { reasoning += ev.content; write({ t: 'reasoning', d: ev.content }); }
          if (ev.type === 'text') { reply += ev.text; write({ t: 'text', d: ev.text }); }
          if (ev.type === 'narrate') write({ t: 'narrate', d: ev.text });
          if (ev.type === 'batch_start') write({ t: 'batch_start', count: ev.count });
          if (ev.type === 'batch_end') write({ t: 'batch_end' });
          if (ev.type === 'tool_done') write({ t: 'tool', d: ev.name, result: (ev.result || '').slice(0, 2000) });
          if (ev.type === 'suggest') { suggest = ev.items; write({ t: 'suggest', items: ev.items }); }
          await tick();
        }
      });
      if (!clientGone) {
        store.addMessage(sid, 'assistant', reply, { reasoning: reasoning || undefined, suggest });
        const allMsgs = store.getSessionHistory(sid);
        const ctxPct = Math.min(100, Math.round(allMsgs.reduce((s, m) => s + (m.content || '').length, 0) / 1.6 / 32000 * 100));
        // 仅首轮对话用 LLM 生成会话标题
        if (hist.length === 0) {
          const title = await genSessionTitle(message, reply, model);
          if (title) {
            store.renameSession(sid, title);
            write({ t: 'title', title });
          }
        }
        res.end(JSON.stringify({ t: 'done', session_id: sid, context: ctxPct }) + '\n');
      }
      return;
    }

    // ===== 模型列表 =====
    if (url.pathname === '/api/models') {
      try {
        const r = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: 'Bearer ' + cfg.apiKey } });
        const d = await r.json();
        send(200, { models: (d.data || []).map(m => m.id).filter(Boolean), default: cfg.model });
      } catch {
        send(200, { models: ['qwen', 'deepseek-chat', 'deepseek-reasoner'], default: cfg.model });
      }
      return;
    }

    // ===== 分析快照 =====
    if (url.pathname === '/api/analysis') {
      const days = +(url.searchParams.get('days') || 7);
      const { r, cached, generatedAt } = getAnalysis(days);
      send(200, {
        total: r.total, done: r.done, counts: r.counts,
        cpuSec可用比例: r.cpuSecAvailable, 超时作业数: r.timeout_jobs, 运行时长P95h: r.longtail_p95h,
        waste: { 排队等待核时: +r.waste.wait_core_hours.toFixed(0), 失败核时: +r.waste.fail_core_hours.toFixed(0), CPU空闲核时: +r.waste.idle_core_hours.toFixed(0) },
        timeout_top: r.timeout_top.slice(0, 20),
        top_queue: r.top_queue.slice(0, 20).map(j => ({ id: j.id, name: j.name, 排队h: +(j.queue_sec / 3600).toFixed(1), state: j.state, partition: j.partition })),
        top_fail: r.top_fail.slice(0, 20),
        top_low_cpu: r.top_low_cpu.map(j => ({ id: j.id, name: j.name, partition: j.partition, util: j.util, 浪费核时: j.waste_core_h, 运行h: +(j.elapsed / 3600).toFixed(1) })),
        zero_cpu_long: r.zero_cpu_long,
        _cached: cached, _generatedAt: generatedAt, 口径: `近${days}天提交的作业`,
      });
      return;
    }

    // ===== 会话 CRUD（按当前登录用户隔离）=====
    if (url.pathname === '/api/sessions') {
      const login = currentLogin(req);
      const owner = login ? login.username : null;
      if (req.method === 'GET') {
        // 未登录 → 空列表（不泄露未归属历史）
        send(200, login ? store.listSessions({ q: url.searchParams.get('q'), owner }) : []);
        return;
      }
      if (req.method === 'POST') {
        if (!login) return send(401, { error: '未登录' });
        const body = JSON.parse(await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }));
        const id = store.createSession(body.title || '新会话', login.username);
        send(200, { id }); return;
      }
    }
    if (url.pathname.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      if (req.method === 'GET') {
        // 读取：必须是当前用户的会话（或自己的新会话）；否则 404
        const r = ownSession(req, id);
        if (!r.ok) return send(r.code, { error: r.reason });
        const s = store.getSession(id);
        send(s ? 200 : 404, s || {}); return;
      }
      if (req.method === 'PATCH') {
        const r = ownSession(req, id);
        if (!r.ok) return send(r.code, { error: r.reason });
        const body = JSON.parse(await new Promise(rr => { let b = ''; req.on('data', c => b += c); req.on('end', () => rr(b)); }));
        store.updateSession(id, body);
        send(200, { ok: true }); return;
      }
      if (req.method === 'DELETE') {
        const r = ownSession(req, id);
        if (!r.ok) return send(r.code, { error: r.reason });
        store.deleteSession(id); send(200, { ok: true }); return;
      }
    }

    // ===== 作业查询 =====
    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      const days = Math.min(30, +(url.searchParams.get('days') || 7));
      const state = url.searchParams.get('state') || '';
      const user = url.searchParams.get('user') || '';
      const partition = url.searchParams.get('partition') || '';
      const q = url.searchParams.get('q') || '';
      const page = +(url.searchParams.get('page') || 1);
      const size = Math.min(50, +(url.searchParams.get('size') || 20));
      let jobs = loadJobs(days);
      if (state) jobs = jobs.filter(j => j.state === state);
      if (user) jobs = jobs.filter(j => j.user === user);
      if (partition) jobs = jobs.filter(j => j.partition === partition);
      if (q) { const ql = q.toLowerCase(); jobs = jobs.filter(j => j.name?.toLowerCase().includes(ql) || String(j.id).includes(ql)); }
      jobs.sort((a, b) => (b.submit || 0) - (a.submit || 0));
      const total = jobs.length;
      const items = jobs.slice((page - 1) * size, page * size).map(j => ({
        id: j.id, name: j.name, user: j.user, partition: j.partition, state: j.state,
        submit: j.submit, start: j.start, end: j.end, elapsed: j.elapsed, cpu_req: j.cpu_req,
        mem_req: j.mem_req, limit: j.limit, cpu_sec: j.cpu_sec, exit: j.exit,
        运行h: +(j.elapsed / 3600).toFixed(1), limit_h: j.limit ? +(j.limit / 60).toFixed(1) : null,
      }));
      send(200, { total, page, size, items, 口径: `近${days}天提交的作业` });
      return;
    }
    // 作业详情 + 历史同名
    if (url.pathname.startsWith('/api/jobs/') && req.method === 'GET') {
      const jobId = +url.pathname.split('/').pop();
      const days = Math.min(30, +(url.searchParams.get('days') || 30));
      const jobs = loadJobs(days);
      const j = jobs.find(x => x.id === jobId);
      if (!j) { send(404, { error: '未找到' }); return; }
      const history = jobs.filter(x => x.user === j.user && x.name === j.name).sort((a, b) => (b.submit || 0) - (a.submit || 0)).slice(0, 10);
      const util = j.cpu_sec > 0 && j.elapsed > 0 && j.cpu_req > 0 ? +(j.cpu_sec / (j.elapsed * j.cpu_req) * 100).toFixed(1) : null;
      send(200, {
        id: j.id, name: j.name, user: j.user, partition: j.partition, state: j.state,
        submit: j.submit, start: j.start, end: j.end,
        提交: j.submit ? new Date(j.submit * 1000).toLocaleString('zh-CN') : null,
        开始: j.start > 0 && j.start < 4100000000 ? new Date(j.start * 1000).toLocaleString('zh-CN') : '未开始',
        结束: j.end > 0 && j.end < 4100000000 ? new Date(j.end * 1000).toLocaleString('zh-CN') : '运行中/未记录',
        排队分钟: j.start > j.submit && j.start < 4100000000 ? +((j.start - j.submit) / 60).toFixed(1) : null,
        运行小时: +(j.elapsed / 3600).toFixed(1),
        时限小时: j.limit ? +(j.limit / 60).toFixed(1) : null,
        申请核: j.cpu_req, 内存GB: j.mem_req ? +(j.mem_req / 1024).toFixed(1) : null,
        节点: j.node_req, CPU秒: +j.cpu_sec.toFixed(0),
        CPU利用率: util != null ? util + '%' : '不可评估',
        退出码: j.exit, 历史同名: history.length,
        口径: `近${days}天`, 数据更新: '本地缓存',
      });
      return;
    }

    // ===== 分析任务 =====
    if (url.pathname === '/api/tasks') {
      const login = currentLogin(req);
      const owner = login ? login.username : null;
      if (req.method === 'GET') { send(200, login ? store.listTasks({ owner }) : []); return; }
      if (req.method === 'POST') {
        const body = JSON.parse(await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }));
        // 后台任务会调用 HPC 工具，需登录；启动时固定所属用户身份
        if (!login) { send(401, { error: '未登录，请先登录 JAccount' }); return; }
        const conn = { token: login.hpc_token, tokenExp: login.token_exp, operator: login.username, isServerUser: login.username === process.env.HPC_OPERATOR };
        const id = 't-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        let sessionId;
        if (body.session_id) {
          const s = store.getSessionMeta(body.session_id);
          if (!s || s.owner !== login.username) { send(404, { error: '会话不存在或无权访问' }); return; }
          sessionId = body.session_id;
        } else {
          sessionId = store.createSession((body.title || '分析任务').slice(0, 20), login.username);
        }
        store.createTask({ id, title: body.title || '分析任务', sessionId, days: body.days || 7, owner: login.username });
        if (body.message) store.addMessage(sessionId, 'user', body.message);
        // 后台执行（固定该用户的连接上下文）
        executeTask(id, body.message || body.title, body.days || 7, conn);
        send(200, { id, session_id: sessionId });
        return;
      }
    }
    if (url.pathname.startsWith('/api/tasks/')) {
      const id = url.pathname.split('/')[3];
      const sub = url.pathname.split('/')[4];
      if (req.method === 'GET') {
        const r = ownTask(req, id);
        if (!r.ok) return send(r.code, { error: '任务不存在或无权访问' });
        const t = store.getTask(id);
        send(t ? 200 : 404, t || {}); return;
      }
      if (req.method === 'DELETE') {
        const r = ownTask(req, id);
        if (!r.ok) return send(r.code, { error: '任务不存在或无权访问' });
        store.deleteTask(id); send(200, { ok: true }); return;
      }
      if (sub === 'cancel' && req.method === 'POST') {
        const r = ownTask(req, id);
        if (!r.ok) return send(r.code, { error: '任务不存在或无权访问' });
        const rt = runningTasks.get(id);
        if (rt) rt.abort.abort();
        store.updateTask(id, { status: 'cancelled', finished_at: new Date().toISOString() });
        send(200, { ok: true }); return;
      }
    }

    // ===== 证据（按当前用户归属校验）=====
    if (url.pathname === '/api/evidence' && req.method === 'GET') {
      const login = currentLogin(req);
      if (!login) { send(200, []); return; }
      const taskId = url.searchParams.get('task_id');
      const sessionId = url.searchParams.get('session_id');
      // 通过任务/会话过滤时，先校验归属一致，再返回
      if (taskId) {
        const r = ownTask(req, taskId);
        if (!r.ok) { send(200, []); return; }
        send(200, store.listEvidence({ taskId }));
        return;
      }
      if (sessionId) {
        const s = store.getSessionMeta(sessionId);
        if (!s || s.owner !== login.username) { send(200, []); return; }
        send(200, store.listEvidence({ sessionId }));
        return;
      }
      // 无过滤 → 返回该用户全部证据
      send(200, store.listEvidence({ owner: login.username }));
      return;
    }
    if (url.pathname.startsWith('/api/evidence/') && req.method === 'GET') {
      const id = url.pathname.split('/').pop();
      const r = ownEvidence(req, id);
      if (!r.ok) return send(r.code, { error: '证据不存在或无权访问' });
      send(200, r.evidence);
      return;
    }

    // ===== 工单（按当前用户归属校验）=====
    if (url.pathname === '/api/tickets') {
      const login = currentLogin(req);
      const owner = login ? login.username : null;
      if (req.method === 'GET') {
        // 列表/搜索：未登录→空；已登录→只返回自己的
        send(200, login ? store.listTickets({ status: url.searchParams.get('status') || undefined, q: url.searchParams.get('q') || undefined, owner }) : []);
        return;
      }
      if (req.method === 'POST') {
        if (!login) { send(401, { error: '未登录，请先登录 JAccount' }); return; }
        const body = JSON.parse(await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }));
        // 关联任务/会话/证据：必须属于当前用户
        if (body.task_id) {
          const rt = ownTask(req, body.task_id);
          if (!rt.ok) { send(404, { error: '关联任务不存在或无权访问' }); return; }
        }
        if (body.session_id) {
          const s = store.getSessionMeta(body.session_id);
          if (!s || s.owner !== login.username) { send(404, { error: '关联会话不存在或无权访问' }); return; }
        }
        if (body.evidence_id) {
          const re = ownEvidence(req, body.evidence_id);
          if (!re.ok) { send(404, { error: '关联证据不存在或无权访问' }); return; }
        }
        // 关联作业：必须在当前用户有权访问的数据范围内（近30天本地缓存）
        const jobs = loadJobs(30);
        const job = body.job_id != null ? jobs.find(x => x.id === body.job_id) : null;
        if (body.job_id != null && !job) { send(404, { error: '关联作业不在可访问数据范围内' }); return; }
        // 状态校验
        if (body.action === 'suspend' || body.action === 'terminate') {
          const check = validateTicketAction(body.action, job || null, body.job_id);
          if (!check.allowed) { send(400, { rejected: true, reason: check.reason }); return; }
        }
        const id = 'TKT-' + Date.now().toString(36).toUpperCase();
        store.createTicket({ id, action: body.action, jobId: body.job_id, reason: body.reason, status: 'pending', owner: login.username, taskId: body.task_id, sessionId: body.session_id, evidenceId: body.evidence_id, conclusion: body.conclusion });
        send(200, { id });
        return;
      }
    }
    if (url.pathname.startsWith('/api/tickets/')) {
      const id = url.pathname.split('/')[3];
      const sub = url.pathname.split('/')[4];
      if (req.method === 'GET') {
        const r = ownTicket(req, id);
        if (!r.ok) return send(r.code, { error: '工单不存在或无权访问' });
        const t = store.getTicket(id); send(t ? 200 : 404, t || {}); return;
      }
      if (req.method === 'PATCH') {
        const r = ownTicket(req, id);
        if (!r.ok) return send(r.code, { error: '工单不存在或无权访问' });
        const body = JSON.parse(await new Promise(rr => { let b = ''; req.on('data', c => b += c); req.on('end', () => rr(b)); }));
        // 操作者由服务端当前身份填写
        store.updateTicket(id, { status: body.status, note: body.note, actor: r.login.username });
        send(200, { ok: true }); return;
      }
      if (req.method === 'DELETE') {
        const r = ownTicket(req, id);
        if (!r.ok) return send(r.code, { error: '工单不存在或无权访问' });
        store.deleteTicket(id); send(200, { ok: true }); return;
      }
      if (sub === 'events' && req.method === 'POST') {
        const r = ownTicket(req, id);
        if (!r.ok) return send(r.code, { error: '工单不存在或无权访问' });
        const body = JSON.parse(await new Promise(rr => { let b = ''; req.on('data', c => b += c); req.on('end', () => rr(b)); }));
        // 处理记录操作者由服务端当前身份填写，不信任前端传入的 actor
        store.updateTicket(id, { note: body.note || '处理记录', actor: r.login.username });
        send(200, { ok: true }); return;
      }
    }

    // ===== 数据与连接 =====
    if (url.pathname === '/api/status') {
      const dataDir = path.join(ROOT, 'data');
      const jobFiles = fs.readdirSync(dataDir).filter(f => /^jobs_\d{8}\.jsonl$/.test(f)).sort();
      const firstDay = jobFiles.length ? jobFiles[0].slice(5, 13) : null;
      const lastDay = jobFiles.length ? jobFiles[jobFiles.length - 1].slice(5, 13) : null;
      let lastFetch = null;
      if (jobFiles.length) {
        try { lastFetch = new Date(fs.statSync(path.join(dataDir, jobFiles[jobFiles.length - 1])).mtimeMs).toISOString(); } catch {}
      }
      const cacheDir = path.join(dataDir, 'cache');
      let analysisTime = null;
      try { const cf = fs.readdirSync(cacheDir).find(f => f.endsWith('.json')); if (cf) analysisTime = new Date(fs.statSync(path.join(cacheDir, cf)).mtimeMs).toISOString(); } catch {}
      let hpcOk = false, hpcErr = null;
      try { checkCreds(); hpcOk = true; } catch (e) { hpcErr = e.message; }
      send(200, {
        data: { 文件数: jobFiles.length, 覆盖范围: firstDay && lastDay ? `${firstDay} ~ ${lastDay}` : '无', 最近采集: lastFetch, 分析更新: analysisTime },
        hpc: { 已配置: hpcOk, 地址: hpcOk ? process.env.HPC_API_URL : '未配置', 错误: hpcErr },
        llm: { 已配置: !!(cfg.baseUrl && cfg.apiKey), 模型: cfg.model },
        uptime_s: Math.round(process.uptime()),
      });
      return;
    }
    if (url.pathname === '/api/check-connection' && req.method === 'POST') {
      // 触发连接检查（以当前登录用户的身份验证 HPC token 是否有效）
      const result = { hpc: { ok: false }, llm: { ok: false } };
      const login = currentLogin(req);
      try {
        const conn = login ? { token: login.hpc_token, tokenExp: login.token_exp, operator: login.username, isServerUser: login.username === process.env.HPC_OPERATOR } : null;
        if (login) await runWithHpc(conn, () => getToken()); else await getToken();
        result.hpc = { ok: true };
      } catch (e) {
        result.hpc = { ok: false, error: e.message.slice(0, 200), needReauth: !!e.needReauth };
      }
      try {
        const r = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: 'Bearer ' + cfg.apiKey }, signal: AbortSignal.timeout(10000) });
        result.llm = { ok: r.ok, status: r.status };
      } catch (e) { result.llm = { ok: false, error: e.message.slice(0, 200) }; }
      send(200, result);
      return;
    }
    if (url.pathname === '/api/fetch-data' && req.method === 'POST') {
      // 触发数据更新（复用 fetch_jobs 逻辑，后台执行；使用当前登录用户的连接拉取共享集群数据）
      const { fetchAndSave } = await import('./fetch_jobs.mjs');
      const login = currentLogin(req);
      const conn = login ? { token: login.hpc_token, tokenExp: login.token_exp, operator: login.username, isServerUser: login.username === process.env.HPC_OPERATOR } : null;
      if (fetchAndSave) {
        fetchAndSave({ conn }).then(r => console.log('fetch done:', r)).catch(e => console.error('fetch err:', e.message));
        send(200, { started: true });
      } else {
        send(501, { error: 'fetch 模块未导出 fetchAndSave，请用 CLI: npm run fetch' });
      }
      return;
    }

    // ===== 静态文件 =====
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const p = path.join(ROOT, 'web', path.normalize(file));
    if (!p.startsWith(path.join(ROOT, 'web')) || !fs.existsSync(p)) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(p);
    const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(fs.readFileSync(p));
  } catch (e) {
    if (!res.headersSent) { try { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('error: ' + e.message); } catch {} }
    else { try { res.end(); } catch {} }
    console.error('request error:', e.message);
  }
});

// 用 LLM 生成会话标题
async function genSessionTitle(userMsg, reply, model) {
  try {
    const res = await llmFetch({
      model: model || cfg.model, temperature: 0.3, max_tokens: 30,
      messages: [
        { role: 'system', content: '根据用户问题和助手回答，生成一个概括性的会话主题标签（4~10字，中文名词短语，如"超时作业排查""反复失败分析""集群资源概况""作业诊断"）。不要重复用户原话，不要标点、引号、问号。只输出主题。' },
        { role: 'user', content: userMsg.slice(0, 200) },
        { role: 'assistant', content: reply.slice(0, 500) },
      ],
    }, { retries: 1, timeoutMs: 15000 });
    if (!res.ok) return null;
    const data = await res.json();
    const title = (data.choices?.[0]?.message?.content || '').trim().replace(/[\"'。\.,!！?？]/g, '');
    return title ? title.slice(0, 16) : null;
  } catch { return null; }
}

process.on('uncaughtException', (e) => console.error('uncaughtException:', e.stack || e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', (e && e.stack) || e));
server.listen(PORT, '0.0.0.0', () => console.log(`hpc-agent workbench on :${PORT}`));
