/**
 * store.ts 纯函数单测：速记切分、task→note 映射、阶段谓词、排序。
 * 运行时行为（Vikunja HTTP 往返）由 dev/vikunja/smoke.mjs 活体验证。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  byUpdatedDesc,
  isClaimedBy,
  isUnassignedNote,
  noteFromTask,
  splitQuickNote,
} from './store.js';

test('splitQuickNote：单行文本整段作标题', () => {
  assert.deepEqual(splitQuickNote('修一下登录跳转'), { title: '修一下登录跳转', description: '' });
});

test('splitQuickNote：首行标题+余行描述（块外缘剥除，内部缩进保留——粘贴代码块友好）', () => {
  assert.deepEqual(
    splitQuickNote('  修一下登录跳转\n  回调丢了 code 参数\n  复现：GitHub 登录后白屏  '),
    { title: '修一下登录跳转', description: '回调丢了 code 参数\n  复现：GitHub 登录后白屏' },
  );
});

test('splitQuickNote：标题超 200 字符截断，溢出并入描述不丢内容', () => {
  const long = 'x'.repeat(260);
  const { title, description } = splitQuickNote(long);
  assert.equal(title.length, 200);
  // 60 个 x 溢出进描述，且与"无余行"拼接后不产生前导换行
  assert.equal(description, 'x'.repeat(60));
});

test('splitQuickNote：超长标题与余行同时存在时溢出在前', () => {
  const { title, description } = splitQuickNote(`${'y'.repeat(210)}\n详情行`);
  assert.equal(title.length, 200);
  assert.equal(description, `${'y'.repeat(10)}\n详情行`);
});

test('noteFromTask：完整 task 映射（assignees 取 username，start_date 决定 started）', () => {
  const note = noteFromTask({
    id: 7, title: '跑数据迁移', description: 'pg → sqlite', done: false,
    assignees: [{ id: 2, username: 'mac-mini' }], start_date: '2026-11-11T01:02:03Z',
    created: '2026-11-10T00:00:00Z', updated: '2026-11-11T01:02:03Z',
  });
  assert.deepEqual(note, {
    id: 7, title: '跑数据迁移', description: 'pg → sqlite', done: false,
    assignees: ['mac-mini'], started: true,
    createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-11T01:02:03Z',
  });
});

test('noteFromTask：字段缺失/类型漂移落空值不抛（wire 边界防御）', () => {
  const note = noteFromTask({ id: '7', assignees: null, start_date: '' });
  assert.equal(note.id, -1);
  assert.equal(note.title, '');
  assert.deepEqual(note.assignees, []);
  assert.equal(note.started, false);
  assert.equal(note.createdAt, null);
});

test('noteFromTask：Go 零值时间 "0001-01-01" 不算已开工（Vikunja 未设 start_date 的实际返回）', () => {
  const note = noteFromTask({ id: 1, title: 't', start_date: '0001-01-01T00:00:00Z' });
  assert.equal(note.started, false);
  const started = noteFromTask({ id: 2, title: 't', start_date: '2026-11-11T01:00:00Z' });
  assert.equal(started.started, true);
});

test('阶段谓词：未完成无 assignee 是小记；未完成含机器是认领；done 一律不是', () => {
  const base = { id: 1, title: 't', description: '', createdAt: null, updatedAt: null, assignees: [], started: false };
  assert.equal(isUnassignedNote({ ...base, done: false }), true);
  assert.equal(isUnassignedNote({ ...base, done: false, assignees: ['mac'] }), false);
  assert.equal(isUnassignedNote({ ...base, done: true }), false);
  assert.equal(isClaimedBy({ ...base, done: false, assignees: ['mac', 'nas'] }, 'nas'), true);
  assert.equal(isClaimedBy({ ...base, done: true, assignees: ['nas'] }, 'nas'), false);
});

test('byUpdatedDesc：updated 新的排前；缺失时间的排最后（速记最新最重要）', () => {
  const mk = (id: number, updatedAt: string | null) => ({ id, title: '', description: '', createdAt: null, updatedAt, done: false, assignees: [], started: false });
  const sorted = [mk(1, null), mk(2, '2026-11-10T00:00:00Z'), mk(3, '2026-11-11T00:00:00Z')].sort(byUpdatedDesc);
  assert.deepEqual(sorted.map(n => n.id), [3, 2, 1]);
});
