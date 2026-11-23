// 回归测试：analyze.loadJobs 去重保留最新观测（Bug 2）
// 运行：node --test test/dedup.test.mjs
// fixture 字段结构与 data/jobs/*.jsonl 真实记录一致
//（id/name/user/partition/qos/state/reason/exit/submit/start/end/elapsed/limit/cpu_req/mem_req/node_req/cpu_sec）
// limit 单位是分钟（本测试不改动该语义）
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadJobs, analyze } from '../src/analyze.mjs';

const SUBMIT = 1795048258; // 真实数据里量级的提交时间戳（2026-11 中旬）
const START = 1795050287;
const base = {
  name: 'tpwrs_v13_nf_ctl', user: 'p-abc', account: 'p-acc', partition: 'cpu',
  qos: 'normal', reason: '', exit: ['SUCCESS'], limit: 720,
  cpu_req: 4, mem_req: 4096, node_req: 1,
};

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpc-dedup-'));
  process.env.DATA_DIR = dir;
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
// 每个用例用干净目录：避免前一个用例的 fixture 残留影响计数
beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true });
});

// 写一个“昨天”的 jsonl（相对运行时间昨天，保证落在 loadJobs 的窗口内）
function writeDayFile(dayOffset, lines) {
  const dt = new Date(Date.now() - dayOffset * 86400_000);
  const name = `jobs_${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}.jsonl`;
  fs.writeFileSync(path.join(dir, name), lines.map(j => JSON.stringify(j)).join('\n') + '\n');
}

// 同一作业 id=9001：早期多次 RUNNING 观测（end=0），最后 TIMEOUT（end>0）
function runningObs(id, elapsed) {
  const submit = Math.floor(Date.now() / 1000) - 100000;
  const start = submit + 60;
  return { id, ...base, state: 'RUNNING', submit, start, end: 0, elapsed, cpu_sec: 0 };
}
function timeoutObs(id, elapsed, end) {
  const start = end - elapsed; // 保证 end = start + elapsed（自洽）
  const submit = start - 60;
  return { id, ...base, state: 'TIMEOUT', exit: ['TIMEOUT'], submit, start, end, elapsed, cpu_sec: 0 };
}

describe('loadJobs 去重：保留最新观测', () => {
  test('同一 job_id 先 RUNNING 后 TIMEOUT → 保留 TIMEOUT', () => {
    const endTs = Math.floor(Date.now() / 1000) - 5000; // 5 秒前结束
    writeDayFile(0, [
      runningObs(9001, 1000),
      runningObs(9001, 2000),
      timeoutObs(9001, 3000, endTs),
    ]);
    const jobs = loadJobs(3);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, 'TIMEOUT');
    assert.equal(jobs[0].elapsed, 3000);
    assert.ok(jobs[0].end > 0);
  });

  test('同一文件内行序即观测顺序：无显式 end 时行序靠后的 RUNNING 观测（elapsed 更大）胜出', () => {
    writeDayFile(1, [
      runningObs(9002, 100),
      runningObs(9002, 500),
    ]);
    const jobs = loadJobs(3);
    const j = jobs.find(x => x.id === 9002);
    assert.ok(j);
    assert.equal(j.elapsed, 500, '应保留行序更靠后（更新）的观测');
  });

  test('跨文件：后拉取（日期更晚）的文件里同一 job 的终态覆盖早文件里的 RUNNING', () => {
    const endTs = Math.floor(Date.now() / 1000) - 5000;
    writeDayFile(2, [runningObs(9003, 800)]);      // 早文件
    writeDayFile(0, [timeoutObs(9003, 900, endTs)]); // 晚文件
    const jobs = loadJobs(3);
    const j = jobs.find(x => x.id === 9003);
    assert.ok(j);
    assert.equal(j.state, 'TIMEOUT');
    assert.equal(j.elapsed, 900);
  });

  test('不同 job_id 互不影响，且各保留自身最新一条', () => {
    const SUBMIT2 = Math.floor(Date.now() / 1000) - 100000;
    const START2 = Math.floor(Date.now() / 1000) - 50000;
    writeDayFile(1, [
      { id: 9010, ...base, state: 'PENDING', submit: SUBMIT2, start: 0, end: 0, elapsed: 0, cpu_sec: 0 },
      { id: 9010, ...base, state: 'COMPLETED', exit: ['SUCCESS'], submit: SUBMIT2, start: START2, end: START2 + 500, elapsed: 500, cpu_sec: 1200 },
      { id: 9011, ...base, state: 'RUNNING', submit: SUBMIT2, start: START2, end: 0, elapsed: 60, cpu_sec: 0 },
    ]);
    const jobs = loadJobs(3).sort((a, b) => a.id - b.id);
    assert.equal(jobs.length, 2);
    assert.equal(jobs.find(j => j.id === 9010).state, 'COMPLETED');
    assert.equal(jobs.find(j => j.id === 9011).state, 'RUNNING');
  });
});

