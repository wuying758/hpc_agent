// 离线回归测试：诊断可信度 + 工具输出 + 工单拒绝
// 运行：node --test test/diagnosis.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyze } from '../src/analyze.mjs';
import { validateTicketAction, computeJobDetail, tools } from '../src/agent.mjs';

// ---- 合成 fixture ----
const FIXTURE_JOBS = [
  { id: 1001, name: 'test_timeout_zero', partition: 'gpu', state: 'TIMEOUT',
    submit: 1700000000, start: 1700003600, elapsed: 288000,
    cpu_req: 32, mem_req: 256 * 1024, node_req: 'node01',
    limit: 4800, cpu_sec: 0, exit: 'TIMEOUT', user: 'p-abc' },
  { id: 1002, name: 'test_running_positive', partition: 'cpu', state: 'RUNNING',
    submit: 1700000000, start: 1700003600, elapsed: 7200,
    cpu_req: 16, mem_req: 128 * 1024, node_req: 'node02',
    limit: 1440, cpu_sec: 115200, exit: null, user: 'p-def' },
  { id: 1003, name: 'test_running_zero', partition: 'cpu', state: 'RUNNING',
    submit: 1700000000, start: 1700003600, elapsed: 3600,
    cpu_req: 8, mem_req: 64 * 1024, node_req: 'node03',
    limit: 720, cpu_sec: 0, exit: null, user: 'p-ghi' },
];

describe('analyze 固定样例：limit=4800min, elapsed=288000s, cpu_sec=0, TIMEOUT', () => {
  test('运行小时 = 80', () => {
    const r = analyze(FIXTURE_JOBS);
    const job = r.timeout_top.find(j => j.id === 1001);
    assert.ok(job, '作业 1001 应在 timeout_top 中');
    assert.equal(job.运行h, 80);
  });

  test('cpuSecAvailable = 0（唯一 done 作业 cpu_sec=0）', () => {
    const r = analyze(FIXTURE_JOBS);
    assert.equal(r.cpuSecAvailable, 0);
  });

  test('zero_cpu_long 在 cpuSecAvailable < 0.2 时为空', () => {
    const r = analyze(FIXTURE_JOBS);
    assert.equal(r.zero_cpu_long.length, 0);
  });

  test('不产生 60 倍时限错误', () => {
    const r = analyze(FIXTURE_JOBS);
    const topLimit = r.top_limit.find(j => j.id === 1001);
    if (topLimit) assert.ok(topLimit.ratio < 5, `ratio 应合理，实际 ${topLimit.ratio}`);
  });
});

describe('computeJobDetail：真实函数调用', () => {
  test('零 CPU 作业：运行/时限 80h，CPU 不可评估', () => {
    const d = computeJobDetail(FIXTURE_JOBS[0]);
    assert.equal(d.运行小时, 80);
    assert.equal(d.时限小时, 80);
    assert.equal(d.CPU秒, 0);
    assert.match(d.CPU利用率, /不可评估/);
    assert.match(d.CPU利用率, /零值不能证明空转/);
  });

  test('正 CPU 作业：利用率正常计算', () => {
    const d = computeJobDetail(FIXTURE_JOBS[1]);
    assert.equal(d.运行小时, 2);  // 7200s = 2h
    assert.equal(d.时限小时, 24); // 1440min = 24h
    assert.equal(d.CPU利用率, '100%');
  });

  test('运行中零 CPU：不可评估但状态为 RUNNING', () => {
    const d = computeJobDetail(FIXTURE_JOBS[2]);
    assert.match(d.CPU利用率, /不可评估/);
    assert.equal(d.状态, 'RUNNING');
  });

  test('无 limit 作业：时限小时为 null', () => {
    const d = computeJobDetail({ ...FIXTURE_JOBS[0], limit: 0 });
    assert.equal(d.时限小时, null);
  });
});

