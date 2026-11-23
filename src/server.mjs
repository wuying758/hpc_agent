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
import { checkCreds } from './hpc_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.PORT || 8899);

// 启动：初始化 DB + 标记中断任务
store.getDB();
store.markInterruptedTasks();

// 后台任务执行器（进程内队列）
const runningTasks = new Map(); // taskId -> { abort: AbortController, timer }

async function executeTask(taskId, userMsg, days) {
  const task = store.getTask(taskId);
  if (!task) return;
  const ac = new AbortController();
  runningTasks.set(taskId, { abort: ac });
  let stepSeq = 0;
  let fullReply = '';
  let evCounter = 0;
  try {
    for await (const ev of agentChat(store.getSessionHistory(task.session_id || ''), userMsg, { days })) {
      if (ac.signal.aborted) { store.updateTask(taskId, { status: 'cancelled', finished_at: new Date().toISOString() }); return; }
      if (ev.type === 'narrate') { stepSeq++; store.addTaskStep(taskId, stepSeq, 'narrate', ev.text); }
      if (ev.type === 'tool_done') {
        stepSeq++;
        // 生成证据
        const evId = store.createEvidence({
          taskId, sessionId: task.session_id, toolName: ev.name,
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
    // 完成
    if (task.session_id) store.addMessage(task.session_id, 'assistant', fullReply.slice(0, 5000));
    store.updateTask(taskId, { status: 'completed', conclusion: fullReply.slice(0, 5000), finished_at: new Date().toISOString() });
  } catch (e) {
    if (ac.signal.aborted) store.updateTask(taskId, { status: 'cancelled', finished_at: new Date().toISOString() });
    else store.updateTask(taskId, { status: 'failed', error: e.message, finished_at: new Date().toISOString() });
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
    // ===== 对话（流式 NDJSON）=====
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
      const { session_id, message, model } = JSON.parse(body || '{}');
      const sid = session_id || store.createSession(message.slice(0, 20));
      const hist = store.getSessionHistory(sid);
      store.addMessage(sid, 'user', message);
      // 更新会话标题
      if (hist.length === 0) store.renameSession(sid, message.slice(0, 30));

      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
      req.socket?.setNoDelay?.(true);
      let reply = '', reasoning = '', clientGone = false;
      req.on('close', () => { clientGone = true; });
      const tick = () => new Promise(r => setImmediate(r));
      const write = (obj) => { try { if (!clientGone && !res.writableEnded) res.write(JSON.stringify(obj) + '\n'); } catch {} };

      for await (const ev of agentChat(hist, message, { model })) {
        if (clientGone) break;
        if (ev.type === 'reasoning') { reasoning += ev.content; write({ t: 'reasoning', d: ev.content }); }
        if (ev.type === 'text') { reply += ev.text; write({ t: 'text', d: ev.text }); }
        if (ev.type === 'narrate') write({ t: 'narrate', d: ev.text });
        if (ev.type === 'batch_start') write({ t: 'batch_start', count: ev.count });
        if (ev.type === 'batch_end') write({ t: 'batch_end' });
        if (ev.type === 'tool_done') write({ t: 'tool', d: ev.name, result: (ev.result || '').slice(0, 2000) });
        if (ev.type === 'suggest') write({ t: 'suggest', items: ev.items });
        await tick();
      }
      if (!clientGone) {
        store.addMessage(sid, 'assistant', reply, { reasoning: reasoning || undefined });
        const allMsgs = store.getSessionHistory(sid);
        const ctxPct = Math.min(100, Math.round(allMsgs.reduce((s, m) => s + (m.content || '').length, 0) / 1.6 / 32000 * 100));
        // LLM 生成会话标题
        const title = await genSessionTitle(message, reply, model);
        if (title) {
          store.renameSession(sid, title);
          write({ t: 'title', title });
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

    // ===== 会话 CRUD =====
    if (url.pathname === '/api/sessions') {
      if (req.method === 'GET') { send(200, store.listSessions({ q: url.searchParams.get('q') })); return; }
      if (req.method === 'POST') {
        const body = JSON.parse(await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }));
        const id = store.createSession(body.title || '新会话');
        send(200, { id }); return;
      }
    }
    if (url.pathname.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      if (req.method === 'GET') { const s = store.getSession(id); send(s ? 200 : 404, s || {}); return; }
      if (req.method === 'PATCH') {
        const body = JSON.parse(await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }));
        if (body.title) store.renameSession(id, body.title);
        send(200, { ok: true }); return;
      }
      if (req.method === 'DELETE') { store.deleteSession(id); send(200, { ok: true }); return; }
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
        CPU利用率: util != null ? util + '%' : '不可评估（cpu_sec=0 零值不能证明空转）',
        退出码: j.exit, 历史同名: history.length,
        口径: `近${days}天`, 数据更新: '本地缓存',
      });
      return;
    }

    // ===== 分析任务 =====
    if (url.pathname === '/api/tasks') {
      if (req.method === 'GET') { send(200, store.listTasks()); return; }
      if (req.method === 'POST') {
        const body = JSON.parse(await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }));
        const id = 't-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        const sessionId = body.session_id || store.createSession((body.title || '分析任务').slice(0, 20));
        store.createTask({ id, title: body.title || '分析任务', sessionId, days: body.days || 7 });
        if (body.message) store.addMessage(sessionId, 'user', body.message);
        // 后台执行
        executeTask(id, body.message || body.title, body.days || 7);
        send(200, { id, session_id: sessionId });
        return;
      }
    }
    if (url.pathname.startsWith('/api/tasks/')) {
      const id = url.pathname.split('/')[3];
      const sub = url.pathname.split('/')[4];
      if (req.method === 'GET') { const t = store.getTask(id); send(t ? 200 : 404, t || {}); return; }
      if (req.method === 'DELETE') { store.deleteTask(id); send(200, { ok: true }); return; }
      if (sub === 'cancel' && req.method === 'POST') {
        const rt = runningTasks.get(id);
        if (rt) rt.abort.abort();
        store.updateTask(id, { status: 'cancelled', finished_at: new Date().toISOString() });
        send(200, { ok: true }); return;
      }
    }

    // ===== 证据 =====
    if (url.pathname === '/api/evidence' && req.method === 'GET') {
      const taskId = url.searchParams.get('task_id');
      const sessionId = url.searchParams.get('session_id');
      send(200, store.listEvidence({ taskId, sessionId }));
      return;
    }
    if (url.pathname.startsWith('/api/evidence/') && req.method === 'GET') {
      const id = url.pathname.split('/').pop();
      const ev = store.getEvidence(id);
      send(ev ? 200 : 404, ev || {});
      return;
    }

    // ===== 工单 =====
    if (url.pathname === '/api/tickets') {
      if (req.method === 'GET') {
        send(200, store.listTickets({ status: url.searchParams.get('status') || undefined, q: url.searchParams.get('q') || undefined }));
        return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }));
        // 状态校验
        if (body.action === 'suspend' || body.action === 'terminate') {
          const job = loadJobs(30).find(x => x.id === body.job_id);
          const check = validateTicketAction(body.action, job || null, body.job_id);
          if (!check.allowed) { send(400, { rejected: true, reason: check.reason }); return; }
        }
        const id = 'TKT-' + Date.now().toString(36).toUpperCase();
        store.createTicket({ id, action: body.action, jobId: body.job_id, reason: body.reason, status: 'pending', taskId: body.task_id, sessionId: body.session_id, evidenceId: body.evidence_id, conclusion: body.conclusion });
        send(200, { id });
        return;
      }
    }
    if (url.pathname.startsWith('/api/tickets/')) {
      const id = url.pathname.split('/')[3];
      const sub = url.pathname.split('/')[4];
      if (req.method === 'GET') { const t = store.getTicket(id); send(t ? 200 : 404, t || {}); return; }
      if (req.method === 'PATCH') {
        const body = JSON.parse(await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }));
        store.updateTicket(id, { status: body.status, note: body.note });
        send(200, { ok: true });
        return;
      }
      if (req.method === 'DELETE') { store.deleteTicket(id); send(200, { ok: true }); return; }
      if (sub === 'events' && req.method === 'POST') {
        const body = JSON.parse(await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }));
        store.updateTicket(id, { note: body.note || '处理记录', actor: body.actor || 'user' });
        send(200, { ok: true });
        return;
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
      try { hpcOk = checkCreds(); } catch (e) { hpcErr = e.message; }
      send(200, {
        data: { 文件数: jobFiles.length, 覆盖范围: firstDay && lastDay ? `${firstDay} ~ ${lastDay}` : '无', 最近采集: lastFetch, 分析更新: analysisTime },
        hpc: { 已配置: hpcOk, 地址: hpcOk ? process.env.HPC_API_URL : '未配置', 错误: hpcErr },
        llm: { 已配置: !!(cfg.baseUrl && cfg.apiKey), 模型: cfg.model },
        uptime_s: Math.round(process.uptime()),
      });
      return;
    }
    if (url.pathname === '/api/check-connection' && req.method === 'POST') {
      // 触发连接检查（HPC token 获取测试）
      const result = { hpc: { ok: false }, llm: { ok: false } };
      try {
        const { getToken } = await import('./hpc_client.mjs');
        await getToken();
        result.hpc = { ok: true };
      } catch (e) { result.hpc = { ok: false, error: e.message.slice(0, 200) }; }
      try {
        const r = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: 'Bearer ' + cfg.apiKey }, signal: AbortSignal.timeout(10000) });
        result.llm = { ok: r.ok, status: r.status };
      } catch (e) { result.llm = { ok: false, error: e.message.slice(0, 200) }; }
      send(200, result);
      return;
    }
    if (url.pathname === '/api/fetch-data' && req.method === 'POST') {
      // 触发数据更新（复用 fetch_jobs 逻辑，后台执行）
      const { fetchAndSave } = await import('./fetch_jobs.mjs');
      if (fetchAndSave) {
        fetchAndSave().then(r => console.log('fetch done:', r)).catch(e => console.error('fetch err:', e.message));
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
        { role: 'system', content: '根据用户问题生成一个简短的会话标题（≤ 14 字，中文，不要标点、不要引号）。只输出标题本身。' },
        { role: 'user', content: userMsg.slice(0, 200) },
      ],
    }, { retries: 1, timeoutMs: 15000 });
    if (!res.ok) return null;
    const data = await res.json();
    const title = (data.choices?.[0]?.message?.content || '').trim().replace(/[\"'。\.,!！?？]/g, '');
    return title ? title.slice(0, 20) : null;
  } catch { return null; }
}

process.on('uncaughtException', (e) => console.error('uncaughtException:', e.stack || e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', (e && e.stack) || e));
server.listen(PORT, '0.0.0.0', () => console.log(`hpc-agent workbench on :${PORT}`));
