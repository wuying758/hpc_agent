// 低效作业分析引擎（确定性计算，非 LLM）
import fs from 'node:fs';
import path from 'node:path';

const defaultDataDir = path.resolve('data');

// 模块级时间有效性判断（供 loadJobs 的 obsT 去重比较使用）
const MAX_VALID_T = 4100000000;  // ~2100 年，超过即脏数据（SLURM 用 4294967294 等表示无效）
const isT = (t) => Number.isFinite(t);  // 类型守卫
function validObsT(t, nowSec) {
  return isT(t) && t > 0 && t < MAX_VALID_T && t <= nowSec + 86400;
}

export function loadJobs(days = 7) {
  // 口径：近 N 天**提交**的作业（按数据文件日期筛选）。
  // 更早提交、最近才结束或仍在运行的长作业会被排除，这是产品口径，不是 bug。
  const DATA_DIR = process.env.DATA_DIR || defaultDataDir; // 每次调用时读取，测试可指向临时目录
  const now = Math.floor(Date.now() / 1000);
  const jobs = [];
  for (const f of fs.readdirSync(DATA_DIR).filter(f => /^jobs_\d{8}\.jsonl$/.test(f))) {
    const day = +f.slice(5, 13);
    const y = +String(day).slice(0, 4), m = +String(day).slice(4, 6) - 1, d = +String(day).slice(6, 8);
    const dayStart = Math.floor(new Date(y, m, d).getTime() / 1000);
    if (now - dayStart > days * 86400) continue;
    for (const line of fs.readFileSync(path.join(DATA_DIR, f), 'utf8').split('\n')) {
      if (line.trim()) { try { jobs.push(JSON.parse(line)); } catch {} }
    }
  }
  // 去重：同一个 job_id 多次观测时保留**最新**记录（先 RUNNING 后 TIMEOUT 必须留 TIMEOUT）。
  // 新旧判定：观测时间戳（end，终态时即最后更新时间，RUNNING 时为 0）
  // → 未结束时回退到 start + elapsed（≈最后观测时刻）→ 都没有时用 submit。
  // SLURM 特殊值（4294967294 等）视为无效（0），不参与比较，让有效时间戳的记录自然胜出。
  // 平局（时间戳相同，如 RUNNING 同 end=0）时同文件内行序靠后的视为更新观测。
  // 此前版本保留第一条（旧观测，可能是 RUNNING），导致状态/时长/失败统计失真。
  const latest = new Map();
  const obsT = j => {
    const end = validObsT(j.end, now) ? j.end : 0;
    const start = validObsT(j.start, now) ? j.start : 0;
    const submit = validObsT(j.submit, now) ? j.submit : 0;
    return (end > 0 ? end : (start > 0 ? start + (j.elapsed || 0) : submit));
  };
  jobs.forEach(j => {
    const cur = latest.get(j.id);
    if (cur === undefined) { latest.set(j.id, j); return; }
    // >= 替换：时间戳更新则替换；平局（如 RUNNING 同 end=0）时同日期内行序靠后视为更新观测
    if (obsT(j) >= obsT(cur)) latest.set(j.id, j);
  });
  return [...latest.values()];
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

export function analyze(jobs) {
  // 时间有效性：SLURM 用 4294967294 (=2^32-2) 等特殊值表示“未开始/无效”，
  // 超过合理上限（如 2100 年=4102444800）或超过当前时间的 start/end 都视为无效，不计入排队/时长
  const nowSec = Math.floor(Date.now() / 1000);
  const MAX_VALID_T = 4100000000;  // ~2100 年，超过即脏数据
  const validT = (t) => t > 0 && t < MAX_VALID_T && t <= nowSec + 86400;
  const DONE_STATES = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'OUT_OF_MEMORY'];
  const done = jobs.filter(j => j.elapsed > 0 && j.cpu_req > 0 && DONE_STATES.includes(j.state));
  const cpuSecAvailable = done.length ? done.filter(j => j.cpu_sec > 0).length / done.length : 0;

  // 排队时长基准（按分区 P90）——只算 start 有效的作业
  const queueByPart = {};
  for (const j of jobs) if (validT(j.start) && validT(j.submit) && j.start > j.submit) (queueByPart[j.partition] ||= []).push(j.start - j.submit);
  const queueP90 = Object.fromEntries(Object.entries(queueByPart).map(([p, a]) => [p, pct(a, 0.9)]));

  const findings = { low_cpu: [], limit_abuse: [], queue_long: [], repeat_fail: [], mem_hog: [] };
  const waste = { idle_core_hours: 0, wait_core_hours: 0, fail_core_hours: 0 };

  // 1) CPU 利用率低（绝对下限 15% 或 低于自身历史基线 30%）——仅在 cpu_sec 可用时生效
  if (cpuSecAvailable > 0.05) {
    const nameUtil = {};
    for (const j of done) {
      if (j.cpu_sec > 0 && j.elapsed > 60) {
        (nameUtil[j.user + '|' + j.name] ||= []).push(j.cpu_sec / (j.elapsed * j.cpu_req));
      }
    }
    const nameMedian = {};
    for (const [k, arr] of Object.entries(nameUtil)) { arr.sort((a, b) => a - b); nameMedian[k] = arr[Math.floor(arr.length / 2)]; }
    for (const j of done) {
      if (j.cpu_sec <= 0 || j.elapsed < 1800) continue;
      const util = j.cpu_sec / (j.elapsed * j.cpu_req);
      const base = nameMedian[j.user + '|' + j.name];
      if (util < 0.15 || (base != null && base > 0.4 && util < base * 0.3)) {
        findings.low_cpu.push({ ...j, util: +util.toFixed(3), baseline: base != null ? +base.toFixed(3) : null,
          waste_core_h: +((j.elapsed * (1 - util) * j.cpu_req) / 3600).toFixed(1) });
        waste.idle_core_hours += j.elapsed * (1 - util) * j.cpu_req / 3600;
      }
    }
  }

  // 2) 时限滥用：limit >= 8h 且 > 5x 实际（limit 原值单位是**分钟**，×60 转秒）
  for (const j of done) {
    const limitSec = j.limit * 60;
    if (limitSec >= 8 * 3600 && limitSec > j.elapsed * 5) {
      findings.limit_abuse.push({ ...j, ratio: +(limitSec / Math.max(j.elapsed, 1)).toFixed(1) });
    }
  }

  // 3) 排队过久：> max(分区P90, 2h)（只算 start 有效的作业）
  for (const j of jobs) {
    if (!validT(j.start) || !validT(j.submit)) continue;
    const q = j.start - j.submit;
    if (q > Math.max(queueP90[j.partition] || 0, 7200) && q > 7200) {
      findings.queue_long.push({ ...j, queue_sec: q });
      waste.wait_core_hours += q * j.cpu_req / 3600;
    }
  }

  // 4) 反复失败：同 user+name 失败 >=3 次
  const failGroups = {};
  for (const j of done) {
    if (j.state === 'FAILED') (failGroups[j.user + '|' + j.name] ||= []).push(j);
  }
  for (const arr of Object.values(failGroups)) {
    if (arr.length >= 3) {
      const coreH = +arr.reduce((s, j) => s + j.elapsed * j.cpu_req / 3600, 0).toFixed(1);
      waste.fail_core_hours += coreH;
      findings.repeat_fail.push({ user: arr[0].user, name: arr[0].name, count: arr.length,
        waste_core_h: coreH, last: arr[arr.length - 1].id });
    }
  }

  // 5) 内存规格过高：>8GB/核 且 利用率<30%（需 cpu_sec）
  if (cpuSecAvailable > 0.05) {
    for (const j of done) {
      if (j.cpu_sec <= 0 || j.elapsed < 1800) continue;
      const util = j.cpu_sec / (j.elapsed * j.cpu_req);
      if (j.mem_req / j.cpu_req > 8192 && util < 0.3) {
        findings.mem_hog.push({ ...j, util: +util.toFixed(3), mem_per_cpu_gb: +(j.mem_req / j.cpu_req / 1024).toFixed(1) });
      }
    }
  }

  // 无 cpu_sec 时的补充信号
  const timeouts = done.filter(j => j.state === 'TIMEOUT').sort((a, b) => b.elapsed - a.elapsed);
  // zeroLong 仅在 CPU 秒记账覆盖率足够（≥20%）时才有诊断价值；否则 cpu_sec=0 可能是记账缺失而非空转
  const zeroLong = cpuSecAvailable >= 0.2
    ? done.filter(j => j.cpu_sec <= 0 && j.elapsed >= 3600).sort((a, b) => b.elapsed - a.elapsed)
    : [];
  const elapsedArr = done.map(j => j.elapsed);

  const top = (arr, k, key) => [...arr].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, k);
  const row = (j, extra) => ({ id: j.id, name: j.name, partition: j.partition, state: j.state,
    运行h: +(j.elapsed / 3600).toFixed(1), 申请核: j.cpu_req, 占用核时: +((extra ?? j.elapsed) * j.cpu_req / 3600).toFixed(1) });

  return {
    total: jobs.length, done: done.length,
    cpuSecAvailable: +cpuSecAvailable.toFixed(3),
    queueP90, waste,
    timeout_jobs: timeouts.length,
    timeout_top: timeouts.slice(0, 30).map(j => row(j)),
    longtail_p95h: +(pct(elapsedArr, 0.95) / 3600).toFixed(1),
    zero_cpu_long: zeroLong.slice(0, 50).map(j => row(j)),
    top_low_cpu: top(findings.low_cpu, 20, 'waste_core_h'),
    top_queue: top(findings.queue_long, 20, 'queue_sec'),
    top_fail: top(findings.repeat_fail, 20, 'waste_core_h'),
    top_limit: top(findings.limit_abuse, 20, 'ratio'),
    top_mem: top(findings.mem_hog, 20, 'mem_per_cpu_gb'),
    counts: Object.fromEntries(Object.entries(findings).map(([k, v]) => [k, v.length])),
  };
}