describe('loadJobs 去重：SLURM 特殊时间值（4294967294）不应干扰比较', () => {
  test('PENDING + start=4294967294 → 后续 COMPLETED（正常 end）→ 保留 COMPLETED', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const submit = nowSec - 20000;
    const start = nowSec - 10000;
    const end = nowSec - 5000;
    writeDayFile(0, [
      { id: 9100, ...base, state: 'PENDING', submit, start: 4294967294, end: 0, elapsed: 0, cpu_sec: 0 },
      { id: 9100, ...base, state: 'COMPLETED', exit: ['SUCCESS'], submit, start, end, elapsed: end - start, cpu_sec: 5000 },
    ]);
    const jobs = loadJobs(3);
    const j = jobs.find(x => x.id === 9100);
    assert.ok(j);
    assert.equal(j.state, 'COMPLETED', '应保留 COMPLETED 而非 PENDING（SLURM 特殊值不应胜出）');
  });

  test('PENDING + end=4294967294 → 后续 COMPLETED → 保留 COMPLETED', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const submit = nowSec - 20000;
    const start = nowSec - 10000;
    const end = nowSec - 5000;
    writeDayFile(0, [
      { id: 9101, ...base, state: 'PENDING', submit, start: 0, end: 4294967294, elapsed: 0, cpu_sec: 0 },
      { id: 9101, ...base, state: 'COMPLETED', exit: ['SUCCESS'], submit, start, end, elapsed: end - start, cpu_sec: 5000 },
    ]);
    const jobs = loadJobs(3);
    const j = jobs.find(x => x.id === 9101);
    assert.ok(j);
    assert.equal(j.state, 'COMPLETED', '应保留 COMPLETED 而非 PENDING（end=4294967294 无效）');
  });

  test('两条都有正常时间戳 → 行为不变（保留 end 更大的）', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const submit = nowSec - 30000;
    // RUNNING 观测：obsT = start + elapsed = (nowSec-20000) + 1000 = nowSec-19000
    const start1 = nowSec - 20000;
    const elapsed1 = 1000;
    // COMPLETED 观测：end = nowSec - 5000（明显更晚）
    const start2 = nowSec - 10000;
    const end2 = nowSec - 5000;
    const elapsed2 = end2 - start2;
    writeDayFile(0, [
      { id: 9102, ...base, state: 'RUNNING', submit, start: start1, end: 0, elapsed: elapsed1, cpu_sec: 0 },
      { id: 9102, ...base, state: 'COMPLETED', exit: ['SUCCESS'], submit, start: start2, end: end2, elapsed: elapsed2, cpu_sec: 2000 },
    ]);
    const jobs = loadJobs(3);
    const j = jobs.find(x => x.id === 9102);
    assert.ok(j);
    assert.equal(j.state, 'COMPLETED', '正常时间戳比较：end 更大的胜出');
    assert.equal(j.end, end2);
  });
});

describe('分析结果基于最新记录', () => {
  test('TIMEOUT 终态计入 done 与 timeout 统计（若保留 RUNNING 则不会）', () => {
    const endTs = Math.floor(Date.now() / 1000) - 5000;
    writeDayFile(0, [
      runningObs(9500, 1000),
      timeoutObs(9500, 3000, endTs),
    ]);
    const r = analyze(loadJobs(3));
    assert.equal(r.total, 1);
    assert.equal(r.done, 1);
    assert.equal(r.timeout_jobs, 1);
    assert.equal(r.timeout_top[0].id, 9500);
  });

  test('byState 按最新状态统计（TIMEOUT=1 而非 RUNNING=1）', () => {
    const endTs = Math.floor(Date.now() / 1000) - 5000;
    writeDayFile(1, [
      runningObs(9501, 1000),
      timeoutObs(9501, 3000, endTs),
    ]);
    const jobs = loadJobs(3);
    const byState = {};
    for (const j of jobs) byState[j.state] = (byState[j.state] || 0) + 1;
    assert.deepEqual(byState, { TIMEOUT: 1 });
  });
});
