import test from 'node:test';
import assert from 'node:assert/strict';
import { NotifyTracker, type NotifyTuning } from './notify.js';

// 快进时钟的调参（真实默认 30s/10min/10min，测试全用毫秒级）
const T: NotifyTuning = { approvalDelayMs: 100, approvalRenagMs: 1_000, stuckSilenceMs: 500 };

test('NotifyTracker：审批 asked 后到时首提，decided 即清', () => {
  const t = new NotifyTracker(T);
  t.observe('s1', 'approval/asked', undefined, 0);
  assert.deepEqual(t.collectDue(50), []); // 未到首提延迟
  const due = t.collectDue(150);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.kind, 'approval');
  assert.equal(due[0]!.sessionId, 's1');
  assert.equal(due[0]!.since, 0);
  t.observe('s1', 'approval/decided', undefined, 200);
  assert.deepEqual(t.collectDue(300), []);
});

test('NotifyTracker：审批按节律补提；同会话重复 asked 只记最早', () => {
  const t = new NotifyTracker(T);
  t.observe('s1', 'approval/asked', undefined, 0);
  assert.equal(t.collectDue(150).length, 1); // 首提
  assert.deepEqual(t.collectDue(200), []); // 间隔内不补
  t.observe('s1', 'approval/asked', undefined, 300); // 第二笔审批：不重置等待起点
  assert.equal(t.collectDue(1_300).length, 1); // 补提，since 仍是 0
  assert.deepEqual(t.collectDue(1_400), []);
});

test('NotifyTracker：卡死=running 且静默超阈，只报一次，事件恢复重置', () => {
  const t = new NotifyTracker(T);
  t.observe('s1', 'turn/start', undefined, 0);
  t.observe('s1', 'tool/call', undefined, 100); // 活着
  assert.deepEqual(t.collectDue(400), []); // 静默 300ms 未到阈值
  const due = t.collectDue(700); // 静默 600ms ≥ 500
  assert.equal(due.length, 1);
  assert.equal(due[0]!.kind, 'stuck');
  assert.equal(due[0]!.since, 100); // since=最后事件时间
  assert.deepEqual(t.collectDue(900), []); // 持续静默不补提
  t.observe('s1', 'tool/result', undefined, 1_000); // 活过来了
  assert.deepEqual(t.collectDue(1_300), []); // 重新计时
  const again = t.collectDue(1_700); // 又静默 700ms
  assert.equal(again.length, 1); // 再报一次（新一轮卡死）
});

test('NotifyTracker：turn/end 终止卡死观察；无关事件不凭空建账', () => {
  const t = new NotifyTracker(T);
  t.observe('s1', 'turn/start', undefined, 0);
  t.observe('s1', 'turn/end', undefined, 50);
  assert.deepEqual(t.collectDue(10_000), []); // 没在观察
  t.observe('s2', 'tool/call', undefined, 0); // 未 turn/start 的会话
  assert.deepEqual(t.collectDue(10_000), []);
});

test('NotifyTracker：跨会话并行记账互不干扰', () => {
  const t = new NotifyTracker(T);
  t.observe('a', 'approval/asked', undefined, 0);
  t.observe('b', 'turn/start', undefined, 0);
  const due = t.collectDue(600);
  assert.equal(due.length, 2); // a 的审批 + b 的卡死
  assert.deepEqual(due.map((n) => `${n.kind}:${n.sessionId}`).sort(), ['approval:a', 'stuck:b']);
});

test('NotifyTracker：多笔审批计数——decided 一笔不误杀剩余', () => {
  const t = new NotifyTracker(T);
  t.observe('s1', 'approval/asked', undefined, 0);
  t.observe('s1', 'approval/asked', undefined, 100); // 叠第二笔
  t.observe('s1', 'approval/decided', undefined, 200); // 决掉一笔
  const due = t.collectDue(600); // 还挂着一笔：仍要提示，口径用最早 askedAt
  assert.equal(due.length, 1);
  assert.equal(due[0]!.kind, 'approval');
  assert.equal(due[0]!.since, 0);
  t.observe('s1', 'approval/decided', undefined, 700); // 决掉最后一笔
  assert.deepEqual(t.collectDue(10_000), []); // 清零
});

test('NotifyTracker：session/disposed 连审批一起清（死会话不永生补提）', () => {
  const t = new NotifyTracker(T);
  t.observe('s1', 'approval/asked', undefined, 0);
  t.observe('s1', 'session/disposed', undefined, 100);
  assert.deepEqual(t.collectDue(10_000), []);
});

test('NotifyTracker：ask_user_question 问题卡——弹出/作答/多卡并行', () => {
  const t = new NotifyTracker(T);
  t.observe('s1', 'tool/call', { name: 'ask_user_question', callId: 'c1' }, 0);
  assert.deepEqual(t.collectDue(50), []); // 首提延迟未到
  const due = t.collectDue(150); // 首提：kind=question，since=最早
  assert.equal(due.length, 1);
  assert.equal(due[0]!.kind, 'question');
  assert.equal(due[0]!.since, 0);
  t.observe('s1', 'tool/call', { name: 'bash', callId: 'c2' }, 200); // 无关工具不算问题卡
  t.observe('s1', 'tool/result', { message: { toolCallId: 'c2' } }, 250);
  assert.deepEqual(t.collectDue(300), []); // c1 挂着但补提未到间隔（lastNagAt=150，间隔 1000）
  t.observe('s1', 'tool/call', { name: 'ask_user_question', callId: 'c3' }, 400); // 叠第二张卡
  t.observe('s1', 'tool/result', { message: { toolCallId: 'c1' } }, 500); // 答掉第一张
  const still = t.collectDue(2_000); // c3 仍挂着：仍要提示，口径用最早 askedAt=0
  assert.equal(still.length, 1);
  assert.equal(still[0]!.since, 0);
  t.observe('s1', 'tool/result', { message: { toolCallId: 'c3' } }, 600); // 全部答完
  assert.deepEqual(t.collectDue(20_000), []);
});

test('NotifyTracker：session/disposed 也清问题卡', () => {
  const t = new NotifyTracker(T);
  t.observe('s1', 'tool/call', { name: 'ask_user_question', callId: 'c1' }, 0);
  t.observe('s1', 'session/disposed', undefined, 100);
  assert.deepEqual(t.collectDue(10_000), []);
});