// 带缓存的分析：7/30 天窗口结果缓存 24h，避免每次请求都扫全部 jsonl
const CACHE_DIR = path.join(defaultDataDir, 'cache');
const CACHE_TTL = 24 * 3600 * 1000;  // 24 小时
export function getAnalysis(days) {
  const daysInt = Math.max(1, Math.min(30, Math.round(days)));
  const cacheFile = path.join(CACHE_DIR, `analysis_${daysInt}.json`);
  // 1) 命中且未过期 → 直接返回
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (Date.now() - c.generatedAt < CACHE_TTL) return { ...c, cached: true };
  } catch {}
  // 2) 实时算（loadJobs + analyze + 状态/分区分布）
  const t0 = Date.now();
  const jobs = loadJobs(daysInt);
  const r = analyze(jobs);
  const byState = {}, byPart = {};
  for (const j of jobs) { byState[j.state] = (byState[j.state] || 0) + 1; byPart[j.partition] = (byPart[j.partition] || 0) + 1; }
  const result = { generatedAt: Date.now(), elapsedMs: Date.now() - t0, days: daysInt, r, byState, byPart };
  // 3) 写缓存（失败不影响返回）
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch {}
  return { ...result, cached: false };
}

// 手动重算缓存（CLI：node src/analyze.mjs precompute [days...]）
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === 'precompute') {
    const daysList = (process.argv.slice(3).map(Number).filter(Boolean)).length ? process.argv.slice(3).map(Number) : [7, 30];
    for (const d of daysList) {
      const { elapsedMs, r, cached } = getAnalysis(d);
      console.log(`days=${d}: ${cached ? '缓存命中' : '已重算'} 总作业 ${r.total}，耗时 ${(elapsedMs / 1000).toFixed(1)}s`);
    }
    process.exit(0);
  }
  const days = +(process.argv[2] || 7);
  const jobs = loadJobs(days);
  const r = analyze(jobs);
  const out = path.join(process.env.DATA_DIR || defaultDataDir, `analysis_${days}d.json`);
  fs.writeFileSync(out, JSON.stringify(r, null, 1));
  console.log(`总作业 ${r.total}，已结束 ${r.done}`);
  console.log('CPU秒可用比例:', (r.cpuSecAvailable * 100).toFixed(1) + '%');
  console.log('低效计数:', r.counts);
  console.log(`浪费核时: 排队 ${r.waste.wait_core_hours.toFixed(0)}h, 失败 ${r.waste.fail_core_hours.toFixed(0)}h`);
  console.log(`超时作业 ${r.timeout_jobs}，Top5:`);
  for (const j of r.timeout_top.slice(0, 5)) console.log(`  #${j.id} ${j.name} 运行${j.运行h}h ${j.申请核}核 [${j.partition}]`);
  console.log('已写入', out);
}
