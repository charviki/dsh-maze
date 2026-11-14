#!/usr/bin/env node
/**
 * 路由层端到端冒烟：以假 cordis ctx 驱动 lib/index.js 的 apply()，把
 * /maze/notes/* 全部路由（含校验/错误出口/脱敏/config 落盘）对着本地
 * Vikunja 真跑一遍（NoteStore 直连层经路由间接全覆盖，无需独立脚本）；
 * 浏览器渲染层（NotesModule）仍留待 GUI 重启后人工确认。
 *
 * 前置：node dev/vikunja/bootstrap.mjs && npm run build
 * 副作用：运行期在插件自解析的数据目录（仓库内跑=主仓 data/dsh-maze/，
 * 已被主仓 .gitignore 覆盖）短暂落 notes-config.json，结束时删除
 */

import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as maze from '../../lib/index.js'; // cordis 插件用命名导出（apply/Config…），无默认导出
import { resolveDataDir, pluginRoot } from '../../lib/reminders/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const conn = JSON.parse(readFileSync(join(here, 'connection.json'), 'utf8'));
const machine = Object.keys(conn.machines)[0];
// 脚本要求从"未配置态"起步。数据目录由插件自解析（向上找 profile 根的
// data/dsh-maze——仓库内跑时落在主仓 <repo>/data/dsh-maze），不能硬编码；
// 结尾也会删掉，真实凭据以 connection.json 为准
const cfgFile = join(resolveDataDir(pluginRoot()), 'notes-config.json');
rmSync(cfgFile, { force: true });
const log = (s) => console.log(`[route-smoke] ${s}`);
const fail = (s) => { console.error(`[route-smoke] ✗ ${s}`); process.exit(1); };

// ---- 假 cordis ctx：只实现 apply 用到的面（on/inject/effect/logger） ----
const cleanups = [];
const routes = new Map(); // path → handler
const fakeCtx = {
  on: () => {}, // llm/stream、session/* 只记录不驱动（本冒烟不测调度）
  effect: (fn) => { cleanups.push(fn()); },
  inject: (deps, cb) => {
    assert.deepEqual(deps, ['webServer']);
    cb({
      webServer: { register: (def) => { routes.set(def.path, def.handler); return () => routes.delete(def.path); } },
      effect: (fn) => { cleanups.push(fn()); },
    });
  },
  logger: { warn: (s) => console.warn(`[maze-log] ${String(s)}`) },
};

typeof maze.apply === 'function' || fail('插件无 apply 导出');
maze.apply(fakeCtx, { rules: [] });
routes.has('/maze/notes/config') || fail('路由未注册');
log(`apply ✓（${String(routes.size)} 条路由注册）`);

// ---- 最小 req/res 桩：sendJson 只用 writeHead/end，readJsonBody 只用 on/destroy ----
function fakeReq(method, body) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const chunks = json === undefined ? [] : [json];
  return {
    method, url: '/maze/notes/x', headers: { host: '127.0.0.1:60469' },
    on: (ev, cb) => {
      if (ev === 'data' && chunks.length > 0) { const c = chunks.shift(); queueMicrotask(() => cb(c)); }
      if (ev === 'end') queueMicrotask(() => cb());
    },
    destroy: () => {},
  };
}
async function call(method, path, body) {
  const handler = routes.get(path);
  if (handler === undefined) fail(`路由 ${path} 未注册`);
  let status = -1; let payload = null;
  const res = {
    writeHead: (code) => { status = code; },
    end: (chunk) => { if (typeof chunk === 'string' && chunk !== '') { try { payload = JSON.parse(chunk); } catch { payload = chunk; } } },
  };
  await handler(fakeReq(method, body), res);
  return { status, payload };
}

// ---- 未配置态：GET 脱敏视图 + 业务路由 400 ----
let r = await call('GET', '/maze/notes/config');
r.status === 200 || fail(`未配置 GET 期望 200 得 ${String(r.status)}`);
r.payload.tokenSet === false || fail('未配置 tokenSet 应为 false');
r.payload.baseUrl === '' || fail('未配置 baseUrl 应为空');
r = await call('GET', '/maze/notes/list');
r.status === 400 || fail(`未配置 list 期望 400 得 ${String(r.status)}`);
log('未配置态 ✓（GET 脱敏视图 + 400 引导）');

