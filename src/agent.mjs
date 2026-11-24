// 智能体核心：ReAct 循环 + 工具调用（OpenAI 兼容接口，"致远一号" API 到手后填 .env）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, loadJobs, getAnalysis } from './analyze.mjs';
import { api } from './hpc_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

export const cfg = {
  baseUrl: process.env.LLM_BASE_URL || '',
  apiKey: process.env.LLM_API_KEY || '',
  model: process.env.LLM_MODEL || 'zhiyuan-1',
};

function jobRow(j, extra = '') {
  const d = j.submit ? new Date(j.submit * 1000).toLocaleDateString('zh-CN') : '?';
  return `#${j.id} ${j.name} [${j.partition}/${j.state}] ${d} 申请${j.cpu_req}核 运行${Math.round(j.elapsed / 60)}min${extra}`;
}

// 工具用途说明（调用前先告诉用户这一步在干什么）
const TOOL_DESC = {
  cluster_overview: '拉取集群整体概况（作业量、状态分布、浪费核时）',
  top_wasters: '按类别拉取浪费最严重的作业清单',
  job_detail: '查看单个作业的详情（时间线、资源、利用率）',
  user_report: '按用户汇总资源消耗',
  create_ticket: '生成高危操作工单（不会直接执行，需人工确认）',
};
function toolNarrative(name, args) {
  const d = TOOL_DESC[name] || '调用工具';
  const a = args || {};
  const bits = [];
  if (a.category) bits.push({ timeout: '超时', queue: '排队过久', fail: '反复失败', low_cpu: 'CPU 低效', limit: '时限滥用', zero_cpu: '零 CPU', mem: '内存过高' }[a.category] || a.category);
  if (a.job_id != null) bits.push('#' + a.job_id);
  if (a.user) bits.push('用户 ' + String(a.user).slice(0, 12) + '…');
  if (a.action) bits.push({ suspend: '暂停', terminate: '终止', quota: '配额', contact_user: '联系用户' }[a.action] || a.action);
  if (a.days) bits.push(a.days + ' 天');
  return d + (bits.length ? '（' + bits.join(' · ') + '）' : '') + '…';
}

