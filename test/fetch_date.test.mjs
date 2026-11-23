// 回归测试：fetch_jobs.mjs 增量拉取日期计算（Bug 1）
// 运行：node --test test/fetch_date.test.mjs
// 覆盖：dayStartOf 单位（秒，非毫秒）、nextDay 跨月/跨年、时区边界、planStart 增量起点
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nextDay, dayStartOf, todayStr, planStart, bucketDayKey } from '../src/fetch_jobs.mjs';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe('dayStartOf：返回本地时区 0 点的 Unix 秒', () => {
  test('返回秒（不是毫秒）：量级 ~1.7e9 而非 ~1.7e12', () => {
    const ts = dayStartOf(20261121);
    assert.ok(ts > 1_000_000_000 && ts < 5_000_000_000, `应为秒级时间戳，实际 ${ts}`);
  });

  test('本地 0 点反解回同一日期（时区自洽）', () => {
    for (const d of [20260101, 20260315, 20261121, 20261231]) {
      const ts = dayStartOf(d);
      const dt = new Date(ts * 1000);
      const back = dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate();
      assert.equal(back, d, `dayStartOf(${d}) = ${ts} (${TZ}) 反解应回到 ${d}`);
    }
  });

  test('相邻两天相差恰 86400 秒（含跨月：11月30日→12月1日）', () => {
    assert.equal(dayStartOf(20261201) - dayStartOf(20261130), 86400);
    assert.equal(dayStartOf(20261202) - dayStartOf(20261201), 86400);
  });

  test('跨年边界：20261231 → 20270101 恰 86400 秒', () => {
    assert.equal(dayStartOf(20270101) - dayStartOf(20261231), 86400);
  });

  test('接受字符串入参（与调用方 maxDoneDay+… 的数字/字符串混用场景一致）', () => {
    assert.equal(dayStartOf('20261121'), dayStartOf(20261121));
  });
});

describe('nextDay：YYYYMMDD 的下一天（旧 bug：数字 +100）', () => {
  test('普通日', () => {
    assert.equal(nextDay(20261121), 20261122);
  });

  test('跨月：月末+1 进下月 1 号（旧 bug 20261130+100=20261230 错；正确是 20261201）', () => {
    assert.equal(nextDay(20261130), 20261201);
    assert.equal(nextDay(20260131), 20260201);
  });

  test('跨年：20261231 的下一天是 20270101（旧 bug 20261231+100=20261331 是非法日期）', () => {
    assert.equal(nextDay(20261231), 20270101);
  });

  test('闰年：20280229 → 20280301；非闰年：20270228 → 20270301', () => {
    assert.equal(nextDay(20280229), 20280301);
    assert.equal(nextDay(20270228), 20270301);
  });

  test('nextDay 结果可被 dayStartOf 消费且恰差一天', () => {
    const d = 20261231;
    assert.equal(dayStartOf(nextDay(d)) - dayStartOf(d), 86400);
  });
});

describe('todayStr：本地时区当天 YYYYMMDD', () => {
  test('与本地 Date 一致', () => {
    const dt = new Date(2026, 10, 23, 23, 30); // 2026-11-23 23:30 本地
    assert.equal(todayStr(dt.getTime()), '20261123');
  });

  test('本地 00:00 属于当天；UTC 前一天 16:00 仍算 UTC+8 的当天', () => {
    // 2026-11-23T00:00 本地 = 2026-11-22T16:00Z
    const dt = new Date(Date.UTC(2026, 10, 22, 16, 0, 0));
    assert.equal(todayStr(dt.getTime()), '20261123');
    // 本地 2026-11-22 23:59:59 = 2026-11-22T15:59:59Z 仍算 11-22
    const dt2 = new Date(Date.UTC(2026, 10, 22, 15, 59, 59));
    assert.equal(todayStr(dt2.getTime()), '20261122');
  });
});

describe('bucketDayKey：秒级时间戳 → 本地时区 YYYYMMDD（分桶写文件用）', () => {
  test('本地时区 00:30（UTC 前一日 16:30）→ 分桶到本地当天（不是 UTC 前一日）', () => {
    // 2026-11-23 00:30 本地 (UTC+8) = 2026-11-22 16:30 UTC
    // 构造：找到 2026-11-23 本地 00:30 对应的 Unix 秒
    const localDt = new Date(2026, 10, 23, 0, 30, 0); // 本地 2026-11-23 00:30
    const tSec = Math.floor(localDt.getTime() / 1000);
    const key = bucketDayKey(tSec);
    assert.equal(key, '20261123', `本地 00:30 应分桶到 20261123，实际 ${key}`);
  });

  test('本地时区 23:30（UTC 次日 07:30）→ 分桶到本地当天', () => {
    // 2026-11-23 23:30 本地 (UTC+8) = 2026-11-23 15:30 UTC
    // 但如果 UTC+0 则 2026-11-23 23:30 = 2026-11-23 23:30 UTC，次日 00:30 UTC 才是 11-24
    // 测试点：本地 23:30 不应分桶到 UTC 次日
    const localDt = new Date(2026, 10, 23, 23, 30, 0); // 本地 2026-11-23 23:30
    const tSec = Math.floor(localDt.getTime() / 1000);
    const key = bucketDayKey(tSec);
    assert.equal(key, '20261123', `本地 23:30 应分桶到 20261123，实际 ${key}`);
  });

  test('与 todayStr 一致性：同一天内任意时刻分桶结果相同', () => {
    const localDt = new Date(2026, 10, 25, 12, 0, 0);
    const tSec = Math.floor(localDt.getTime() / 1000);
    assert.equal(bucketDayKey(tSec), todayStr(localDt.getTime()));
  });
});

describe('planStart：增量起点（旧 bug：maxDoneDay>=today 分支拼非法日期 / +100 错日期）', () => {
  test('最后完整日早于今天 → 从次日 0 点开始（秒）', () => {
    const [fromTs, overwriteDay] = planStart(20261120, 20261121);
    assert.equal(overwriteDay, null);
    assert.equal(fromTs, dayStartOf(20261121));
  });

  test('跨年场景：最后完整日 20261231，今天 20270102 → 从 20270101 0 点', () => {
    const [fromTs] = planStart(20261231, 20270102);
    assert.equal(fromTs, dayStartOf(20270101));
    assert.ok(fromTs > 1_000_000_000 && fromTs < 5_000_000_000, '必须落在 2027 年前后的秒级时间戳');
  });

  test('最后完整日就是今天 → 从当天 0 点补拉并标记当天文件', () => {
    const [fromTs, overwriteDay] = planStart(20261121, 20261121);
    assert.equal(overwriteDay, 20261121);
    assert.equal(fromTs, dayStartOf(20261121));
  });

  test('无历史数据 → fromTs=0（不移动起点）', () => {
    assert.deepEqual(planStart(0, 20261121), [0, null]);
  });
});

describe('端到端：现有数据场景复现（旧 bug 导致“无新数据”）', () => {
  test('最后完整日=昨天时，起点=今天 0 点（秒），窗口非空', () => {
    // 模拟：数据拉到 2026-11-22 全天，现在 2026-11-23
    const today = 20261123, maxDoneDay = 20261122;
    const [fromTs] = planStart(maxDoneDay, today);
    const nowSec = Math.floor(new Date(2026, 10, 23, 12, 0).getTime() / 1000);
    assert.ok(fromTs < nowSec, `起点 ${fromTs} 应早于当前 ${nowSec}，否则会被判“无新数据”`);
    assert.equal(fromTs, dayStartOf(20261123));
  });
});