// ---- PUT config：保存 + 活体测试 + Inbox 发现 ----
r = await call('PUT', '/maze/notes/config', {
  baseUrl: conn.baseUrl, machineName: machine, token: conn.machines[machine].token,
});
r.status === 200 && r.payload.connected === true && r.payload.user === machine
  || fail(`PUT config 失败: HTTP ${String(r.status)} ${JSON.stringify(r.payload)}`);
r = await call('GET', '/maze/notes/config');
r.payload.tokenSet === true && r.payload.machineName === machine && r.payload.token === undefined
  || fail(`GET config 脱敏失败: ${JSON.stringify(r.payload)}`);
typeof r.payload.inboxProjectId === 'number' || fail('Inbox id 未回写配置');
log('PUT/GET config ✓（connected=true，token 不回显，Inbox id 回写）');

// ---- 坏负载 400（fail-loud 校验面） ----
r = await call('POST', '/maze/notes/add', { text: '   ' });
r.status === 400 || fail(`空白速记应 400 得 ${String(r.status)}`);
r = await call('POST', '/maze/notes/promote', { id: 'x' });
r.status === 400 || fail(`坏 promote 负载应 400 得 ${String(r.status)}`);
log('坏负载 400 ✓');

// ---- 业务闭环（路由层 → 真实 Vikunja） ----
const stamp = new Date().toISOString();
r = await call('POST', '/maze/notes/add', { text: `路由冒烟 ${stamp}\n走完整 HTTP 路由栈` });
r.status === 200 && r.payload.note.title === `路由冒烟 ${stamp}` || fail(`add 失败: ${JSON.stringify(r.payload)}`);
const id = r.payload.note.id;
r = await call('GET', '/maze/notes/list');
r.payload.notes.some(n => n.id === id) || fail('list 未见新小记');
r = await call('POST', '/maze/notes/promote', { id, machine });
r.status === 200 && r.payload.note.assignees.includes(machine) || fail(`promote 失败: ${JSON.stringify(r.payload)}`);
r = await call('GET', '/maze/notes/tasks');
r.payload.tasks.some(n => n.id === id && n.started === false) || fail('tasks 未见新任务');
r = await call('POST', '/maze/notes/start', { id });
r.payload.note.started === true || fail('start 未生效');
// 回归断言：开工不得把 assignees 抹掉（曾整体覆盖为空 → 任务掉回小记池）
r.payload.note.assignees.includes(machine) || fail(`start 后 assignees=${JSON.stringify(r.payload.note.assignees)}`);
r = await call('GET', '/maze/notes/list');
r.payload.notes.some(n => n.id === id) && fail('start 后任务掉回未分配小记池');
r = await call('POST', '/maze/notes/complete', { id, summary: `路由冒烟完成 ${stamp}` });
r.payload.note.done === true || fail('complete 未生效');
r = await call('GET', '/maze/notes/tasks');
r.payload.tasks.some(n => n.id === id) && fail('完成后任务仍在列表');
log('业务闭环 ✓（add→list→promote→tasks→start→complete）');

// ---- 错误出口：坏 token → 502 带中文 message ----
r = await call('PUT', '/maze/notes/config', { token: 'tk_bogus' });
r.status === 502 || fail(`坏 token 期望 502 得 ${String(r.status)}`);
typeof r.payload.error === 'string' && r.payload.error !== '' || fail('502 缺 error message');
// 恢复真配置（脚本可重复跑）
r = await call('PUT', '/maze/notes/config', { token: conn.machines[machine].token });
r.status === 200 || fail('恢复配置失败');
log('502 错误出口 ✓（坏 token 场景）');

// ---- 清理：冒烟任务 + 恢复未配置态 + 卸载插件 ----
const del = await fetch(`${conn.baseUrl}/api/v1/tasks/${String(id)}`, {
  method: 'DELETE', headers: { authorization: `Bearer ${conn.machines[machine].token}` },
});
del.ok || fail(`清理任务失败 HTTP ${String(del.status)}`);
for (const fn of cleanups) fn();
routes.size === 0 || fail('卸载后路由未清空');
rmSync(cfgFile, { force: true }); // 不留含 token 的落盘痕迹（重跑用 connection.json）
log('清理与卸载 ✓（冒烟任务、插件 effect、配置文件）');
console.log('[route-smoke] 路由层全链路通过 ✓');