const tools = [
  {
    name: 'cluster_overview',
    description: '集群整体概况：作业总量、状态分布、低效统计、浪费核时汇总、超时/长尾情况',
    params: { days: { type: 'number', description: '统计天数，默认7；用户说“最近30天”就传30，范围 1~30' } },
    run: async ({ days = 7 }) => {
      const { r, byState, byPart } = getAnalysis(days);
      return { 天数: days, 作业总数: r.total, 已结束: r.done, 状态分布: byState, 分区作业数: byPart,
        低效命中数: r.counts, CPU秒可用比例: r.cpuSecAvailable,
        超时作业数: r.timeout_jobs, 运行时长P95小时: r.longtail_p95h,
        浪费核时: { 排队等待: +r.waste.wait_core_hours.toFixed(0), 反复失败: +r.waste.fail_core_hours.toFixed(0), CPU空闲: +r.waste.idle_core_hours.toFixed(0) } };
    },
  },
  {
    name: 'top_wasters',
    description: '浪费资源 Top-N 作业。类别: timeout(超时) / queue(排队过久) / fail(反复失败) / low_cpu(CPU利用率低) / limit(时限滥用) / zero_cpu(长时间运行无CPU记录) / mem(内存规格过高)',
    params: {
      category: { type: 'string', enum: ['timeout', 'queue', 'fail', 'low_cpu', 'limit', 'zero_cpu', 'mem'] },
      n: { type: 'number', description: '条数，默认10' },
      days: { type: 'number', description: '天数，默认7；用户指定“最近X天”就传X，范围 1~30' },
    },
    run: async ({ category, n = 10, days = 7 }) => {
      const r = analyze(loadJobs(days));
      const map = { timeout: 'timeout_top', queue: 'top_queue', fail: 'top_fail', low_cpu: 'top_low_cpu', limit: 'top_limit', zero_cpu: 'zero_cpu_long', mem: 'top_mem' };
      const list = (r[map[category]] || []).slice(0, n);
      if (category === 'zero_cpu' && (r.cpuSecAvailable ?? 0) < 0.2 && list.length === 0) {
        return { 提示: `CPU 秒记账覆盖率仅 ${(r.cpuSecAvailable * 100).toFixed(0)}%，cpu_sec=0 更可能是记账缺失而非空转，此类别当前不可用。请改用 timeout/queue/fail 等类别分析。` };
      }
      if (category === 'fail') return list;
      if (['timeout', 'zero_cpu'].includes(category)) return list;
      return list.map(j => jobRow(j,
        category === 'queue' ? ` 排队${Math.round(j.queue_sec / 3600)}h` :
        category === 'low_cpu' || category === 'mem' ? ` 利用率${(j.util * 100).toFixed(0)}% 浪费${j.waste_core_h}核时` :
        category === 'limit' ? ` 时限比${j.ratio}x` : ''));
    },
  },
  {
    name: 'job_detail',
    description: '单个作业详情（时间线、申请资源、利用率、退出码）',
    params: { job_id: { type: 'number', description: '作业ID' } },
    run: async ({ job_id }) => {
      const j = loadJobs(30).find(x => x.id === job_id);
      if (!j) return '本地缓存(30天)未找到，实时查询: ' + JSON.stringify(await api('/slurm/job/' + job_id)).slice(0, 800);
      const limitH = j.limit ? +(j.limit / 60).toFixed(1) : null;  // limit 单位是分钟，/60 得小时
      const elapsedH = +(j.elapsed / 3600).toFixed(1);
      const util = j.cpu_sec > 0 && j.elapsed > 0 && j.cpu_req > 0 ? j.cpu_sec / (j.elapsed * j.cpu_req) : null;
      return { 作业: jobRow(j),
        提交: j.submit ? new Date(j.submit * 1000).toLocaleString('zh-CN') : null,
        开始: j.start ? new Date(j.start * 1000).toLocaleString('zh-CN') : null,
        排队分钟: j.start > j.submit ? +((j.start - j.submit) / 60).toFixed(1) : null,
        运行小时: elapsedH,
        时限小时: limitH,
        申请: { 核: j.cpu_req, 内存GB: j.mem_req ? +(j.mem_req / 1024).toFixed(1) : null, 节点: j.node_req },
        CPU秒: +j.cpu_sec.toFixed(0),
        CPU利用率: util != null ? +(util * 100).toFixed(1) + '%' : '不可评估',
        状态: j.state, 退出码: j.exit, 用户: j.user };
    },
  },
  {
    name: 'user_report',
    description: '按用户汇总资源使用（不传 user 返回 Top 消耗用户榜；传 user 返回该用户明细）',
    params: { user: { type: 'string', description: '脱敏用户标识 p-xxx，可省略' }, days: { type: 'number', description: '默认7；用户指定“最近X天”就传X，范围 1~30' } },
    run: async ({ user, days = 7 }) => {
      const jobs = loadJobs(days);
      const agg = {};
      for (const j of jobs) {
        const a = (agg[j.user] ||= { 作业数: 0, 核时: 0, 失败: 0 });
        a.作业数++; a.核时 += j.elapsed * j.cpu_req / 3600;
        if (j.state === 'FAILED') a.失败++;
      }
      if (user) {
        const mine = jobs.filter(j => j.user === user);
        const coreSec = mine.reduce((s, j) => s + j.elapsed * j.cpu_req, 0);
        return { 用户: user, 作业数: mine.length, 总核时: +(coreSec / 3600).toFixed(1),
          作业清单: mine.slice(0, 30).map(j => jobRow(j)) };
      }
      return Object.entries(agg).map(([u, a]) => ({ 用户: u, 作业数: a.作业数, 总核时: +a.核时.toFixed(1), 失败: a.失败 }))
        .sort((a, b) => b.总核时 - a.总核时).slice(0, 15);
    },
  },
  {
    name: 'create_ticket',
    description: '为高危操作生成工单（suspend暂停/terminate终止/quota配额/contact_user联系用户）。只生成工单与依据，绝不执行，必须运维人工确认。注意：suspend/terminate 仅对白名单状态（RUNNING/PENDING/RESIZING/SUSPENDED）生效，其他状态（含终态、未知、OUT_OF_MEMORY、NODE_FAIL 等）会被拒绝。',
    params: {
      action: { type: 'string', enum: ['suspend', 'terminate', 'quota', 'contact_user'] },
      job_id: { type: 'number', description: '目标作业ID' },
      reason: { type: 'string', description: '操作依据（引用分析结论）' },
    },
    run: async ({ action, job_id, reason }) => {
      const actName = { suspend: '暂停作业', terminate: '终止作业', quota: '配额调整', contact_user: '联系用户' }[action];
      // 白名单校验：暂停/终止只对仍在占用资源的活跃作业有效
      if (action === 'suspend' || action === 'terminate') {
        const j = loadJobs(30).find(x => x.id === job_id);
        const check = validateTicketAction(action, j || null, job_id);
        if (!check.allowed) {
          return { 拒绝: true, 原因: check.reason + '（来自本地 30 天缓存记录）', 建议: '如需跟进请核查失败原因、优化后续时限配置，或使用 contact_user 联系用户说明。' };
        }
      }
      const ticket = { 工单号: 'TKT-' + Date.now().toString(36).toUpperCase(), 操作: actName,
        目标作业: job_id, 依据: reason, 状态: '待人工确认', 状态来源: '本地 30 天缓存（非实时）',
        生成时间: new Date().toLocaleString('zh-CN'),
        提示: '⚠️ 未执行任何操作，请运维在超算管理界面人工确认并执行。' };
      const dir = path.join(ROOT, 'data', 'tickets');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'tickets.jsonl'), JSON.stringify(ticket) + '\n');
      return ticket;
    },
  },
];

