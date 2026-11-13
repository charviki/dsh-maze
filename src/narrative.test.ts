import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentDemeanor,
  narrativeEventToDemeanor,
  pickDemeanorRecord,
  DemeanorRecord,
  STALE_MS,
  TRANSIENT_MS,
} from './narrative.js';

const T0 = 1_760_000_000_000;

test('叙事事件映射：覆盖七神态', () => {
  assert.equal(narrativeEventToDemeanor('turn/start'), 'waiting');
  assert.equal(narrativeEventToDemeanor('assistant/attempt'), 'thinking');
  assert.equal(narrativeEventToDemeanor('tool/call'), 'tool');
  assert.equal(narrativeEventToDemeanor('tool/result'), 'thinking');
  assert.equal(narrativeEventToDemeanor('compaction/start'), 'review');
  assert.equal(narrativeEventToDemeanor('compaction/end'), 'review');
  assert.equal(narrativeEventToDemeanor('llm/retry'), 'failed');
});

test('turn/end 按 reason.kind 分流：completed→done，blocked/aborted→idle，其他→failed', () => {
  assert.equal(narrativeEventToDemeanor('turn/end', 'completed'), 'done');
  assert.equal(narrativeEventToDemeanor('turn/end', 'blocked'), 'idle');
  assert.equal(narrativeEventToDemeanor('turn/end', 'aborted'), 'idle');
  assert.equal(narrativeEventToDemeanor('turn/end', 'error'), 'failed');
  // reason 缺失也按失灵处理（防御分支）
  assert.equal(narrativeEventToDemeanor('turn/end'), 'failed');
});

test('无关事件返回 undefined（不更新神态）', () => {
  assert.equal(narrativeEventToDemeanor('session/title'), undefined);
  assert.equal(narrativeEventToDemeanor('command/run'), undefined);
  assert.equal(narrativeEventToDemeanor('step/start'), undefined);
});

test('从未开始叙事 = 待机', () => {
  assert.equal(currentDemeanor(undefined, T0), 'idle');
});

test('瞬态神态（done/failed）超过 TRANSIENT_MS 回落待机（边界为严格大于）', () => {
  const done: DemeanorRecord = { demeanor: 'done', at: T0 };
  assert.equal(currentDemeanor(done, T0 + TRANSIENT_MS), 'done');
  assert.equal(currentDemeanor(done, T0 + TRANSIENT_MS + 1), 'idle');
  const failed: DemeanorRecord = { demeanor: 'failed', at: T0 };
  assert.equal(currentDemeanor(failed, T0 + TRANSIENT_MS + 1), 'idle');
});

test('持续神态（thinking/tool）超过 STALE_MS 过期回待机（边界为严格大于）', () => {
  const thinking: DemeanorRecord = { demeanor: 'thinking', at: T0 };
  assert.equal(currentDemeanor(thinking, T0 + TRANSIENT_MS), 'thinking');
  assert.equal(currentDemeanor(thinking, T0 + STALE_MS), 'thinking');
  assert.equal(currentDemeanor(thinking, T0 + STALE_MS + 1), 'idle');
});

test('时钟回拨（now < at）保守沿用原神态', () => {
  const record: DemeanorRecord = { demeanor: 'tool', at: T0 };
  assert.equal(currentDemeanor(record, T0 - 5_000), 'tool');
});

test('pickDemeanorRecord：优先当前会话自己的桶', () => {
  const bySession = new Map<string, DemeanorRecord>([
    ['a', { demeanor: 'thinking', at: T0 }],
    ['b', { demeanor: 'idle', at: T0 + 100 }],
  ]);
  assert.equal(pickDemeanorRecord(bySession, 'a')?.demeanor, 'thinking');
  assert.equal(pickDemeanorRecord(bySession, 'b')?.demeanor, 'idle');
});

test('pickDemeanorRecord：指定会话无记录时返回 undefined（不串台）', () => {
  const bySession = new Map<string, DemeanorRecord>([
    ['a', { demeanor: 'thinking', at: T0 }],
    ['b', { demeanor: 'tool', at: T0 + 100 }],
  ]);
  // 后台 b 在跑，正在查看的 c 没有自己的桶 → 必须 undefined（客户端兜底
  // idle），不能回退拿 b 的 tool——那是跨会话污染
  assert.equal(pickDemeanorRecord(bySession, 'c'), undefined);
  // 会话未知（旧运行时拿不到 useSessions）才回退全局最近活跃
  assert.equal(pickDemeanorRecord(bySession, undefined)?.demeanor, 'tool');
});

test('pickDemeanorRecord：空 map 返回 undefined（currentDemeanor 归 idle）', () => {
  assert.equal(pickDemeanorRecord(new Map(), 'a'), undefined);
  assert.equal(currentDemeanor(pickDemeanorRecord(new Map(), 'a'), T0), 'idle');
});
