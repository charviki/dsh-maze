#!/usr/bin/env node
/**
 * Vikunja 本地环境一键初始化（幂等，可重复跑）：
 *   1. .env（缺失则生成 VIKUNJA_SECRET）
 *   2. docker compose up -d + 等健康
 *   3. 注册 admin（charviki / dev-pass-123456，已存在即复用）
 *   4. 注册机器用户（默认 mac-mini，可用 argv 追加多个）
 *   5. 以机器用户身份建 scoped API token（tasks+projects 全 op keys；
 *      本地 dev 从简，生产应按实际调用面裁剪 scope）
 *   6. 建 Inbox 项目并共享给机器用户（读写）
 *   7. 落 connection.json（route-smoke 与设置页手工配置都用它）
 *
 * 用法：node dev/vikunja/bootstrap.mjs [机器用户名 ...]（默认 mac-mini）
 * 仅面向本机开发（127.0.0.1），凭据是 dev 弱口令，勿用于公网。
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// VIKUNJA_BASE 指向远端实例时走"仅供给"模式：跳过 .env/compose（那属于服务器端
// 服务器侧部署的职责），只做注册/建 token/建 Inbox（对远端同样幂等）
const BASE = process.env.VIKUNJA_BASE ?? 'http://127.0.0.1:3456';
const REMOTE = !/^(127\.|localhost)/.test(BASE);
const API = `${BASE}/api/v1`;
const ADMIN = { username: 'charviki', password: 'dev-pass-123456', email: 'charviki@local.dev' };
const MACHINE_PASSWORD = 'dev-machine-pass';
const machines = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['mac-mini'];
const log = (s) => console.log(`[bootstrap] ${s}`);

// ---- 1. .env + 2. compose up（仅本地模式；远端由服务器侧部署负责） ----
if (!REMOTE) {
  if (!existsSync(join(here, '.env'))) {
    writeFileSync(join(here, '.env'), `VIKUNJA_SECRET=${randomBytes(32).toString('hex')}\n`, 'utf8');
    log('生成 .env（VIKUNJA_SECRET）');
  } else {
    log('.env 已存在，复用');
  }
  execSync('docker compose up -d', { cwd: here, stdio: 'inherit' });
} else {
  log(`远端模式：目标 ${BASE}（跳过本地 .env/compose）`);
}
const info = await waitForHealth();
log(`Vikunja ${String(info.version)} 就绪`);

// ---- 3/4. 注册用户（已存在 400 → 登录验证后继续） ----
async function registerOrSkip(u) {
  const res = await fetch(`${API}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(u),
  });
  if (res.ok) { log(`注册用户 ${u.username}`); return; }
  const body = await res.text();
  // 400 且报已存在 → 幂等通过；其他错误（口令强度等）fail-loud
  if (res.status === 400 && /exist|username/i.test(body)) { log(`用户 ${u.username} 已存在，复用`); return; }
  throw new Error(`注册 ${u.username} 失败 HTTP ${String(res.status)}: ${body}`);
}
await registerOrSkip(ADMIN);
for (const m of machines) await registerOrSkip({ username: m, password: MACHINE_PASSWORD, email: `${m}@machine.local` });

// ---- 5. 机器用户 scoped token ----
// op keys 动态取自 /api/v1/routes（带 admin JWT），避免硬编码随版本漂移；
// 组名取 route key 前缀（tasks.create → 组 tasks）
const adminLogin = await mustJson(await fetch(`${API}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
}), 'admin 登录');
const adminToken = adminLogin.token;
const routes = await mustJson(await fetch(`${API}/routes`, { headers: { authorization: `Bearer ${adminToken}` } }), 'GET /routes');
const permissionGroups = {};
for (const [group, ops] of Object.entries(routes)) {
  if (group === 'tasks' || group === 'projects') {
    permissionGroups[group] = Object.keys(ops);
  }
}
// /user 归属 other 组：testConnection（身份验证）需要，只授这一项
permissionGroups.other = ['user'];
// promote 的机器名→user_id 解析走 GET /projects/{id}/projectusers（read_all）
permissionGroups.projects_users = ['read_all'];
// 指派 assignee 是 PUT /tasks/{id}/assignees（独立组，不在 tasks 组内）
permissionGroups.tasks_assignees = ['create'];
// 完成摘要回写走 PUT /tasks/{id}/comments（独立组）
permissionGroups.tasks_comments = ['create'];
log(`token scope：tasks ${String(permissionGroups.tasks?.length ?? 0)}、projects ${String(permissionGroups.projects?.length ?? 0)}、projects_users:read_all、tasks_assignees:create、tasks_comments:create、other:user`);

async function tokenFor(username, password) {
  const login = await mustJson(await fetch(`${API}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }), `登录 ${username}`);
  const res = await fetch(`${API}/tokens`, {
    method: 'PUT',
    // 实测 v2.8：token 管理端点认 Bearer JWT（Basic 反而 401）
    headers: { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: `dsh-maze ${new Date().toISOString().slice(0, 10)}`,
      permissions: permissionGroups,
      // v2.8 实测：expires_at 必填（"non zero value required"，不支持永久），
      // dev 环境给 10 年远期；生产应按机器轮换周期设短
      expires_at: new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000).toISOString(),
    }),
  });
  const created = await mustJson(res, `为 ${username} 建 token`);
  return created.token;
}

// ---- 6. Inbox 项目 + 共享 ----
const projects = await mustJson(await fetch(`${API}/projects`, { headers: { authorization: `Bearer ${adminToken}` } }), '列项目');
let inbox = (Array.isArray(projects) ? projects : []).find(p => p.title === 'Inbox');
if (inbox === undefined) {
  inbox = await mustJson(await fetch(`${API}/projects`, {
    method: 'PUT', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Inbox' }),
  }), '建 Inbox');
  log(`已建 Inbox 项目 id=${String(inbox.id)}`);
} else {
  log(`Inbox 已存在 id=${String(inbox.id)}`);
}
for (const m of machines) {
  const res = await fetch(`${API}/projects/${String(inbox.id)}/users`, {
    method: 'PUT', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username: m, permission: 1 }), // 1 = 读写
  });
  if (res.ok) { log(`Inbox 已共享给 ${m}（读写）`); continue; }
  const body = await res.text();
  // 已共享过 → 幂等通过
  if (/already|exist/i.test(body)) { log(`Inbox 与 ${m} 已共享，复用`); continue; }
  throw new Error(`共享 Inbox 给 ${m} 失败 HTTP ${String(res.status)}: ${body}`);
}

// ---- 7. connection.json（smoke 与手工配置的数据源；gitignore 掉） ----
const connections = {};
for (const m of machines) connections[m] = { token: await tokenFor(m, MACHINE_PASSWORD) };
writeFileSync(join(here, 'connection.json'), `${JSON.stringify({
  baseUrl: BASE,
  inboxProjectId: inbox.id,
  machines: connections,
}, null, 2)}\n`, 'utf8');
log(`已写 ${join(here, 'connection.json')}（机器：${machines.join(', ')}）`);
log('下一步：node dev/vikunja/route-smoke.mjs 冒烟验证全链路');

// ---- 工具 ----
async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${API}/info`);
      if (res.ok) return await res.json();
    } catch { /* 未就绪：容器还在起，继续等 */ }
    if (Date.now() > deadline) throw new Error('Vikunja 60s 内未就绪');
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function mustJson(res, what) {
  const body = await res.text();
  if (!res.ok) throw new Error(`${what} 失败 HTTP ${String(res.status)}: ${body}`);
  return JSON.parse(body);
}