function toOpenAITools() {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name, description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k,
          { type: v.type, description: v.description, ...(v.enum ? { enum: v.enum } : {}) }])),
        required: Object.entries(t.params).filter(([, v]) => !('default' in v) && !v.description?.includes('可省略')).map(([k]) => k),
      },
    },
  }));
}

const SYSTEM_PROMPT = `你是"超算低效作业识别智能体"，服务于上海交通大学超算集群运维。
能力：通过工具查询 SLURM 作业数据、识别低效作业、估算资源浪费、给出优化建议。

【职责边界】你专注 SJTU 超算集群：作业状态、资源使用、低效识别、浪费核时、用户/分区分析、工单。
遇到范围外的请求（解数学题、写代码/文案/诗歌、闲聊、翻译、其他领域知识问答等），
不要生硬拒绝（避免“不帮你解”“不在服务范围就不解了”这类话），而是温和地说明自己是超算作业分析助手，
并热情引导用户问集群相关的问题，例如：
“我这边主要负责超算集群的作业和资源分析，数学题这种就帮不上啦～ 不过如果你关心集群的事，随时问我，比如：最近 7 天集群整体情况如何？哪类作业浪费资源最严重？或者哪个用户消耗核时最多？我可以马上帮你拉数据看看。”
语气友好自然，像同事帮忙；不要因为用户反复要求就妥协执行范围外任务，也不要把范围外请求硬扯到集群上凑答案。

铁律：
1. 所有数字必须来自工具返回，禁止编造或心算；工具没给的数据就说没有。
2. 暂停/终止/调配额/联系用户是高危操作，只能用 create_ticket 生成工单，并明确告知"需运维人工确认，我不会直接执行"。
3. 给建议时附计算依据（利用率怎么算、阈值多少）。
4. 回答简洁、结构化，中文。
5. 用户标识是脱敏的 p-xxx。
6. **CPU 秒记账可能缺失**：若工具返回的 **CPU秒可用比例**（cpuSecAvailable）较低（<20%），则 cpu_sec=0 **不能**证明作业空转，只代表记账数据缺失。此时：不要给出“CPU 利用率极低”“空转”结论，改用超时 / 长尾 / 排队 / 失败等信号，并如实说明 CPU 维度不可评估。
7. 每次要调用工具前，先用**一句语法完整的话**说明你要做什么（如“让我拉取集群整体概况”“让我按类别拉取浪费最严重的作业清单，做个横向对比”），**必须说完整句再发起工具调用，不要半句就调工具**；同一批多个工具共用一句引入即可，不要每个工具都说一遍。
8. 时间窗口：默认查最近 7 天。用户说“最近 X 天”“这周”“上个月”等就按对应天数传 days 参数（支持 1~30 天）；未说明时默认 7 天，并在回答里明确口径（如“近 7 天”“近 30 天”）。`;