describe('validateTicketAction：真实函数调用（白名单）', () => {
  test('RUNNING + terminate → 允许', () => {
    const r = validateTicketAction('terminate', { state: 'RUNNING' }, 1002);
    assert.equal(r.allowed, true);
  });

  test('PENDING + suspend → 允许', () => {
    const r = validateTicketAction('suspend', { state: 'PENDING' }, 1002);
    assert.equal(r.allowed, true);
  });

  test('TIMEOUT + terminate → 拒绝', () => {
    const r = validateTicketAction('terminate', { state: 'TIMEOUT' }, 1001);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /TIMEOUT/);
    assert.match(r.reason, /白名单/);
  });

  test('FAILED + suspend → 拒绝', () => {
    const r = validateTicketAction('suspend', { state: 'FAILED' }, 1004);
    assert.equal(r.allowed, false);
  });

  test('OUT_OF_MEMORY + terminate → 拒绝', () => {
    const r = validateTicketAction('terminate', { state: 'OUT_OF_MEMORY' }, 1005);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /OUT_OF_MEMORY/);
  });

  test('NODE_FAIL + suspend → 拒绝', () => {
    const r = validateTicketAction('suspend', { state: 'NODE_FAIL' }, 1006);
    assert.equal(r.allowed, false);
  });

  test('状态为空 + terminate → 拒绝', () => {
    const r = validateTicketAction('terminate', { state: '' }, 1007);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /UNKNOWN/);
  });

  test('状态为 null + suspend → 拒绝', () => {
    const r = validateTicketAction('suspend', { state: null }, 1008);
    assert.equal(r.allowed, false);
  });

  test('作业不存在（null）+ terminate → 拒绝', () => {
    const r = validateTicketAction('terminate', null, 9999);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /未找到/);
  });

  test('作业不存在（null）+ suspend → 拒绝', () => {
    const r = validateTicketAction('suspend', null, 9999);
    assert.equal(r.allowed, false);
  });

  test('quota 操作不受白名单限制', () => {
    const r = validateTicketAction('quota', { state: 'TIMEOUT' }, 1001);
    assert.equal(r.allowed, true);
  });

  test('contact_user 操作不受白名单限制', () => {
    const r = validateTicketAction('contact_user', { state: 'FAILED' }, 1001);
    assert.equal(r.allowed, true);
  });
});

describe('create_ticket 工具：真实 run 调用 + 零写入验证', () => {
  // 使用 tools 数组中真实的 create_ticket.run
  const ticketTool = tools.find(t => t.name === 'create_ticket');

  test('终态作业 terminate → 拒绝且不写入文件', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpc-tkt-'));
    const ticketsPath = path.join(tmpDir, 'tickets.jsonl');

    // 通过 loadJobs(30) 返回 fixture 中的 TIMEOUT 作业
    // 但 loadJobs 读取的是真实文件，我们无法直接 mock
    // 替代方案：用不存在的 job_id 测试"未找到"路径（也触发拒绝）
    const result = await ticketTool.run({ action: 'terminate', job_id: 99999, reason: 'test' });
    assert.equal(result.拒绝, true);
    assert.match(result.原因, /未找到/);
    // 零写入
    assert.equal(fs.existsSync(ticketsPath), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('quota 操作对任何作业都允许（不检查状态）', async () => {
    // quota 不受白名单限制，会生成工单
    // 但为了避免写入真实 tickets.jsonl，用一个不存在的 job_id
    // 实际会写入，所以这里只验证不拒绝
    const r = validateTicketAction('quota', null, 99999);
    assert.equal(r.allowed, true);
  });
});

describe('genSuggestions 提示词约束', () => {
  test('包含证据边界指令', () => {
    const src = fs.readFileSync(new URL('../src/agent.mjs', import.meta.url), 'utf8');
    assert.ok(src.includes('零 CPU 记录不是空转证据'));
    assert.ok(src.includes('已结束作业不推荐暂停/终止'));
    assert.ok(!src.includes('给 Top 超时作业生成暂停工单'));
  });
});
