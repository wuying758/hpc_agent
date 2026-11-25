// 拉取历史作业数据 → data/jobs_YYYYMMDD.jsonl（增量，自动跳过已拉取的整天）
// 时区约定：统一用本地时区（主机 Asia/Shanghai，UTC+8）解析/格式化“天”。
// 所有 API 时间参数一律用**秒**（hpc_client.fetchRange 的 start_time/end_time 是秒）。
// 纯日期逻辑（nextDay/dayStartOf/todayStr/planStart）导出供测试；
// 只有作为主模块直接运行时才真正请求 API。
import { fetchRange } from './hpc_client.mjs';
import fs from 'node:fs';
import path from 'node:path';

// “下一天”：YYYYMMDD 数字不能直接 +100（20261231 会错成 20261331）；
// 必须用 Date 对象在本地时区加一天后重新格式化。
export function nextDay(d) {
  const n = +String(d);
  const dt = new Date(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100);
  dt.setDate(dt.getDate() + 1);
  return dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate();
}

// 某天 0 点（本地时区）→ Unix **秒**。此前版本返回毫秒，直接当作秒传给 API 是单位混用 bug。
export function dayStartOf(d) {
  const n = +String(d);
  return Math.floor(new Date(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100).getTime() / 1000);
}

// 当天日期 YYYYMMDD（本地时区）
export function todayStr(nowMs = Date.now()) {
  const dt = new Date(nowMs);
  return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
}

// 根据已完整拉取的最后整天计算增量起点，返回 [fromTs(秒), overwriteDay|null]
export function planStart(maxDoneDay, today) {
  if (maxDoneDay > 0 && maxDoneDay < today) {
    return [dayStartOf(nextDay(maxDoneDay)), null]; // maxDoneDay 已完整 → 从次日 0 点
  }
  if (maxDoneDay === today) {
    return [dayStartOf(today), today]; // 当天已有部分，从当天 0 点补（会追加重复，分析时去重）
  }
  return [0, null]; // 无历史数据
}

// 秒级时间戳 → 本地时区 YYYYMMDD（用于分桶写文件，与增量起点一致）
export function bucketDayKey(tSec) {
  const dt = new Date(tSec * 1000);
  return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * 执行增量拉取（Web 和 CLI 共用）。
 * @param {{days?: number, start?: number, end?: number, conn?: object}} opts
 * @returns {Promise<{total: number, elapsed: number}>}
 */
export async function fetchAndSave({ days = 7, start: startArg, end: endArg, conn } = {}) {
  const now = Math.floor(Date.now() / 1000);
  let start, end = endArg || now;
  if (startArg) {
    start = startArg;
  } else {
    start = end - days * 86400;
  }
  let maxDoneDay = 0;
  for (const f of fs.readdirSync(DATA_DIR).filter(f => /^jobs_\d{8}\.jsonl$/.test(f))) {
    maxDoneDay = Math.max(maxDoneDay, +f.slice(5, 13));
  }
  const today = todayStr();
  if (maxDoneDay > today) return { total: 0, skipped: true, reason: '时钟异常' };
  let [fromTs, overwriteDay] = planStart(maxDoneDay, today);
  if (fromTs > 0) start = Math.max(start, fromTs);
  if (start >= end) return { total: 0, skipped: true, reason: '无新数据' };
  const t0 = Date.now();
  let total = 0;
  let buckets = {};
  const CHUNK = 6 * 3600;
  function flush() {
    for (const [key, arr] of Object.entries(buckets)) {
      if (!arr.length) continue;
      fs.appendFileSync(path.join(DATA_DIR, `jobs_${key}.jsonl`), arr.map(j => JSON.stringify(j)).join('\n') + '\n');
      arr.length = 0;
    }
  }
  for (let s = start; s < end; s += CHUNK) {
    const e = Math.min(s + CHUNK, end);
    const jobs = await fetchRange(s, e, { conn });
    total += jobs.length;
    for (const j of jobs) {
      const t = j.submit || e;
      const key = bucketDayKey(t);
      (buckets[key] ||= []).push(j);
    }
    flush();
  }
  flush();
  // 清除分析缓存
  const cacheDir = path.join(DATA_DIR, 'cache');
  if (fs.existsSync(cacheDir)) {
    for (const f of fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'))) {
      try { fs.unlinkSync(path.join(cacheDir, f)); } catch {}
    }
  }
  return { total, elapsed: Date.now() - t0 };
}

if (isMain) {
  const args = process.argv.slice(2);
  const now = Math.floor(Date.now() / 1000);
  let start, end = now;
  if (args.length >= 2 && /^\d+$/.test(args[0]) && /^\d+$/.test(args[1])) {
    start = +args[0]; end = +args[1];
  } else {
    const days = args[0] ? +args[0] : 7;
    start = end - days * 86400;
  }
  const r = await fetchAndSave({ start, end });
  if (r.skipped) { console.log(r.reason + '，跳过'); process.exit(0); }
  console.log(`完成：${r.total} 条，用时 ${(r.elapsed / 1000).toFixed(0)}s`);
  process.exit(0);
}