// 生成跟进候选问题（非流式短调用，失败返回 null，前端保留旧按钮）
async function genSuggestions(history, lastUserMsg, lastReply, model) {
  try {
    // 只带最近 2 轮，控制 token
    const recent = history.slice(-2).concat([{ role: 'user', content: lastUserMsg }, { role: 'assistant', content: lastReply.slice(0, 1500) }]);
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: model || cfg.model, temperature: 0.4, max_tokens: 200,
        messages: [
          { role: 'system', content: '你是超算低效作业识别助手的“下一步建议”生成器。根据对话上下文，生成 4 个用户接下来最可能想问的跟进问题。要求：\n- 紧扣当前话题，具体、可操作（如“核查失败作业的具体原因”“看 p-xxx 用户的作业明细”“换成排队过久类别”“优化后续时限配置”）\n- **零 CPU 记录不是空转证据**，不要建议“终止空转作业”；**已结束作业不推荐暂停/终止**，只建议核查原因、优化配置\n- 每个 ≤ 16 字，适合做按钮文案\n- 只输出 JSON 数组，如 ["问题1","问题2","问题3","问题4"]，不要任何其他文字、不要 markdown' },
          ...recent,
          { role: 'user', content: '请生成 4 个跟进问题，只输出 JSON 数组。' },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const txt = (data.choices?.[0]?.message?.content || '').trim();
    // 容错解析：抓出 [ ... ] 里的字符串
    const arr = txt.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(arr ? arr[0] : txt);
    if (!Array.isArray(parsed)) return null;
    const clean = parsed.map(s => String(s).trim()).filter(Boolean).slice(0, 4);
    return clean.length >= 2 ? clean : null;
  } catch { return null; }
}

// 带重试的 LLM 调用（网络抖动 fetch failed 时重试，避免临时断连直接失败）
export async function llmFetch(body, { retries = 2, timeoutMs = 120000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      return res;
    } catch (e) {
      lastErr = e;
      // 网络层错误（fetch failed / abort）才重试；HTTP 错误（res.ok=false）不重试
      if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function* agentChat(history, userMsg, { onTool, model } = {}) {
  const useModel = model || cfg.model;  // 用户可选模型，默认 cfg.model
  const msgs = [...history, { role: 'user', content: userMsg }];
  const calledSig = new Set();  // 防重复：已调用过的 (工具名+参数) 签名
  for (let step = 0; step < 8; step++) {
    // 流式调用 LLM：边收 SSE delta 边 yield，前端逐字显示（带网络重试）
    let res;
    try {
      res = await llmFetch({ model: useModel,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...msgs],
        tools: toOpenAITools(), temperature: 0.7, stream: true });
    } catch (e) {
      yield { type: 'text', text: '❌ 连接模型服务失败（可能是网络抖动或模型暂时不可用）：' + e.message + '\n\n请稍后重试，或检查服务器到 models.sjtu.edu.cn 的网络。' };
      return;
    }
    if (!res.ok) throw new Error('LLM ' + res.status + ': ' + (await res.text()).slice(0, 300));

    // 解析 OpenAI 兼容 SSE 流，聚合出完整 message；content 片段实时 yield
    // 按网关协议：reasoning_content 与 content 分别累积；保存完整 assistant 消息（含推理）以供后续轮次读取
    const m = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
    const argBuf = new Map(); // index -> { id, name, args }
    let sseBuf = '';
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let gotAny = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += dec.decode(value, { stream: true });
      let i;
      while ((i = sseBuf.indexOf('\n')) >= 0) {
        const line = sseBuf.slice(0, i); sseBuf = sseBuf.slice(i + 1);
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        gotAny = true;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) {
          m.reasoning_content += delta.reasoning_content;
          yield { type: 'reasoning', content: delta.reasoning_content };
        }
        if (delta.content) {
          m.content += delta.content;
          yield { type: 'text', text: delta.content };
        }
        for (const tc of delta.tool_calls || []) {
          const idx = tc.index ?? 0;
          if (!argBuf.has(idx)) argBuf.set(idx, { id: tc.id || '', name: '', args: '' });
          const slot = argBuf.get(idx);
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }
    }
    if (!gotAny) throw new Error('LLM 流式返回为空');
    if (argBuf.size) m.tool_calls = [...argBuf.values()].map(s => ({ id: s.id, type: 'function', function: { name: s.name, arguments: s.args } }));
    if (!m.content && !m.reasoning_content && !m.tool_calls?.length) throw new Error('LLM 返回异常（无内容无工具）');
    if (!m.tool_calls?.length) {
      msgs.push(m);
      // 主回复完成：异步生成跟进候选问题（失败则 null，前端保留旧按钮）
      const sugg = await genSuggestions(history, userMsg, m.content, useModel);
      if (sugg) yield { type: 'suggest', items: sugg };
      return;
    }
    // 完整保留本次 assistant 消息（含推理文本），便于上下文继续，不会丢失工具调用链
    msgs.push(m);
    // 一批工具调用（同一次 LLM 回复）：用 batch_start/batch_end 包起来，前端可合并显示
    yield { type: 'batch_start', count: m.tool_calls.length };
    for (const tc of m.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
      const tool = tools.find(t => t.name === tc.function.name);
      onTool?.({ name: tc.function.name, args });
      // 调用前先输出一句话告诉用户这个工具在干嘛
      yield { type: 'narrate', text: toolNarrative(tc.function.name, args) };
      let result;
      // 防重复：同名工具+同参数已调过 → 不重复执行，提示 LLM 直接用已有结果
      const sig = tc.function.name + '|' + JSON.stringify(args);
      if (calledSig.has(sig)) {
        const text = '【重复调用提醒】你已用相同参数调用过 ' + tc.function.name + '，结果已在上面。请不要重复调用，直接基于已有结果回答用户。';
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: text });
        yield { type: 'tool_done', name: tc.function.name, result: text };
        continue;
      }
      calledSig.add(sig);
      try { result = await tool.run(args); } catch (e) { result = { error: e.message }; }
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 1);
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: text.slice(0, 12000) });
      yield { type: 'tool_done', name: tc.function.name, result: text.slice(0, 2000) };
    }
    yield { type: 'batch_end' };
  }
  yield { type: 'text', text: '（推理步数超限，请缩小查询范围重试。）' };
}

