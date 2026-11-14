#!/usr/bin/env node
/**
 * 渲染层冒烟：用 jsdom 跑 dev/ui-preview/index.html（假宿主页），驱动真实的
 * client/client.js 两个槽位组件并断言 小记 Tab 的完整交互链。
 * 与 dev/vikunja/route-smoke.mjs（服务端路由层）互补，覆盖最上层——
 * 无需 dsh 桌面应用重启即可回归 UI。真浏览器目检可开
 * http://127.0.0.1:8124/dsh-maze/dev/ui-preview/（见 index.html 头注释）。
 *
 * 前置：repo 根起静态服务（python3 -m http.server 8124 --directory <repo 根>）
 * 依赖：jsdom 取自主仓 devDependencies（Node ESM 向上解析命中）。
 */

import { JSDOM } from 'jsdom';

const URL_BASE = 'http://127.0.0.1:8124/dsh-maze/dev/ui-preview/';
const log = (s) => console.log(`[ui-smoke] ${s}`);
const fail = (s) => { console.error(`[ui-smoke] ✗ ${s}`); process.exit(1); };

const dom = await JSDOM.fromURL(URL_BASE, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  // jsdom 无 fetch/Response：垫上 Node 全局，页内 shim 再包一层 /maze/ 拦截。
  // undici fetch 不解析相对路径（真浏览器按文档基址解析），驱动侧补绝对化
  beforeParse: (window) => {
    window.fetch = (input, init) => globalThis.fetch(
      new URL(typeof input === 'string' ? input : input.url, window.location.href).href, init);
    window.Response = globalThis.Response;
  },
});
const { window } = dom;
const doc = window.document;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 轮询断言：React 状态更新与 refresh 是异步的，条件成立即返回 */
async function until(desc, fn, { timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v === true || (v !== undefined && v !== null && v !== false)) return v;
    if (Date.now() > deadline) fail(`等待超时: ${desc}`);
    await sleep(100);
  }
}
const q = (sel) => doc.querySelector(sel);
const buttonByText = (text, root = doc) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
/** React 受控输入：必须走原生 value setter + input 事件，直接赋 value 会被 React 吞掉 */
const setInputValue = (el, value) => {
  const proto = el instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const fetchLog = () => window.__fetchLog;
const lastCall = (method, path) => [...fetchLog()].reverse().find((c) => c.method === method && c.path === path);

await until('页面 harnessReady', () => window.__harnessReady === true, { timeout: 15_000 });
log('假宿主页装载 ✓（settings.section + shell.overlay 已渲染）');

// ---- 1. Tab 条：四个模块齐全，切到 小记 ----
const tabLabels = () => [...doc.querySelectorAll('button.dshm-tab')].map((b) => b.textContent?.trim());
await until('Tab 条出现', () => q('button.dshm-tab') !== null);
const labels = tabLabels();
['个性化', '接待员', '提醒', '小记'].every((t) => labels.includes(t)) || fail(`Tab 不齐: ${JSON.stringify(labels)}`);
click(buttonByText('小记'));
// 已连接时表单默认收起为状态徽标行（seed 是已配置态），点「编辑」才展开
await until('连接状态徽标出现', () => doc.querySelector('.dshm-conn-dot.on') !== null);
const earlyStatus = doc.querySelector('.dshm-conn-status')?.textContent ?? '';
earlyStatus.includes('已连接（mac-mini）') || fail(`初始徽标=${earlyStatus}`);
click(buttonByText('编辑'));
await until('连接表单展开', () => buttonByText('保存并测试') !== undefined);
log('Tab 条 ✓（4 模块齐全，切到小记；已连接态徽标+表单默认收起，「编辑」展开）');

// ---- 2. 连接设置：脱敏视图播种草稿 ----
const inputs = [...doc.querySelectorAll('input.dshm-input')];
const byPlaceholder = (ph) => inputs.find((i) => i.placeholder === ph);
const baseUrlInput = byPlaceholder('http://localhost:3456') ?? fail('找不到 baseUrl 输入框');
baseUrlInput.value === 'http://localhost:3456' || fail(`baseUrl 草稿=${baseUrlInput.value}`);
const machineInput = byPlaceholder('留空，连接成功后自动回填') ?? fail('找不到机器名输入框');
machineInput.value === 'mac-mini' || fail(`机器名草稿=${machineInput.value}`);
const tokenInput = [...doc.querySelectorAll('input[type=password]')].at(-1) ?? fail('找不到 token 输入框');
tokenInput.value === '' || fail('token 明文不应回显到草稿');
tokenInput.placeholder.includes('留空保留') || fail(`token placeholder=${tokenInput.placeholder}`);
log('连接设置 ✓（baseUrl/机器名播种，token 只报有无不回显）');

// ---- 3. fixtures 渲染：小记列表 + 本机任务 ----
await until('小记卡片出现', () => doc.querySelectorAll('.dshm-note-card').length >= 4);
const cardTitles = () => [...doc.querySelectorAll('.dshm-note-title')].map((e) => e.textContent ?? '');
const titles = cardTitles();
titles.includes('调研 TriliumNext') || fail(`小记列表缺 fixture: ${JSON.stringify(titles)}`);
titles.some((t) => t.includes('跑通 route-smoke')) || fail('任务列表缺 fixture');
titles.some((t) => t.includes('跑通 route-smoke') && t.includes('进行中')) || fail('started 徽标未渲染');
titles.some((t) => t.includes('补 README 小记章节')) || fail('未开始任务缺卡');
buttonByText('开工') !== undefined || fail('开工按钮缺失');
doc.querySelector('datalist#dshm-note-machines') !== null || fail('机器名 datalist 缺失');
log('小记/任务列表 ✓（fixture 渲染、进行中徽标、datalist）');

// ---- 4. 速记：输入 → 记下 → POST + 新卡 ----
const textarea = doc.querySelector('textarea.dshm-textarea') ?? fail('找不到速记输入框');
setInputValue(textarea, '冒烟速记标题\n第二行详情');
click(buttonByText('记下（⌘/Ctrl+↵）'));
await until('POST /maze/notes/add', () => lastCall('POST', '/maze/notes/add'));
const addBody = lastCall('POST', '/maze/notes/add').body;
addBody.text.startsWith('冒烟速记标题') || fail(`add body=${JSON.stringify(addBody)}`);
await until('新速记上屏', () => cardTitles().some((t) => t.startsWith('冒烟速记标题')));
textarea.value === '' || fail('记下后速记框未清空');
log('速记 ✓（POST add + 新卡片 + 输入框清空）');

// ---- 4b. 删除两步确认：首点武装变「确认删除」（零请求），再点才 POST + 卡片消失 ----
const delCard = () => [...doc.querySelectorAll('.dshm-note-card')]
  .find((c) => (c.querySelector('.dshm-note-title')?.textContent ?? '').includes('冒烟速记标题'));
const delCardButton = (label) => [...delCard().querySelectorAll('button')]
  .find((b) => b.textContent?.trim() === label);
click(delCardButton('删除'));
await until('删除按钮武装', () => delCard() !== undefined
  && [...delCard().querySelectorAll('button')].some((b) => b.textContent?.trim() === '确认删除'));
fetchLog().some((c) => c.method === 'POST' && c.path === '/maze/notes/delete') === false
  || fail('两步确认失效：首点就发出了 delete 请求');
click(delCardButton('确认删除'));
await until('POST /maze/notes/delete', () => lastCall('POST', '/maze/notes/delete'));
const delBody = lastCall('POST', '/maze/notes/delete').body;
typeof delBody.id === 'number' || fail(`delete body=${JSON.stringify(delBody)}`);
await until('删除后卡片消失', () => [...doc.querySelectorAll('.dshm-note-card')]
  .every((c) => !(c.querySelector('.dshm-note-title')?.textContent ?? '').includes('冒烟速记标题')));
log('删除 ✓（首点武装零请求 → 再点 POST delete + 卡片移除）');

// ---- 5. 转任务：展开 → 默认本机名 → 改 mbp → 分配 ----
click(buttonByText('转任务'));
const machineFill = await until('转任务行展开', () => doc.querySelector('input[placeholder=机器名]'), { timeout: 3000 });
machineFill.value === 'mac-mini' || fail(`转任务默认机器名=${machineFill.value}`);
setInputValue(machineFill, 'mbp');
click(buttonByText('分配'));
await until('POST /maze/notes/promote', () => lastCall('POST', '/maze/notes/promote'));
const promoteBody = lastCall('POST', '/maze/notes/promote').body;
promoteBody.machine === 'mbp' || fail(`promote body=${JSON.stringify(promoteBody)}`);
await until('分配行收起', () => doc.querySelector('input[placeholder=机器名]') === null);
log('转任务 ✓（默认本机名，分配到 mbp，行收起）');

// ---- 5b. 转任务展开后可取消：纯收起，不产生新请求 ----
const promoteCalls = () => fetchLog().filter((c) => c.method === 'POST' && c.path === '/maze/notes/promote').length;
const beforeCancel = promoteCalls();
click(buttonByText('转任务'));
const cancelRowInput = await until('转任务行再次展开', () => doc.querySelector('input[placeholder=机器名]'), { timeout: 3000 });
// 连接表单此时仍展开、也有「取消」按钮——按标题找会点错，必须锚定展开行
const cancelBtn = [...cancelRowInput.closest('.dshm-note-ops').querySelectorAll('button')]
  .find((b) => b.textContent?.trim() === '取消') ?? fail('展开行里找不到取消按钮');
click(cancelBtn);
await until('取消后行收起', () => doc.querySelector('input[placeholder=机器名]') === null);
promoteCalls() === beforeCancel || fail('取消不应发出 promote 请求');
log('转任务取消 ✓（展开→取消→收起，零请求）');

// ---- 6. 开工 → 进行中徽标；完成 → 卡片消失 ----
/** 按标题找卡片：多张卡会有同名按钮（103/104 都有"完成"），必须先锚定卡片 */
const cardOf = (title) => [...doc.querySelectorAll('.dshm-note-card')]
  .find((c) => (c.querySelector('.dshm-note-title')?.textContent ?? '').includes(title));
const cardButton = (title, label) => [...cardOf(title).querySelectorAll('button')]
  .find((b) => b.textContent?.trim() === label);
click(cardButton('补 README 小记章节', '开工'));
await until('POST /maze/notes/start', () => lastCall('POST', '/maze/notes/start'));
await until('进行中徽标上屏', () => cardTitles().some((t) => t.includes('补 README 小记章节') && t.includes('进行中')));
click(cardButton('补 README 小记章节', '完成'));
await until('POST /maze/notes/complete', () => lastCall('POST', '/maze/notes/complete'));
const completeBody = lastCall('POST', '/maze/notes/complete').body;
completeBody.id === 104 || fail(`完成的是错的任务: ${JSON.stringify(completeBody)}`);
await until('完成后卡片消失', () => cardTitles().every((t) => !t.includes('补 README 小记章节')));
await until('完成后卡片消失', () => !cardTitles().some((t) => t.includes('补 README 小记章节')));
log('开工/完成 ✓（start POST + 徽标；complete POST + 卡片移除）');

// ---- 7. 保存并测试：PUT config（token 留空=不改；机器名留空=服务端按 token 身份回填） ----
setInputValue(baseUrlInput, 'http://localhost:3456');
setInputValue(machineInput, '');
click(buttonByText('保存并测试'));
await until('PUT /maze/notes/config', () => lastCall('PUT', '/maze/notes/config'));
const putBody = lastCall('PUT', '/maze/notes/config').body;
putBody.token === undefined || fail('token 留空不应随 PUT 发送');
putBody.machineName === '' || fail(`机器名应留空提交: ${JSON.stringify(putBody)}`);
await until('成功后表单收起', () => buttonByText('编辑') !== undefined);
const savedStatus = doc.querySelector('.dshm-conn-status')?.textContent ?? '';
savedStatus.includes('已连接（mac-mini）') || fail(`保存后徽标=${savedStatus}`);
// 0.0.4：重开编辑，机器名草稿应已按 token 身份自动回填（手误自动纠正）
click(buttonByText('编辑'));
await until('表单再次展开', () => buttonByText('保存并测试') !== undefined);
const inputsRe = [...doc.querySelectorAll('input.dshm-input')];
const machineRe = inputsRe.find((i) => i.placeholder === '留空，连接成功后自动回填') ?? fail('回填检查找不到机器名输入框');
machineRe.value === 'mac-mini' || fail(`机器名未自动回填: ${String(machineRe.value)}`);
click(buttonByText('取消')); // 收起，让 7b 从摘要态起步
await until('表单收起', () => buttonByText('编辑') !== undefined);
log('保存并测试 ✓（留空 token 不重发；机器名留空自动回填；成功收起回徽标行）');

// ---- 7b. 重置路径：编辑→清空 baseUrl+机器名再保存，反馈必须是"已保存（未连接…）"
// 而非把 connected:false 的缺 user 渲染成"已连接（undefined）"（真实 GUI 踩过的坑）
click(buttonByText('编辑'));
await until('表单再次展开', () => buttonByText('保存并测试') !== undefined);
// 收起/再展开会重建 DOM，旧引用已失效，必须重查
const inputsReset = [...doc.querySelectorAll('input.dshm-input')];
const byPlaceholderReset = (ph) => inputsReset.find((i) => i.placeholder === ph);
setInputValue(byPlaceholderReset('http://localhost:3456') ?? fail('重置时找不到 baseUrl 输入框'), '');
setInputValue(byPlaceholderReset('留空，连接成功后自动回填') ?? fail('重置时找不到机器名输入框'), '');
click(buttonByText('保存并测试'));
await until('重置路径的已保存反馈', () => [...doc.querySelectorAll('.dshm-editor-msg')].some((e) => e.textContent?.includes('已保存（未连接')));
const resetMsg = [...doc.querySelectorAll('.dshm-editor-actions span')].map((e) => e.textContent ?? '').join('');
!resetMsg.includes('undefined') || fail(`重置路径反馈出现 undefined: ${resetMsg}`);
doc.querySelector('.dshm-conn-dot.on') === null || fail('重置后徽标应转灰');
(doc.querySelector('.dshm-conn-status')?.textContent ?? '').includes('未连接：填好') || fail('重置后状态文案错误');
log('重置路径反馈 ✓（connected:false 显示"已保存（未连接）"，无 undefined，徽标转灰）');

// ---- 8. 悬浮球槽位 + 无页面错误 ----
doc.querySelector('.dshm-ball, .dshm-ball-wrap, [class*=dshm-ball]') !== null
  || fail('shell.overlay 悬浮球未渲染');
const pageErrors = window.__errors.filter((e) => !e.includes('Not implemented'));
pageErrors.length === 0 || fail(`页面报错: ${JSON.stringify(pageErrors)}`);
log('悬浮球渲染 ✓，页面零报错 ✓');

window.close();
console.log('[ui-smoke] 渲染层全链路通过 ✓');
process.exit(0);