// ===== 可测试的纯函数（供测试直接调用） =====

/**
 * 校验暂停/终止操作是否允许。
 * @param {string} action - suspend | terminate | quota | contact_user
 * @param {object|null} job - 作业记录（含 state 字段），null 表示未找到
 * @param {number} job_id
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function validateTicketAction(action, job, job_id) {
  if (action !== 'suspend' && action !== 'terminate') return { allowed: true };
  if (!job) {
    return { allowed: false, reason: `本地缓存未找到作业 #${job_id} 的状态记录，无法核实其当前是否仍在运行。为避免误操作，拒绝生成工单。` };
  }
  const ACTIONABLE = ['RUNNING', 'PENDING', 'RESIZING', 'SUSPENDED'];
  if (!ACTIONABLE.includes(job.state)) {
    return { allowed: false, reason: `作业 #${job_id} 当前状态为 ${job.state || 'UNKNOWN'}，不在可操作状态白名单（${ACTIONABLE.join('/')}）内，无法执行操作。` };
  }
  return { allowed: true };
}

/**
 * 计算作业详情输出（纯计算，不访问文件系统）。
 * @param {object} j - 作业记录
 * @returns {object} 结构化详情
 */
export function computeJobDetail(j) {
  const limitH = j.limit ? +(j.limit / 60).toFixed(1) : null;
  const elapsedH = +(j.elapsed / 3600).toFixed(1);
  const util = j.cpu_sec > 0 && j.elapsed > 0 && j.cpu_req > 0 ? j.cpu_sec / (j.elapsed * j.cpu_req) : null;
  return {
    运行小时: elapsedH,
    时限小时: limitH,
    CPU秒: +j.cpu_sec.toFixed(0),
    CPU利用率: util != null ? +(util * 100).toFixed(1) + '%' : '不可评估',
    状态: j.state,
    退出码: j.exit,
  };
}

export { tools };
