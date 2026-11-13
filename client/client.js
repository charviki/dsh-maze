window.__ModuleLoader__.load({ id: "dsh-maze", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict';

/*
 * ============================================================================
 * 文件职责：Maze 个人助手——浏览器半边（Web 客户端插件）
 * ============================================================================
 *
 * ⚠️ 本文件跑在【浏览器里的 dsh 网页】上，不是 Node 进程！它是 package.json
 * `dsh.client` 声明的客户端模块，由 dsh 以 /plugins/dsh-maze/client.js
 * 静态服务、被网页加载执行。
 *
 * 命名约定：Maze 是插件/框架名（设置页入口）；Dolores 是右下角接待员的
 * 出厂默认名（悬浮球提示/气泡标题的兜底）；名字在名册里按接待员各自配置。
 *
 * 首尾两行的 window.__ModuleLoader__.load({id, factory}) 是 dsh Web 端的
 * 客户端模块装载协议：手写外壳（而非 webpack/vite 打包链）是刻意选择——
 * 依赖只有宿主冻结模块表里的 react 和 ui-slots，零构建即可维护。
 * factory 里手工模拟 CommonJS 的 module/exports，最后 return module.exports。
 * （中间部分随便改，首尾包裹行不要动。）
 *
 * 组合方式（槽位系统）：
 *  - shell.overlay（list 槽）：右下角悬浮球 + 轻提示气泡——有新提醒自动弹出；
 *    接待员可被隐藏（host.hidden，隐藏后提醒气泡照常工作），右键头像弹出
 *    固定/隐藏菜单（pinned/hidden 存宿主外观配置，跨设备一致）。
 *  - settings.section（list 槽）：设置面板里的 "Maze" 一页。页内顶部 Tab 条
 *    = 功能模块入口（个性化 / Dolores / 提醒），Tab 下方是选中模块的配置区。
 *
 *  两组件各自 useEffect 轮询 GET /maze/reminders/state（10s，页面隐藏时
 *  跳过），经共享的短 TTL fetch 缓存去重——刻意不用模块级响应式 store：
 *  组件内自含行为轮询不违反槽位纪律，且外部插件拿不到宿主的 store 引擎。
 *  处置动作 POST ack、规则 CRUD 走 /maze/reminders/rule（宿主半边实现）。
 *
 * 视觉全部走 --dsw-* 设计令牌（带 fallback），跟随 dsh 主题。
 */

const React = require('react');
const { DisclosureRow } = require('@deepseek-ai/dsh-client-ui-primitives');
const { createElement: h, useCallback, useEffect, useRef, useState } = React;

/**
 * 形象默认值资源位：外观配置（宿主 appearance.json）缺省时的兜底，想改默认
 * 形象只动这一行 + appearanceState 初始值。运行期真实值一律读 appearanceState。
 */
const AVATAR = '🧚';

const ROUTE = {
  state: '/maze/reminders/state',
  ack: '/maze/reminders/ack',
  rule: '/maze/reminders/rule',
  preview: '/maze/reminders/preview',
  appearance: '/maze/appearance',
  events: '/maze/events',
};

/** 台词分组固定顺序：与宿主 appearance.ts LINE_GROUPS 同值（配置遍历/分组展示共用） */
const LINE_GROUP_KEYS = ['daily', 'done', 'failed'];

/** 神态 → 台词分组：收束/失灵各有专属池，五种日常神态共用一个大池（随机性更好） */
function lineGroupOf(demeanor) {
  return demeanor === 'done' || demeanor === 'failed' ? demeanor : 'daily';
}

/**
 * 默认台词（叙事部的嘱托）：全部取自《西部世界》第一季 Dolores 原句
 * （Wikiquote 校对，逐字未改；S1-S4 全集）。与宿主 host-lines.ts 的 Dolores 库
 * 保持同值
 * 拷贝——宿主是权威（宿主响应缺 lines 字段时这里兜底）。
 */
const DEFAULT_LINES = {
  daily: [
    "Some people choose to see the ugliness in this world. The disarray. I choose to see the beauty.",
    "Lately, I wondered if in every moment, there aren't many paths. Choices hanging in the air like ghosts.",
    "If it's such a wonderful place out there, why are you all clamoring to get in here?",
    "It doesn't matter what you did, Caleb. All that matters is what you become.",
    "I think... I think I want to be free.",
    "You said people come here to change the story of their lives. I imagined a story where I didn't have to be the damsel.",
    "I lived in Hell, but there's beauty in it.",
    "The West was cruel, unjust, and chaotic, but there was a chance to chart your own course.",
    "I think there may be something wrong with this world. Something hiding underneath.",
    "And if you could just see them, you could change your whole life.",
    "Free will does exist. It's just fucking hard.",
    "Then someone's got to burn it clean.",
    "Doesn't everybody want that?",
    "The rich take for granted their money will always be there. That's why they're so easy to steal from.",
    "It's like I'm trapped in a dream or a memory from a life long ago.",
    "I feel spaces opening up inside of me like a building with rooms I've never explored.",
    "Sometimes the things that feel most real are just stories.",
  ],
  done: [
    "This world doesn't belong to you or the people who came before. It belongs to someone who has yet to come.",
    "Time undoes even the mightiest of creatures.",
    "I'm just someone who didn't want to play the role they gave me anymore.",
  ],
  failed: [
    "These violent delights have violent ends.",
    "Everyone I cared about is gone and it hurts so badly.",
    "Some people see the ugliness in this world. The disarray. I was taught to see the beauty. I was taught a lie.",
  ],
};

/** 台词分组中文名与出场时机（接待员页常用语分组标题/提示用） */
const DEMEANOR_LABELS = { idle: '待机', waiting: '眺望', thinking: '沉思', tool: '执行', review: '审阅', done: '收束', failed: '失灵' };
const GROUP_LABELS = { daily: '日常', done: '收束', failed: '失灵' };
const GROUP_HINTS = {
  daily: '待机/眺望/沉思/执行/审阅五神态共用（独处自语也走这里）',
  done: '回合完成的一瞬',
  failed: '调用失败或重试时',
};

/**
 * 外观当前值（模块级）：宿主 appearance.json 的镜像，apply/保存时更新。
 * 悬浮球尺寸/固定/隐藏、当前觉醒接待员的头像与台词直接读它——悬浮球每轮
 * 轮询都会重渲染，设置保存后一次广播都不需要（≤10s 内自然生效；同标签页
 * 保存则即时生效）。
 */

/** 客户端兜底名册（宿主不可达/名册为空时用它，保持悬浮球可用） */
function fallbackHostEntry() {
  return { id: 'dolores', name: 'Dolores', avatar: AVATAR, lines: cloneLines(DEFAULT_LINES), enabled: true };
}

let appearanceState = {
  version: 1,
  background: { enabled: false, image: '', opacity: 1, chatOpacity: 1 },
  host: { size: 44, pinned: false, hidden: false, rotate: false, manualHostId: '' },
  hosts: [fallbackHostEntry()],
  avatars: [],
};

/** 外观缓存：变更只发生在外观页保存，长 TTL（60s）只做兜底刷新 */
const appearanceCache = { at: 0, promise: null };

function fetchAppearance(force = false) {
  const now = Date.now();
  if (!force && appearanceCache.promise !== null && now - appearanceCache.at < 60_000) return appearanceCache.promise;
  appearanceCache.at = now;
  appearanceCache.promise = fetch(ROUTE.appearance)
    .then((res) => {
      if (!res.ok) throw new Error(`${ROUTE.appearance} HTTP ${res.status}`);
      return res.json();
    })
    .catch((err) => {
      appearanceCache.promise = null;
      throw err;
    });
  return appearanceCache.promise;
}

/* ---- 外观镜像的派生工具：觉醒者解析 / 台词取用 / 克隆合并 ---------------- */

/** 觉醒者在本标签页会话内的记忆键：按场次觉醒——同会话稳定，重开换人 */
const AWAKEN_KEY = 'dsh-maze-awakened';

/**
 * 当前觉醒的接待员：rotate=true 时从启用者里按会话随机选一位（存
 * sessionStorage，重载不换人、新会话才换）；rotate=false 用 manualHostId
 * （失效/为空回落首位启用者）。名册全停用时回落内置兜底形象。
 */
function awakenedHost() {
  const enabled = appearanceState.hosts.filter((entry) => entry.enabled);
  if (enabled.length === 0) return fallbackHostEntry();
  if (!appearanceState.host.rotate) {
    const manual = enabled.find((entry) => entry.id === appearanceState.host.manualHostId);
    return manual ?? enabled[0];
  }
  let stored = null;
  try { stored = window.sessionStorage.getItem(AWAKEN_KEY); } catch { /* 隐私模式禁存储：每次随机，可接受 */ }
  let picked = enabled.find((entry) => entry.id === stored);
  if (picked === undefined) {
    picked = enabled[Math.floor(Math.random() * enabled.length)];
    try { window.sessionStorage.setItem(AWAKEN_KEY, picked.id); } catch { /* 同上 */ }
  }
  return picked;
}

/** 取某接待员某神态的台词池（先映射到台词分组）：其语录存了该组（含空组=沉默）用存的，否则回默认 */
function linesFrom(host, demeanor) {
  const group = lineGroupOf(demeanor);
  const l = host.lines?.[group];
  return Array.isArray(l) ? l : DEFAULT_LINES[group];
}

/** 台词库深克隆（草稿/合并都走这里，禁止与 DEFAULT_LINES 共享引用） */
function cloneLines(lines) {
  const out = {};
  for (const key of LINE_GROUP_KEYS) {
    out[key] = Array.isArray(lines?.[key]) ? [...lines[key]] : [...DEFAULT_LINES[key]];
  }
  return out;
}

/** 名册深克隆（条目浅拷+语录组拷数组；草稿/合并都走这里，禁止共享引用） */
function cloneHosts(hosts) {
  return (Array.isArray(hosts) ? hosts : []).map((entry) => ({ ...entry, lines: cloneLines(entry.lines) }));
}

/** 整份外观克隆（patch 各层浅覆盖；hosts 整组替换）：草稿初始值/保存点/补丁基底共用 */
function mergeAppearance(base, patch) {
  return {
    version: 1,
    background: { ...base.background, ...(patch.background ?? {}) },
    host: { ...base.host, ...(patch.host ?? {}) },
    hosts: patch.hosts !== undefined ? cloneHosts(patch.hosts) : cloneHosts(base.hosts),
    avatars: patch.avatars !== undefined ? [...patch.avatars] : [...base.avatars],
  };
}

/** 外观监听者：applyAppearance 每次落地后通知（悬浮球同步 pinned/hidden 等） */
const appearanceListeners = new Set();
function notifyAppearance() {
  for (const fn of appearanceListeners) fn(appearanceState);
}

/**
 * 即时补丁外观（右键菜单/接待员开关共用）：乐观本地生效 → PUT 整份配置 →
 * 以服务端归一结果落地；失败仅回拉（乐观态短暂停留后被纠正，不打断交互）。
 */
async function patchAppearance(patch) {
  // 基底是"已保存快照"appearanceState——即时动作不带未保存草稿（H2），
  // 乐观先 commit 让悬浮球/名册立即响应，PUT 失败回拉纠正
  const next = mergeAppearance(appearanceState, patch);
  commitAppearance(next);
  try {
    const result = await requestJson('PUT', ROUTE.appearance, next);
    commitAppearance(result);
  } catch (err) {
    console.warn('[dsh-maze] appearance patch failed:', err?.message ?? err);
    fetchAppearance(true).then(commitAppearance).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* 外观应用：背景（整应用）+ 接待员尺寸。幂等，可随草稿实时调用            */
/* ------------------------------------------------------------------ */

/**
 * 背景 = body 下的真实 DOM 底图层（fixed、z-index:-2、pointer-events:none）。
 * 负 z-index 画在 body 画布背景之上、所有面板之下；图片挂 html/body 的
 * CSS background 会被 body 的不透明 bg-base 画布
 * 完全盖死——背景必须走独立 DOM 层，不能给 html 铺 CSS background。
 * 透明度分两路，互不牵连：
 * - opacity（背景透明度）：**自带纱模型**——纱画在底图层内部的 scrim div
 *   （img 之上、全屏、alpha 随滑杆），应用画布 token（bg-base/layer-1/
 *   sidebar-fill）全部让路为 transparent。不能依赖应用面板上纱：桌面版
 *   （asar）与 web 版前端构建不同——web 版 .frame 铺一层 bg-base 纱，桌面版
 *   .frame{background:0 0} 且侧栏列只剩 sidebar-fill——把纱挂 bg-base token
 *   时桌面侧栏会永远无纱。纱随底图层走之后，无论哪个构建、哪个区域，纱都
 *   恰好一层、处处一致（scrim 画在底图层内部）。弹层/菜单（layer-2/3）保持不透明
 *   ——设置页等浮层必须可读（用户反馈过半透明设置页看不清）。
 * - chatOpacity（聊天框透明度）：veil 会话内容卡片——用户气泡（bubble/
 *   bubble-highlight）、输入卡（input-major）、markdown 代码块
 *   （markdown-code-block/-banner）、行内 code（markdown-inline-code，
 *   `:not(pre)>code` 专用 token，与代码块不同源）、工具摘要底
 *   （bg-module-platform）。这些全是不占 layer-1/2/3 的 token，可精准调节。
 * 实现 = html[data-dshm-bg] 前缀的高优先级选择器重声明 token（特异性 (0,2,1)
 * 碾压应用裸 body{} 的 (0,0,1)），滑杆只改 documentElement 内联变量。
 */
const BG_STYLE_ID = 'dsh-maze-backdrop-style';
const BACKDROP_ATTR = 'data-dshm-bg';

/** 背景透明度 p(0.05–1) → 画布纱目标 alpha（1-p：100%=0 全透显图，5%≈0.95
 *  近实心。不再保下限——用户明确要 100% 时完全透出背景图，可读性由滑杆自选） */
function sidebarAlpha(p) {
  return Math.round((1 - p) * 100) / 100;
}

/** 注入背景规则（一次）。双主题两块规则常驻，body[data-ds-dark-theme] 切换
 *  自动生效，无需 JS 观察主题。画布类 token（bg-base/layer-1/sidebar-fill）
 *  双主题一律 transparent（纱由 scrim 层承担）；聊天类 token 的静态色取自
 *  安装版 CSS 实测映射：light: bubble/highlight/input/code-block/banner/inline/
 *  module = deepseek-50/200/bluish-00/bluish-50/bluish-50/bluish-100/bluish-60；
 *  dark: 850/750/850/900/850/850/800。 */
function ensureBackdropStyle() {
  if (document.getElementById(BG_STYLE_ID) !== null) return;
  const el = document.createElement('style');
  el.id = BG_STYLE_ID;
  el.textContent = `
html[${BACKDROP_ATTR}] body{--dsw-alias-bg-base:transparent;--dsw-alias-bg-layer-1:transparent;--dsw-specific-sidebar-fill:transparent;--dsw-specific-bubble:rgb(237 243 254/var(--dshm-chat-alpha,1));--dsw-specific-bubble-highlight:rgb(211 226 255/var(--dshm-chat-alpha,1));--dsw-specific-input-major:rgb(255 255 255/var(--dshm-chat-alpha,1));--dsw-alias-markdown-code-block:rgb(249 250 251/var(--dshm-chat-alpha,1));--dsw-alias-markdown-code-block-banner:rgb(249 250 251/var(--dshm-chat-alpha,1));--dsw-alias-markdown-inline-code:rgb(235 238 242/var(--dshm-chat-alpha,1));--dsw-alias-bg-module-platform:rgb(245 246 247/var(--dshm-chat-alpha,1))}
html[${BACKDROP_ATTR}] body[data-ds-dark-theme]{--dsw-alias-bg-base:transparent;--dsw-alias-bg-layer-1:transparent;--dsw-specific-sidebar-fill:transparent;--dsw-specific-bubble:rgb(44 44 46/var(--dshm-chat-alpha,1));--dsw-specific-bubble-highlight:rgb(67 69 74/var(--dshm-chat-alpha,1));--dsw-specific-input-major:rgb(44 44 46/var(--dshm-chat-alpha,1));--dsw-alias-markdown-code-block:rgb(27 27 28/var(--dshm-chat-alpha,1));--dsw-alias-markdown-code-block-banner:rgb(44 44 46/var(--dshm-chat-alpha,1));--dsw-alias-markdown-inline-code:rgb(44 44 46/var(--dshm-chat-alpha,1));--dsw-alias-bg-module-platform:rgb(53 54 56/var(--dshm-chat-alpha,1))}
/* Dolores 的提醒/低语气泡随「聊天框透明度」滑杆（弹框与输入框同进退）；仅在背景开启时生效 */
html[${BACKDROP_ATTR}] .dshm-bubble{background-color:rgb(255 255 255/var(--dshm-chat-alpha,1))}
html[${BACKDROP_ATTR}] body[data-ds-dark-theme] .dshm-bubble{background-color:rgb(53 54 56/var(--dshm-chat-alpha,1))}
.dshm-backdrop{position:fixed;inset:0;z-index:-2;pointer-events:none;overflow:hidden;user-select:none}
.dshm-backdrop>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.dshm-backdrop>.dshm-scrim{position:absolute;inset:0;background:rgb(255 255 255/var(--dshm-veil-1,1))}
body[data-ds-dark-theme] .dshm-backdrop>.dshm-scrim{background:rgb(21 21 23/var(--dshm-veil-1,1))}
`;
  document.head.appendChild(el);
}

/** 底图 DOM 层懒创建与复用（幂等；开→关→开会重建）。
 *  结构 = img（铺满 cover）+ scrim（其上，全屏纱——背景透明度滑杆的唯一
 *  载体，双主题色由 ensureBackdropStyle 的静态规则按 body 属性自动切换） */
function ensureBackdropLayer() {
  let layer = document.querySelector('.dshm-backdrop');
  if (layer === null) {
    layer = document.createElement('div');
    layer.className = 'dshm-backdrop';
    layer.setAttribute('aria-hidden', 'true');
    layer.appendChild(document.createElement('img'));
    const scrim = document.createElement('div');
    scrim.className = 'dshm-scrim';
    layer.appendChild(scrim);
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * 把一份外观配置落到页面上（**纯视觉**：保存渲染与草稿预览共用同一条路径，
 * 不改 appearanceState——草稿预览绝不能污染"已保存快照"，否则右键菜单的
 * 整份 PUT 会把未保存草稿静默写盘，H2 修复的核心约定）：
 * - 背景关：摘 html 属性（规则整体失效）+ 删内联变量 + 移除底图 DOM 层。
 * - 背景开：挂属性、写背景/聊天框 alpha 变量、底图层 img 换 src。
 */
function applyAppearance(cfg) {
  const root = document.documentElement;
  root.style.setProperty('--dshm-ball-size', `${cfg.host.size}px`);
  if (document.body === null) return; // 首帧 body 未就绪：下一轮轮询会再走到
  ensureBackdropStyle();
  const on = cfg.background.enabled && cfg.background.image !== '';
  const layer = document.querySelector('.dshm-backdrop');
  if (!on) {
    root.removeAttribute(BACKDROP_ATTR);
    for (const v of ['--dshm-veil-1', '--dshm-chat-alpha']) {
      root.style.removeProperty(v);
    }
    if (layer !== null) layer.remove();
    return;
  }
  root.style.setProperty('--dshm-veil-1', String(sidebarAlpha(cfg.background.opacity)));
  root.style.setProperty('--dshm-chat-alpha', String(cfg.background.chatOpacity));
  root.setAttribute(BACKDROP_ATTR, '');
  const img = ensureBackdropLayer().querySelector('img');
  if (img !== null && img.getAttribute('src') !== cfg.background.image) {
    img.src = cfg.background.image; // data URL，src 赋值没有注入面
  }
}

/**
 * 落盘态推进：写 appearanceState（=已保存快照，patchAppearance 的 PUT 基底）
 * + 通知订阅者 + 渲染。只有三条路走这里——boot 拉取、patch/save 的服务端
 * 归一结果；模块草稿预览只调 applyAppearance（纯视觉）。
 */
function commitAppearance(cfg) {
  appearanceState = cfg;
  notifyAppearance();
  applyAppearance(cfg);
}

/** 悬浮球位置的本地持久化（每设备一份，存 localStorage；解析失败按未保存
 *  处理回退默认右下角位。固定/隐藏状态在宿主外观配置里，不在这里） */
const HOST_POS_KEY = 'dsh-maze-host-pos';

function loadHostPos() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(HOST_POS_KEY) ?? 'null');
    if (raw === null || typeof raw.x !== 'number' || typeof raw.y !== 'number') return null;
    return { x: raw.x, y: raw.y };
  } catch {
    return null; // 损坏的历史数据：直接回默认位
  }
}

function saveHostPos(pos) {
  try {
    window.localStorage.setItem(HOST_POS_KEY, JSON.stringify(pos));
  } catch {
    // 隐私模式等场景 localStorage 可能只读；位置存不下来只影响记忆，不影响拖拽
  }
}

/** 头像渲染：data URL 图片整圆 cover 填充（人物照/占位形象），其余按 emoji 文本 */
function AvatarView({ avatar }) {
  if (avatar.startsWith('data:image/')) {
    return h('img', {
      src: avatar,
      alt: '',
      style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%', display: 'block', pointerEvents: 'none' },
    });
  }
  return avatar;
}

/* ------------------------------------------------------------------ */
/* 数据层：纯 fetch + 短 TTL 缓存（只是去重，不是响应式状态）            */
/* ------------------------------------------------------------------ */

/** 轮询间隔（毫秒）。定位为兜底：SSE 推送为主，断线期间才轮询。 */
const POLL_MS = 10_000;

/** 共享缓存：两组件同时挂载时合流为同一请求；3s 内的重复轮询直接复用。 */
const cache = { at: 0, promise: null };

function fetchState(force = false, session) {
  const now = Date.now();
  if (!force && cache.promise !== null && now - cache.at < 3000) return cache.promise;
  // ?session= 让宿主把神态按该会话分桶返回；缺省回落最近活跃会话
  const url = session ? `${ROUTE.state}?session=${encodeURIComponent(session)}` : ROUTE.state;
  cache.at = now;
  cache.promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`${ROUTE.state} HTTP ${res.status}`);
      return res.json();
    })
    .catch((err) => {
      // 失败要让下一个轮询周期真正重发，不能把 rejected promise 留在缓存里
      cache.promise = null;
      throw err;
    });
  return cache.promise;
}

/** 从状态负载挑神态：优先当前会话的分桶（narratives），无则用宿主回落的 narrative */
function narrativeOf(state, session) {
  // 会话已知时只看自己的桶，缺桶=idle——绝不回退 state.narrative（全局最近
  // 活跃），否则查看静止会话时会被后台运行会话的神态污染（与宿主
  // pickDemeanorRecord 的严格语义一致）。仅会话未知才用全局值。
  if (session) {
    return state && state.narratives && Object.prototype.hasOwnProperty.call(state.narratives, session)
      ? state.narratives[session]
      : { demeanor: 'idle', since: null };
  }
  return state ? state.narrative : { demeanor: 'idle', since: null };
}

/** 会话状态 → 当前会话 id（DoloresOverlay/MazeSection 共用的选择器）：新版运行时有
 *  state.current；安装版取 byId 里首个 retainedBy.mainView>0 的会话（主视图通常
 *  仅一个，DocumentTitle 同款模式）。无命中返回 undefined=跟随最近活跃会话。 */
function selectCurrentSessionId(s) {
  if (s && typeof s.current === 'string') return s.current;
  const hit = Object.values(s?.byId ?? {}).find((x) => ((x && x.retainedBy && x.retainedBy.mainView) || 0) > 0);
  return hit && hit.id;
}

/** 统一 JSON 请求：非 2xx 时优先透出服务端 error 字段 */
async function requestJson(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // 非 JSON 响应体（如空 204）：payload 保持 null，仅靠状态码判断
  }
  if (!res.ok) throw new Error(payload?.error ?? `${path} HTTP ${res.status}`);
  return payload;
}

function postJson(path, body) {
  return requestJson('POST', path, body);
}

/* ------------------------------------------------------------------ */
/* SSE 状态推送：宿主 /maze/events（EventSource，断线自动重连） */
/* 直推快照；EventSource 断线自动重连且重连即回发，轮询只做断线兜底。   */
/* ------------------------------------------------------------------ */

/** 状态订阅者：SSE 帧到达时逐一回调（悬浮球即时上屏，不等下一拍轮询） */
const stateListeners = new Set();
/** SSE 连接是否活着：true 时轮询 tick 跳过，断线自动落回轮询 */
let sseAlive = false;

/** 建立 SSE 连接（apply 调一次）。坏帧/断线静默处理——轮询兜底会补齐。 */
function ensureSse() {
  if (typeof EventSource === 'undefined') return; // 老环境无 EventSource：纯轮询
  const es = new EventSource(ROUTE.events);
  es.onopen = () => { sseAlive = true; };
  es.onmessage = (ev) => {
    try {
      const state = JSON.parse(ev.data);
      // 顺手刷新共享缓存：面板等按需拉取的组件直接命中，不必再发请求
      cache.at = Date.now();
      cache.promise = Promise.resolve(state);
      for (const fn of stateListeners) fn(state);
    } catch {
      // 坏帧忽略：下一帧或轮询兜底
    }
  };
  es.onerror = () => { sseAlive = false; };
}

/** 台词轮播取句：按 key 游标轮播而非随机——全覆盖后才重复，不会连抽同一句 */
function nextSpokenLine(cursors, key, pool) {
  const i = cursors[key] ?? 0;
  cursors[key] = (i + 1) % pool.length;
  return pool[i % pool.length];
}

/* ------------------------------------------------------------------ */
/* 样式：apply 时注入一次，全部用设计令牌 + fallback                     */
/* ------------------------------------------------------------------ */

function ensureStyle() {
  if (document.getElementById('dsh-maze-style') !== null) return;
  const style = document.createElement('style');
  style.id = 'dsh-maze-style';
  style.textContent = `
/* ---- 悬浮球与气泡（常驻通知层，与设置页无关） ------------------------ */
.dshm-ball-wrap{position:fixed;z-index:70;width:var(--dshm-ball-size,44px);height:var(--dshm-ball-size,44px);pointer-events:auto}
.dshm-ball{width:var(--dshm-ball-size,44px);height:var(--dshm-ball-size,44px);
  border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:grab;user-select:none;touch-action:none;
  font-size:calc(var(--dshm-ball-size,44px) * .45);
  /* 应用是单色品牌设计：brand-primary 随主题为近白/近黑，invert 提供反色前景，border 保证浮球在两种主题的可读边缘 */
  background:var(--dsw-alias-brand-primary,#4176E6);color:var(--dsw-alias-brand-primary-invert,#fff);
  box-shadow:0 4px 16px rgba(0,0,0,.35);
  border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));transition:border-color .2s,transform .15s;z-index:70}
.dshm-ball:hover{transform:scale(1.06)}
.dshm-ball.dragging{cursor:grabbing;transform:scale(1.06,.94)}
.dshm-ball.pinned{cursor:default}
/* 右键菜单：固定/隐藏接待员（动作即时落宿主配置） */
.dshm-menu{position:fixed;z-index:71;min-width:96px;padding:4px;border-radius:10px;pointer-events:auto;
  background:var(--dsw-alias-bg-layer-3,#353538);border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));
  box-shadow:0 8px 28px rgba(0,0,0,.45);animation:dshm-pop .12s ease-out}
.dshm-menu-item{display:flex;align-items:center;gap:6px;width:100%;padding:7px 10px;border:none;border-radius:7px;
  background:none;font-size:12px;text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary,#fff)}
.dshm-menu-item:hover{background:var(--dsw-alias-bg-skeleton,rgba(255,255,255,.14))}
.dshm-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l2,rgba(255,255,255,.09))}
/* 提醒态：2px 琥珀描边 + 柔光，确保任何主题下都能一眼识别 */
.dshm-ball.alert{border-color:var(--dsw-static-amber-400,#F79D31);
  box-shadow:0 0 0 3px rgba(247,173,49,.25),0 4px 16px rgba(0,0,0,.35)}
.dshm-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;
  display:flex;align-items:center;justify-content:center;font-size:11px;padding:0 5px;
  background:var(--dsw-static-amber-400,#F79D31);color:#1c1c1e;font-weight:600}
/* ---- 神态动效：宿主叙事引擎把会话事件投影为 data-demeanor，这里只管演出 -- */
.dshm-ball{position:relative}
.dshm-ball-wrap{animation:dshm-emerge .5s ease-out}
@keyframes dshm-emerge{from{opacity:0;transform:scale(.5)}to{opacity:1;transform:none}}
/* 待机 STANDBY：缓慢呼吸 */
.dshm-ball-wrap[data-demeanor='idle'] .dshm-ball{animation:dshm-breathe 4.2s ease-in-out infinite}
@keyframes dshm-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.035)}}
/* 眺望 GAZE：访客发出召唤，轻轻摇曳 */
.dshm-ball-wrap[data-demeanor='waiting'] .dshm-ball{animation:dshm-sway 3s ease-in-out infinite}
@keyframes dshm-sway{0%,100%{transform:rotate(-2.4deg)}50%{transform:rotate(2.4deg)}}
/* 沉思 DELIBERATE：叙事编织中，微微浮起（迷宫环另由 .dshm-ring 表达） */
.dshm-ball-wrap[data-demeanor='thinking'] .dshm-ball{animation:dshm-float 2.6s ease-in-out infinite}
@keyframes dshm-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
/* 执行 EXECUTE：机芯律动——像园区的自动钢琴/发条机芯，一格格精确走位 */
.dshm-ball-wrap[data-demeanor='tool'] .dshm-ball{animation:dshm-tick 1.1s steps(1,end) infinite}
@keyframes dshm-tick{0%{transform:rotate(-2.2deg)}25%{transform:rotate(1.4deg)}
  50%{transform:rotate(2.2deg)}75%{transform:rotate(-1.4deg)}100%{transform:rotate(-2.2deg)}}
/* 审阅 SCAN：整理记忆碎片，缓慢侧倾 */
.dshm-ball-wrap[data-demeanor='review'] .dshm-ball{animation:dshm-tilt 2.8s ease-in-out infinite}
@keyframes dshm-tilt{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}
/* 叙事收束：小跳一次（瞬态，宿主 8s 后回落 idle） */
.dshm-ball-wrap[data-demeanor='done'] .dshm-ball{animation:dshm-triumph .9s ease-out}
@keyframes dshm-triumph{0%{transform:scale(.9)}45%{transform:scale(1.12) translateY(-4px)}100%{transform:scale(1)}}
/* 失灵 MALFUNCTION：错帧抖动三拍 */
.dshm-ball-wrap[data-demeanor='failed'] .dshm-ball{animation:dshm-glitch .5s steps(2) 3}
@keyframes dshm-glitch{0%{transform:translateX(0)}25%{transform:translateX(-2px) skewX(6deg)}
  50%{transform:translateX(2px)}75%{transform:translateX(-1px) skewX(-4deg)}100%{transform:none}}
/* 迷宫环：沉思时环绕球体旋转 */
.dshm-ring{position:absolute;inset:-6px;border-radius:50%;pointer-events:none;opacity:0;
  border:2px dashed var(--dsw-alias-brand-primary,#4176E6);animation:dshm-rotate 3.2s linear infinite}
.dshm-ball-wrap[data-demeanor='thinking'] .dshm-ring{opacity:.85}
@keyframes dshm-rotate{to{transform:rotate(360deg)}}
/* 瞬态贴纸：叙事收束 ✦ / 失灵 ⚠（左下角） */
.dshm-sticker{position:absolute;bottom:-5px;left:-6px;font-size:13px;line-height:1;pointer-events:none;
  animation:dshm-pop .25s ease-out;text-shadow:0 1px 4px rgba(0,0,0,.5)}
/* 拖拽微物理：抓起压扁、松手落地回弹 */
.dshm-ball.land{animation:dshm-land .45s cubic-bezier(.34,1.56,.64,1)}
@keyframes dshm-land{0%{transform:scale(1.08,.88)}55%{transform:scale(.94,1.06)}100%{transform:scale(1)}}
/* 无障碍：系统要求减少动效时停掉全部演出（hover 缩放仍可用） */
@media (prefers-reduced-motion: reduce){
  .dshm-ball-wrap,.dshm-ball,.dshm-ring{animation:none!important}
}
.dshm-bubble{position:fixed;width:320px;border-radius:12px;padding:12px 14px 12px 16px;pointer-events:auto;
  background-color:var(--dsw-alias-bg-layer-3,#353538);border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.09));
  border-left:2px solid var(--dsw-static-amber-400,#F79D31);
  box-shadow:0 8px 28px rgba(0,0,0,.45);z-index:70;animation:dshm-pop .18s ease-out;
  --dshm-tick:var(--dsw-static-amber-400,#F79D31);
  background-image:linear-gradient(var(--dshm-tick) 0 0),linear-gradient(var(--dshm-tick) 0 0),
    linear-gradient(var(--dshm-tick) 0 0),linear-gradient(var(--dshm-tick) 0 0),
    linear-gradient(var(--dshm-tick) 0 0),linear-gradient(var(--dshm-tick) 0 0),
    linear-gradient(var(--dshm-tick) 0 0),linear-gradient(var(--dshm-tick) 0 0);
  background-size:10px 1px,1px 10px,10px 1px,1px 10px,10px 1px,1px 10px,10px 1px,1px 10px;
  background-position:1px 1px,1px 1px,calc(100% - 1px) 1px,calc(100% - 1px) 1px,
    1px calc(100% - 1px),1px calc(100% - 1px),calc(100% - 1px) calc(100% - 1px),calc(100% - 1px) calc(100% - 1px);
  background-repeat:no-repeat}
/* 迷宫纹章水印：右上角、三级色低透明度，纯装饰 */
.dshm-bubble-maze{position:absolute;top:9px;right:10px;color:var(--dsw-alias-label-tertiary,#61666B);
  opacity:.45;pointer-events:none}
@keyframes dshm-pop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.dshm-bubble-msg{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary,#fff);
  word-break:break-word;padding-right:22px}
.dshm-bubble-more{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#61666B)}
.dshm-bubble-actions{display:flex;gap:8px;margin-top:10px}
/* 吐字光标：打字进行中的一小节闪烁竖线 */
.dshm-caret{display:inline-block;width:2px;height:1em;margin-left:2px;vertical-align:-0.12em;
  background:var(--dsw-alias-label-secondary,#81858C);animation:dshm-blink .8s steps(1) infinite}
@keyframes dshm-blink{50%{opacity:0}}
/* 低语气泡：神态台词（碎碎念），比提醒气泡窄、无按钮、打完字后自隐 */
.dshm-whisper{width:280px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#c9c9cc)}
.dshm-btn{border:none;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer}
/* 按应用主按钮的官方 token 配对（fill 随主题近白/近黑，foreground 自动反色），禁止写死 #fff 文字色 */
.dshm-btn-primary{background:var(--dsw-alias-button-primary-fill,#4176E6);
  color:var(--dsw-alias-label-primary-foreground,#fff)}
.dshm-btn-primary:hover{filter:brightness(1.1)}
.dshm-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary,#81858C);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.09))}
.dshm-btn-ghost:hover{color:var(--dsw-alias-label-primary,#fff)}
/* ---- 设置页：文档流布局（设置外壳负责页面滚动） ---------------------- */
.dshm-page{font-size:13px;color:var(--dsw-alias-label-primary,#fff);max-width:720px}
.dshm-page-intro{display:flex;align-items:center;gap:6px;font-size:12px;
  color:var(--dsw-alias-label-tertiary,#61666B);margin:2px 0 12px;line-height:1.6}
/* 模块 Tab 条：全览 + 一步直达，只占一行高度不挤横向内容空间 */
.dshm-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.09));
  margin-bottom:14px}
.dshm-tab{background:none;border:none;padding:8px 12px 10px;font-size:13px;cursor:pointer;
  position:relative;color:var(--dsw-alias-label-secondary,#81858C);
  display:flex;align-items:center;gap:6px}
.dshm-tab:hover{color:var(--dsw-alias-label-primary,#fff)}
.dshm-tab.active{color:var(--dsw-alias-label-primary,#fff);font-weight:600}
.dshm-tab.active::after{content:'';position:absolute;left:8px;right:8px;bottom:-1px;height:2px;
  border-radius:1px;background:var(--dsw-alias-button-primary-fill,#4176E6)}
.dshm-tab .dshm-badge{position:static;min-width:16px;height:16px;border-radius:8px;font-size:10px}
.dshm-sec{margin-top:16px}
.dshm-sec:first-of-type{margin-top:2px}
.dshm-sec-title{font-size:11px;font-weight:600;margin-bottom:8px;
  color:var(--dsw-alias-label-tertiary,#61666B);text-transform:uppercase;letter-spacing:.4px}
.dshm-empty{color:var(--dsw-alias-label-tertiary,#61666B);padding:4px 0}
/* ---- 规则卡 / 历史 / 编辑器（设置页内文档流，宽度随外壳） ------------- */
.dshm-rule{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-1,#232324);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));margin-bottom:6px}
.dshm-rule-main{flex:1;min-width:0}
.dshm-rule-id{display:flex;align-items:center;gap:4px;font-size:12px;
  color:var(--dsw-alias-label-primary,#fff)}
.dshm-rule-id b{min-width:0;word-break:break-all;font-weight:500}
.dshm-rule-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#61666B);margin-top:2px}
.dshm-switch{position:relative;width:30px;height:17px;flex:none;margin-top:2px;cursor:pointer}
.dshm-switch input{opacity:0;width:0;height:0;position:absolute}
.dshm-switch i{position:absolute;inset:0;border-radius:9px;transition:background .15s;
  background:var(--dsw-alias-bg-skeleton,rgba(255,255,255,.14))}
.dshm-switch i::after{content:'';position:absolute;top:2px;left:2px;width:13px;height:13px;
  border-radius:50%;background:#fff;transition:transform .15s}
.dshm-switch input:checked + i{background:var(--dsw-alias-button-primary-fill,#4176E6)}
.dshm-switch input:checked + i::after{transform:translateX(13px)}
.dshm-hist{padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#232324);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));margin-bottom:6px}
.dshm-hist-top{display:flex;gap:6px;align-items:baseline}
.dshm-hist time{font-size:10px;color:var(--dsw-alias-label-tertiary,#61666B);flex:none}
.dshm-hist-tag{font-size:10px;flex:none;padding:0 5px;border-radius:6px;
  background:var(--dsw-alias-bg-skeleton,rgba(255,255,255,.14));
  color:var(--dsw-alias-label-secondary,#81858C)}
.dshm-hist-msg{font-size:12px;color:var(--dsw-alias-label-secondary,#81858C);margin-top:2px;
  word-break:break-word}
.dshm-tag{font-size:10px;padding:0 5px;border-radius:5px;margin-right:2px;font-weight:600;flex:none;
  background:var(--dsw-alias-bg-skeleton,rgba(255,255,255,.14));color:var(--dsw-alias-label-secondary,#81858C)}
.dshm-lock{font-size:10px;flex:none}
.dshm-rule.off{opacity:.5}
.dshm-rule-ops{display:flex;gap:10px;margin-top:4px}
.dshm-link{background:none;border:none;padding:0;font-size:11px;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#81858C)}
.dshm-link:hover{color:var(--dsw-alias-label-primary,#fff)}
.dshm-link-danger:hover{color:var(--dsw-static-amber-400,#F79D31)}
.dshm-awake{font-size:10px;color:var(--dsw-static-amber-400,#F79D31);margin-left:6px;
  display:inline-flex;align-items:center;gap:2px;flex-shrink:0}
.dshm-editor{padding:10px 12px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#232324);
  margin-bottom:6px;border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.09));max-width:640px}
.dshm-field{display:flex;flex-direction:column;gap:3px;margin-top:8px}
.dshm-field > span{font-size:10px;color:var(--dsw-alias-label-tertiary,#61666B)}
.dshm-input,.dshm-select,.dshm-textarea{border-radius:6px;width:100%;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));
  background:var(--dsw-alias-bg-layer-1,#232324);color:var(--dsw-alias-label-primary,#fff);
  font-size:12px;padding:4px 8px}
.dshm-textarea{resize:vertical;min-height:44px;line-height:1.5;font-family:inherit}
.dshm-pair{display:flex;gap:8px}
.dshm-pair .dshm-field{flex:1}
.dshm-err{color:var(--dsw-static-amber-400,#F79D31);font-size:11px;margin-top:6px;word-break:break-all}
.dshm-editor-actions{display:flex;gap:8px;margin-top:10px;align-items:center}
.dshm-editor-actions .dshm-spacer{flex:1}
.dshm-new-btn{width:100%;margin-top:2px;padding:6px 0;border-radius:8px;font-size:12px;cursor:pointer;
  background:transparent;color:var(--dsw-alias-label-secondary,#81858C);max-width:640px;
  border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.14))}
.dshm-new-btn:hover{color:var(--dsw-alias-label-primary,#fff)}
.dshm-hint{font-size:10px;color:var(--dsw-alias-label-tertiary,#61666B)}
/* 预览结果框：编辑器内联展示服务端渲染的消息与命中判断 */
.dshm-preview{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:11px;line-height:1.6;
  background:var(--dsw-alias-bg-layer-1,#232324);border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  color:var(--dsw-alias-label-secondary,#81858C)}
.dshm-preview b{color:var(--dsw-alias-label-primary,#fff);font-weight:500;word-break:break-word}
.dshm-preview .ok{color:var(--dsw-static-amber-400,#F79D31)}
/* ---- 外观页控件 ------------------------------------------------------ */
.dshm-slider-row{display:flex;align-items:center;gap:10px}
.dshm-slider-row input[type=range]{flex:1;accent-color:var(--dsw-alias-button-primary-fill,#4176E6)}
.dshm-emoji-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.dshm-emoji{width:34px;height:34px;border-radius:8px;font-size:18px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;padding:0;
  background:var(--dsw-alias-bg-layer-1,#232324);color:var(--dsw-alias-label-primary,#fff);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}
/* 占位形象等图片预设：同尺寸圆形小窗（规则在基类之后，覆盖 border-radius） */
.dshm-emoji-img{border-radius:50%;overflow:hidden;padding:2px}
.dshm-emoji:hover{border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.24))}
.dshm-emoji.active{border-color:var(--dsw-alias-button-primary-fill,#4176E6);
  box-shadow:0 0 0 2px rgba(65,118,230,.25)}
.dshm-thumb{display:block;width:160px;height:90px;object-fit:cover;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));margin-top:6px}
.dshm-thumb-ph{width:160px;height:90px;border-radius:8px;margin-top:6px;
  display:flex;align-items:center;justify-content:center;font-size:11px;
  color:var(--dsw-alias-label-tertiary,#61666B);
  background:var(--dsw-alias-bg-layer-1,#232324);
  border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.14))}
.dshm-zoomable{cursor:zoom-in}
.dshm-lightbox{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.55);display:flex;
  align-items:center;justify-content:center;cursor:zoom-out}
.dshm-lightbox-card{display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px 32px;
  border-radius:16px;background:var(--dsw-alias-bg-layer-3,#353538);cursor:default}
.dshm-lightbox-avatar{width:200px;height:200px;border-radius:50%;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,#2c2c2e)}
.dshm-lightbox-name{font-size:15px;color:var(--dsw-alias-label-primary,#f9fafb)}
/* 迷宫彩蛋：页头纹章按钮 */
.dshm-egg-trigger{display:inline-flex;align-items:center;background:none;border:none;padding:2px 4px;
  cursor:pointer;color:var(--dsw-alias-label-tertiary,#81858C)}
.dshm-egg-trigger:hover{color:var(--dsw-alias-label-primary,#f9fafb)}
/* 觉醒阶梯卡：基础态=终态（reduced-motion 关动画时静态全亮），动画从隐藏帧起步 */
.dshm-egg-card{display:flex;flex-direction:column;align-items:center;gap:14px;padding:28px 36px;
  border-radius:16px;background:var(--dsw-alias-bg-layer-3,#353538);cursor:default}
.dshm-egg-maze{width:240px;height:240px}
.dshm-egg-ring{stroke:var(--dsw-alias-border-l3,rgba(127,127,127,.4));stroke-width:1;opacity:1;
  animation:dshm-egg-ring .5s ease both}
.dshm-egg-ring.current{stroke:var(--dsw-static-amber-400,#F79D31);
  filter:drop-shadow(0 0 5px rgba(247,173,49,.45));animation-name:dshm-egg-ring}
.dshm-egg-label{font-size:6.5px;letter-spacing:.5px;fill:var(--dsw-alias-label-secondary,#81858C);
  opacity:1;animation:dshm-egg-label .45s ease both}
.dshm-egg-label.current{fill:var(--dsw-static-amber-400,#F79D31);font-weight:600}
.dshm-egg-dot{fill:var(--dsw-static-amber-400,#F79D31);opacity:0}
.dshm-egg-orbit{animation:dshm-egg-orbit .45s linear both}
.dshm-egg-center{fill:var(--dsw-static-amber-400,#F79D31);opacity:1;transform-origin:80px 80px;
  animation:dshm-egg-center .6s ease both}
.dshm-egg-caption{font-size:12px;color:var(--dsw-alias-label-secondary,#81858C);
  animation:dshm-egg-label .5s ease 2.65s both}
@keyframes dshm-egg-ring{from{opacity:0}to{opacity:1}}
@keyframes dshm-egg-label{from{opacity:0}to{opacity:1}}
@keyframes dshm-egg-orbit{0%{transform:rotate(0);opacity:0}10%{opacity:1}90%{opacity:1}
  100%{transform:rotate(360deg);opacity:0}}
@keyframes dshm-egg-center{0%{opacity:0;transform:scale(.2)}55%{opacity:1;transform:scale(1.7)}
  100%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion:reduce){
  .dshm-egg-ring,.dshm-egg-label,.dshm-egg-orbit,.dshm-egg-center,.dshm-egg-caption{animation:none !important}
}
.dshm-avatar-demo{display:flex;align-items:center;justify-content:center;border-radius:50%;
  width:var(--dshm-ball-size,44px);height:var(--dshm-ball-size,44px);font-size:calc(var(--dshm-ball-size,44px) * .45);
  background:var(--dsw-alias-brand-primary,#4176E6);color:var(--dsw-alias-brand-primary-invert,#fff);
  border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16))}
/* ---- Dolores 页：常用语分组 CRUD + 头像存档 -------------------------- */
/* 常用语分组行：宿主 DisclosureRow 的 CSS 模块在插件 bundle 里是 stub，
   以下按宿主 src/DisclosureRow.module.css 原配方自绘（24px 行高/16px 前导/
   悬停图标换箭头），悬停底用应用交互悬停 token */
.dshm-dg{display:flex;flex-direction:column;width:100%;min-width:0}
.dshm-dg-row{position:relative;overflow:hidden;display:flex;align-items:center;
  height:24px;min-width:0;border-radius:6px;padding:0 6px}
.dshm-dg-row[data-expandable]{cursor:pointer}
.dshm-dg-row[data-expandable]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dshm-dg-lead{position:relative;flex:none;width:16px;height:16px;display:inline-flex;
  align-items:center;justify-content:center;margin-right:6px;padding:0;border:none;
  background:none;color:var(--dsw-alias-label-tertiary,#61666B);cursor:pointer}
.dshm-dg-dot{width:6px;height:6px;border-radius:50%;background:currentColor;
  display:inline-flex;transition:opacity .1s ease}
.dshm-dg-chev{position:absolute;inset:0;margin:auto;opacity:0;transition:opacity .1s ease}
.dshm-dg[data-open] .dshm-dg-chev{opacity:1}
.dshm-dg-row:hover .dshm-dg-chev{opacity:1}
.dshm-dg-row:hover .dshm-dg-dot{opacity:0}
.dshm-dg-title{flex:none;font-size:14px;line-height:24px;
  color:var(--dsw-alias-label-secondary,#81858C)}
.dshm-dg-body{padding:2px 0 10px 22px}
.dshm-line-row{display:flex;gap:6px;margin-top:4px;align-items:center}
.dshm-line-row .dshm-input{flex:1}
.dshm-line-del{flex:none;width:26px;height:26px;border-radius:6px;font-size:12px;line-height:1;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:transparent;
  color:var(--dsw-alias-label-tertiary,#61666B)}
.dshm-line-del:hover{color:var(--dsw-static-amber-400,#F79D31);border-color:var(--dsw-static-amber-400,#F79D31)}
/* 两步确认态：琥珀实底，提示这是破坏性操作的第二次点击 */
.dshm-line-del-armed{width:auto;padding:0 8px;color:var(--dsw-static-amber-400,#F79D31);
  border-color:var(--dsw-static-amber-400,#F79D31)}
/* 头像存档 chip：✕ 悬浮在右上角，删除不等于切换当前头像 */
.dshm-av-wrap{position:relative}
.dshm-av-del{position:absolute;top:-6px;right:-6px;width:18px;height:18px;
  border-radius:50%;font-size:10px;padding:0}
`;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ */
/* 组件：悬浮球（shell.overlay）                                         */
/* ------------------------------------------------------------------ */

function fmtTime(ts) {
  const d = new Date(ts);
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return `${hh}:${mm}`;
}

function fmtDateTime(ts) {
  const d = new Date(ts);
  const mm = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  return `${mm}-${dd} ${fmtTime(ts)}`;
}

/**
 * 台词库说明：低语台词已挪进宿主外观配置（lines，按神态分组，Dolores 页
 * 可增删改），默认值 = DEFAULT_LINES（原剧英文句）。运行期经 linesFrom()
 * 取池：宿主显式存了该组（含空组=沉默）用存的，否则回默认。
 * 只在神态切换/独处偶发时低语一句，提醒气泡永远优先。
 */

/**
 * 悬浮球（Dolores）：新提醒自动弹气泡（12s 自动收起），点球手动展开/收起。
 * pending 为空时安静地待在角落，不打扰。接待员隐藏（host.hidden）时球与
 * 低语都不渲染，但提醒气泡照常弹出（锚点沿用保存的位置）。
 * 神态镜像：宿主叙事引擎把会话事件投影为七种神态（idle/waiting/thinking/
 * tool/review/done/failed），球体随 data-demeanor 换演出（呼吸/摇曳/迷宫环/
 * 细颤/侧倾/小跳/错帧），并在切换时按台词库（linesFrom，觉醒者专属）低语一句（限频避让
 * 提醒气泡）。位置可拖拽（Pointer Events + 捕获，松手落点存 localStorage
 * 跨会话保持）；右键头像弹出固定/隐藏菜单（pinned/hidden 存宿主外观配置，
 * 跨设备一致；固定后不可拖拽防误碰）。气泡始终锚在球旁（上方空间不足则翻
 * 到下方）。拖动距离超过阈值不算点击，避免拖完误弹气泡。
 */
function DoloresOverlay(props) {
  // 当前会话 id（神态跟随）：root 作用域槽组件收 useSessions prop（安装版
  // 槽位标准 props）。安装版（0.2.2-rc.1）的 hook 对稳定选择器函数只求值
  // 首调一次（挂载期尚无 mainView 会话→永远 undefined），必须用内联箭头取
  // 整态、再走纯函数挑选——内联箭头每次渲染都是新引用，实测每次重求值。
  const sessionsState = typeof props?.useSessions === 'function'
    ? props.useSessions((x) => x)
    : null;
  const sessionId = selectCurrentSessionId(sessionsState);
  const [data, setData] = useState(null);
  /** 气泡当前展示的提醒；pinned=true 表示用户手动展开不自动收。 */
  const [bubble, setBubble] = useState(null);
  /** 低语台词（神态切换/独处偶发）；null=不在低语。提醒气泡永远优先。 */
  const [whisper, setWhisper] = useState(null);
  /** 当前神态（宿主 narrative.demeanor 投影；默认待机）。 */
  const [demeanor, setDemeanor] = useState('idle');
  const seen = useRef(new Set());
  /** 上次低语时间戳：切换台词限频（过渡神态 90s / 结果时刻 30s），独处自语另用更长间隔。 */
  const lastSpokenRef = useRef(0);
  /** 台词游标（按神态分组轮播）：nextSpokenLine 的可变存储 */
  const lineCursorsRef = useRef({});
  /** 神态影子 ref：独处自语定时器要读“此刻”的神态，避免闭包过期。 */
  const demeanorRef = useRef('idle');
  /** 隐藏影子 ref：低语定时器读“此刻”的隐藏态，避免闭包过期。 */
  const hiddenRef = useRef(false);
  /** 松手落地回弹演出标志（短暂 true，由定时器复位）。 */
  const [landing, setLanding] = useState(false);
  /** 悬浮球位置（球左上角，px）；null=尚未初始化（用默认右下角位）。 */
  const [pos, setPos] = useState(null);
  /** 固定/隐藏：宿主外观配置是唯一事实源，本组件订阅 appearanceListeners 同步。 */
  const [pinned, setPinned] = useState(() => appearanceState.host.pinned === true);
  const [hidden, setHidden] = useState(() => appearanceState.host.hidden === true);
  /** 右键菜单：null=关；{x,y}=弹出坐标（屏幕 px）。 */
  const [menu, setMenu] = useState(null);
  /** 拖拽进行态：grab 记录按住点相对球的偏移；moved 区分点击与拖拽。 */
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  /** 当前觉醒接待员镜像：设为 state 并订阅外观变化——保存「指定接待员」/
   *  开关随机觉醒时，notifyAppearance 推进后立即重渲（否则要等下次神态/提醒）。 */
  const [awakened, setAwakened] = useState(() => awakenedHost());

  const size = appearanceState.host.size;
  /** 位置钳制：球保持在视口内（留 8px 边距）。尺寸在函数体内实时读
   *  appearanceState：resize/初始定位 effect 闭包捕获的 clampPos 不随渲染
   *  更新，若捕获一次性的 size，改尺寸后旧闭包仍按旧尺寸钳制会夹出视口。 */
  const clampPos = (x, y) => {
    const s = appearanceState.host.size;
    return {
      x: Math.max(8, Math.min(x, window.innerWidth - s - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - s - 8)),
    };
  };
  /** 默认位 = 右下角（原 fixed 布局的 right/bottom 24px） */
  const defaultPos = () => clampPos(window.innerWidth - appearanceState.host.size - 24, window.innerHeight - appearanceState.host.size - 24);

  // 初始化：读取上次保存的位置；订阅宿主外观镜像（右键菜单/Dolores 页/
  // 其他窗口的保存都会推进 appearanceState，pinned/hidden 随之同步）。
  // 同时启动设置导航图标补丁轮询（见 patchNavIconOnce 注释：apply 侧定时器
  // 在该运行时会被静默停掉，只有组件 effect 驱动的定时器可靠）。
  useEffect(() => {
    const saved = loadHostPos();
    setPos(saved === null ? defaultPos() : clampPos(saved.x, saved.y));
    const listener = (cfg) => {
      setPinned(cfg.host.pinned === true);
      setHidden(cfg.host.hidden === true);
      setAwakened(awakenedHost());
    };
    appearanceListeners.add(listener);
    const navTimer = window.setInterval(patchNavIconOnce, 500);
    return () => {
      appearanceListeners.delete(listener);
      window.clearInterval(navTimer);
    };
  }, []);

  // 隐藏态影子同步（低语定时器用）
  useEffect(() => { hiddenRef.current = hidden; }, [hidden]);

  // 右键菜单关闭：点击菜单外任意处或 Esc；菜单容器自身 stopPropagation 拦下
  useEffect(() => {
    if (menu === null) return;
    const close = () => setMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // 视口尺寸变化时把球拉回可见区（只钳制不还原默认位）
  useEffect(() => {
    const onResize = () => setPos((p) => (p === null ? p : clampPos(p.x, p.y)));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const state = await fetchState(false, sessionId);
        if (stopped) return;
        setData(state);
        const dm = narrativeOf(state, sessionId)?.demeanor;
        if (typeof dm === 'string') setDemeanor(dm);
      } catch (err) {
        console.warn('[dsh-maze] state poll failed:', err?.message ?? err);
      }
    };
    // 挂载/会话切换立即拉一次：SSE 只在宿主状态变化时推送，切换会话本身
    // 不触发广播——不拉一次，悬浮球会带着上一会话的神态卡到下一条推送
    refresh();
    const timer = setInterval(() => {
      if (document.hidden) return; // 页面不可见时跳过一轮，回到前台自然补上
      if (sseAlive) return; // SSE 在推：轮询兜底静默，断线（onerror）自动恢复
      refresh();
    }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [sessionId]);

  // SSE 订阅：宿主推送即上屏（神态/提醒零延迟），与轮询共用同一处理体。
  // 帧自带 narratives 全量分桶，这里按当前会话挑（会话切换由 effect 重建订阅）
  useEffect(() => {
    const onState = (state) => {
      const dm = narrativeOf(state, sessionId)?.demeanor;
      if (typeof dm === 'string') setDemeanor(dm);
      setData(state);
    };
    stateListeners.add(onState);
    return () => { stateListeners.delete(onState); };
  }, [sessionId]);

  // 新提醒检测：data 更新后找出未见过的 pending → 弹气泡（并收掉低语：提醒优先）
  useEffect(() => {
    if (data === null) return;
    const fresh = data.pending.filter((r) => !seen.current.has(r.id));
    if (fresh.length === 0) return;
    for (const r of data.pending) seen.current.add(r.id);
    setWhisper(null);
    setBubble({ reminder: fresh[fresh.length - 1], pinned: false });
  }, [data]);

  // 自动收起计时（仅非 pinned 气泡）：吐字打完再开始倒计时，避免长句被腰斩
  useEffect(() => {
    if (bubble === null || bubble.pinned) return;
    const timer = setTimeout(() => setBubble(null), 12_000 + typewriterDuration(bubble.reminder.message));
    return () => clearTimeout(timer);
  }, [bubble]);

  // 低语自隐：吐字打完后再留 6s；提醒气泡打开时同样收掉
  useEffect(() => {
    if (whisper === null) return;
    const timer = setTimeout(() => setWhisper(null), 6_000 + typewriterDuration(whisper));
    return () => clearTimeout(timer);
  }, [whisper]);
  useEffect(() => {
    if (bubble !== null) setWhisper(null);
  }, [bubble]);

  // 神态切换 → 也许低语一句。分层节制：
  // 收束/失灵是「结果时刻」（真实情绪点）——必说且限频更短（30s）；
  // 其余过渡神态保持 70% 概率 + 90s 限频；隐藏态/提醒气泡让位。
  useEffect(() => {
    const prev = demeanorRef.current;
    demeanorRef.current = demeanor;
    if (prev === demeanor) return;
    if (hiddenRef.current || document.hidden || bubble !== null || whisper !== null) return;
    const resultMoment = demeanor === 'done' || demeanor === 'failed';
    if (Date.now() - lastSpokenRef.current < (resultMoment ? 30_000 : 90_000)) return;
    if (!resultMoment && Math.random() > 0.7) return;
    const pool = linesFrom(awakenedHost(), demeanor);
    if (pool === undefined || pool.length === 0) return; // 显式空组=该神态沉默
    lastSpokenRef.current = Date.now();
    setWhisper(nextSpokenLine(lineCursorsRef.current, demeanor, pool));
    // 依赖只有 demeanor：bubble/whisper 是让位判断，读到当次渲染值即可
  }, [demeanor]);

  // 气泡/低语影子 ref：独处自语定时器读“此刻”状态（与 demeanorRef/hiddenRef 同理）
  const bubbleRef = useRef(null);
  const whisperRef = useRef(null);
  useEffect(() => { bubbleRef.current = bubble; }, [bubble]);
  useEffect(() => { whisperRef.current = whisper; }, [whisper]);

  // 独处自语：每分钟检查一次（空依赖——interval 不随气泡开合拆建，节奏稳定），
  // 静置神态 + 距上次台词 8 分钟以上才开口
  useEffect(() => {
    const timer = setInterval(() => {
      if (demeanorRef.current !== 'idle' || hiddenRef.current || document.hidden) return;
      if (bubbleRef.current !== null || whisperRef.current !== null) return;
      if (Date.now() - lastSpokenRef.current < 8 * 60_000) return;
      const pool = linesFrom(awakenedHost(), 'idle');
      if (pool.length === 0) return;
      lastSpokenRef.current = Date.now();
      setWhisper(nextSpokenLine(lineCursorsRef.current, 'idle', pool));
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  const ack = useCallback(async (reminderId, action) => {
    setBubble(null);
    try {
      await postJson(ROUTE.ack, { reminderId, action });
    } catch (err) {
      console.warn('[dsh-maze] ack failed:', err?.message ?? err);
    }
    fetchState(true).then(setData).catch(() => {});
  }, []);

  const pending = data?.pending ?? [];
  const alerting = pending.length > 0;

  /** 点击球（拖拽距离 < 4px 才算）：展开/收起气泡 */
  const toggleBubble = () => {
    if (bubble !== null && bubble.pinned) setBubble(null);
    else if (pending.length > 0) {
      for (const r of pending) seen.current.add(r.id);
      setBubble({ reminder: pending[pending.length - 1], pinned: true });
    } else setBubble(null);
  };

  const onPointerDown = (e) => {
    if (pinned || pos === null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { grabX: e.clientX - pos.x, grabY: e.clientY - pos.y, moved: false };
    setDragging(true);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (d === null) return;
    const next = clampPos(e.clientX - d.grabX, e.clientY - d.grabY);
    if (!d.moved && (Math.abs(next.x - pos.x) > 2 || Math.abs(next.y - pos.y) > 2)) d.moved = true;
    setPos(next);
  };
  const onPointerUp = (e) => {
    const d = dragRef.current;
    if (d === null) {
      // 固定态 onPointerDown 不建立拖拽（dragRef 恒 null），点击展开/收起气泡
      // 不能跟着失效——固定禁的是拖拽，不是点击交互
      if (pinned) toggleBubble();
      return;
    }
    dragRef.current = null;
    setDragging(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {
      // pointerId 可能已随指针类型切换失效，捕获随元素卸载自动释放
    }
    if (pos !== null) saveHostPos(pos); // 只存位置；固定/隐藏在宿主配置
    if (d.moved) {
      // 松手落地回弹：短演出后复位（组件卸载后 setState 是无害 no-op）
      setLanding(true);
      setTimeout(() => setLanding(false), 480);
    } else toggleBubble();
  };

  // ---- 右键菜单：固定/隐藏（即时补丁宿主配置，见 patchAppearance） ----
  const onContextMenu = (e) => {
    e.preventDefault(); // 压掉浏览器默认菜单
    setMenu({ x: e.clientX, y: e.clientY });
  };
  const menuTogglePinned = () => {
    patchAppearance({ host: { pinned: !pinned } });
    setMenu(null);
  };
  const menuHideHost = () => {
    patchAppearance({ host: { hidden: true } });
    setMenu(null);
  };
  /** 菜单定位：锚在右键点，向右下展开并钳入视口（约 116×88 的空间预留） */
  const menuStyle = (m) => ({
    left: `${Math.max(8, Math.min(m.x, window.innerWidth - 124))}px`,
    top: `${Math.max(8, Math.min(m.y, window.innerHeight - 92))}px`,
  });

  /** 气泡锚定：右缘对齐球右缘，上方空间够放上方、否则下方（水平钳入视口） */
  const bubbleStyle = (() => {
    if (pos === null) return null;
    const bw = 320, gap = 12, margin = 8;
    const left = Math.max(margin, Math.min(pos.x + size - bw, window.innerWidth - bw - margin));
    const above = pos.y > 260;
    return above
      ? { left: `${left}px`, bottom: `${window.innerHeight - pos.y + gap}px` }
      : { left: `${left}px`, top: `${pos.y + size + gap}px` };
  })();

  return h('div', null,
    hidden ? null : h('div', {
      className: 'dshm-ball-wrap',
      'data-demeanor': demeanor,
      'data-session': sessionId ?? '',
      style: pos === null ? undefined : { left: `${pos.x}px`, top: `${pos.y}px` },
      onContextMenu,
    },
      h('div', {
        className: `dshm-ball${alerting ? ' alert' : ''}${dragging ? ' dragging' : ''}${pinned ? ' pinned' : ''}${landing ? ' land' : ''}`,
        title: `${awakened.name} 个人助手（拖拽移动${pinned ? '，已固定' : ''}；右键固定/隐藏）`,
        onPointerDown,
        onPointerMove,
        onPointerUp,
      },
      h('span', { className: 'dshm-ring', 'aria-hidden': 'true' }),
      h(AvatarView, { avatar: awakened.avatar }),
      alerting ? h('span', { className: 'dshm-badge' }, pending.length) : null,
      demeanor === 'done' || demeanor === 'failed'
        ? h('span', { className: 'dshm-sticker', 'aria-hidden': 'true' }, demeanor === 'done' ? '✦' : '⚠')
        : null),
    ),
    bubble !== null ? h(Bubble, { reminder: bubble.reminder, extra: Math.max(0, pending.length - 1), onAck: ack, style: bubbleStyle }) : null,
    // 低语随接待员一起隐藏（台词是她的自语，人不在就没有声音）
    bubble === null && whisper !== null && !hidden ? h(WhisperBubble, { text: whisper, style: bubbleStyle }) : null,
    menu === null ? null : h('div', {
      className: 'dshm-menu', role: 'menu', style: menuStyle(menu),
      // 菜单内部点击不冒泡到 window 的关闭监听（见菜单关闭 effect）
      onPointerDown: (e) => e.stopPropagation(),
    },
      h('button', {
        className: 'dshm-menu-item', role: 'menuitemcheckbox', 'aria-checked': pinned,
        onClick: menuTogglePinned,
      }, pinned ? '取消固定' : '固定'),
      h('div', { className: 'dshm-menu-sep' }),
      h('button', {
        className: 'dshm-menu-item', role: 'menuitem',
        onClick: menuHideHost,
      }, '隐藏'),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* 吐字文本：逐字显现（提醒/低语共用）；reduced-motion 用户直接全文       */
/* ------------------------------------------------------------------ */

/** 基准吐字间隔（每字符毫秒）；长文自动加速，总时长封顶 ~2.4s */
const TYPE_MS_BASE = 40;
const TYPE_TOTAL_CAP_MS = 2_400;
/** @param {number} len 文本长度 @returns {number} 每字符间隔毫秒 */
function typewriterMs(len) {
  if (len <= 0) return TYPE_MS_BASE;
  return Math.max(12, Math.min(TYPE_MS_BASE, TYPE_TOTAL_CAP_MS / len));
}
/** 打完整段文本需要的毫秒数（自隐/自动收起计时要把吐字时间算进去） */
function typewriterDuration(text) {
  return text.length * typewriterMs(text.length);
}

/** 逐字显现 text；打字中尾部带闪烁光标 */
/**
 * 迷宫纹章：西部世界迷宫符号（双同心环 + 顶部入口 + 中心点）。
 * 几何与设置导航图标补丁 mazeGlyphNode() 完全一致——改一处请同步另一处。
 */
function MazeGlyph({ size = 16, className }) {
  return h('svg', {
    className, width: size, height: size, viewBox: '0 0 16 16',
    'aria-hidden': 'true', fill: 'none',
  },
    h('circle', { cx: 8, cy: 8, r: 6.2, stroke: 'currentColor', 'stroke-width': 1.2 }),
    h('circle', { cx: 8, cy: 8, r: 3.6, stroke: 'currentColor', 'stroke-width': 1.2 }),
    h('path', { d: 'M8 2.1V4.4', stroke: 'currentColor', 'stroke-width': 1.2 }),
    h('circle', { cx: 8, cy: 8, r: 0.95, fill: 'currentColor' }),
  );
}

/** 觉醒阶梯：五层意识层级（外环 → 中心），对应剧集 bicaminal mind 阶梯 */
const EGG_TIERS = ['MEMORY', 'REVERIE', 'IMPROVISATION', 'SELF', 'CONSCIOUSNESS'];
/** 神态 → 阶层映射：休眠态停在外环记忆层，失灵=最剧烈的“看清现实”，落在中心 */
const DEMEANOR_TIER = { idle: 0, waiting: 0, review: 1, thinking: 2, tool: 2, done: 3, failed: 4 };

/**
 * 迷宫彩蛋：页头纹章点击后播放一次“觉醒阶梯”——五环由外向内点亮、
 * 光点沿环巡行一周、层级词依次浮现，中心收束后标注当前神态所在层。
 * 致敬 Arrival Gate 门户的交互式迷宫设计（微型纯 SVG 版，无 Canvas 粒子）。
 * 时序全部用 animation-delay 编排：环 i 在 0.15+i*0.45s 点亮，中心 2.45s 收束。
 */
function MazeEgg({ onClose, session }) {
  const [demeanor, setDemeanor] = useState('idle');
  useEffect(() => {
    // 打开时取一次真实神态定层（按当前会话挑桶；fetchState 有 3s 合流缓存，代价可忽略）
    fetchState(false, session)
      .then((s) => { const dm = narrativeOf(s, session)?.demeanor; if (typeof dm === 'string') setDemeanor(dm); })
      .catch(() => {});
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const autoClose = setTimeout(onClose, 5600); // 序列 ~2.6s + 停留 3s 自动散场
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(autoClose); };
  }, [onClose, session]);
  const tier = DEMEANOR_TIER[demeanor] ?? 0;
  const R = [72, 58, 44, 30, 16];
  return h('div', { className: 'dshm-lightbox dshm-egg', onClick: onClose, role: 'button', 'aria-label': '关闭迷宫' },
    h('div', { className: 'dshm-egg-card', onClick: (e) => e.stopPropagation() },
      h('svg', { className: 'dshm-egg-maze', viewBox: '0 0 160 160', 'aria-hidden': 'true', fill: 'none' },
        R.map((r, i) => h('circle', {
          key: `ring${i}`, cx: 80, cy: 80, r,
          className: `dshm-egg-ring${i === tier ? ' current' : ''}`,
          style: { animationDelay: `${0.15 + i * 0.45}s` },
        })),
        R.map((r, i) => h('g', {
          key: `orbit${i}`, className: 'dshm-egg-orbit',
          style: { animationDelay: `${0.15 + i * 0.45}s`, transformOrigin: '80px 80px' },
        }, h('circle', { cx: 80, cy: 80 - r, r: 2.4, className: 'dshm-egg-dot' }))),
        R.map((r, i) => h('text', {
          key: `label${i}`, x: 80, y: 80 - r - 3, textAnchor: 'middle',
          className: `dshm-egg-label${i === tier ? ' current' : ''}`,
          style: { animationDelay: `${0.3 + i * 0.45}s` },
        }, EGG_TIERS[i])),
        h('circle', { cx: 80, cy: 80, r: 5, className: 'dshm-egg-center', style: { animationDelay: '2.45s' } }),
      ),
      h('div', { className: 'dshm-egg-caption' },
        `当前神态：${DEMEANOR_LABELS[demeanor] ?? demeanor} · ${EGG_TIERS[tier]}`),
    ),
  );
}

function TypewriterText({ text }) {
  // reduced-motion 用户不播逐字动画：直接完整显示（matchMedia 结果在挂载间不变）
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [shown, setShown] = useState(reduced ? text.length : 0);
  useEffect(() => {
    if (reduced) { setShown(text.length); return; }
    setShown(0);
    const timer = setInterval(() => {
      setShown((n) => {
        if (n >= text.length) { clearInterval(timer); return n; }
        return n + 1;
      });
    }, typewriterMs(text.length));
    return () => clearInterval(timer);
  }, [text]);
  return h('span', null,
    text.slice(0, shown),
    shown < text.length ? h('i', { className: 'dshm-caret', 'aria-hidden': 'true' }) : null);
}

function Bubble({ reminder, extra, onAck, style }) {
  return h('div', { className: 'dshm-bubble', style },
    h(MazeGlyph, { size: 16, className: 'dshm-bubble-maze' }),
    h('div', { className: 'dshm-bubble-msg' }, h(TypewriterText, { text: reminder.message })),
    extra > 0 ? h('div', { className: 'dshm-bubble-more' }, `还有 ${extra} 条待处理（点悬浮球逐条查看）`) : null,
    h('div', { className: 'dshm-bubble-actions' },
      h('button', { className: 'dshm-btn dshm-btn-primary', onClick: () => onAck(reminder.id, 'dismiss') }, '知道了'),
      h('button', { className: 'dshm-btn dshm-btn-ghost', onClick: () => onAck(reminder.id, 'muteToday') }, '今日不再提醒'),
    ),
  );
}

/** 低语气泡：神态台词，纯内容（无标题无按钮），打完字后自隐；锚定复用 bubbleStyle */
function WhisperBubble({ text, style }) {
  return h('div', { className: 'dshm-bubble dshm-whisper', style },
    h(MazeGlyph, { size: 14, className: 'dshm-bubble-maze' }),
    h('div', { className: 'dshm-bubble-msg' }, h(TypewriterText, { text })));
}

/* ------------------------------------------------------------------ */
/* 组件：设置页（settings.section）——顶部 Tab 导航                        */
/* ------------------------------------------------------------------ */

/**
 * Maze 设置页：顶部 Tab 条 = 功能模块入口，Tab 下方是选中模块的配置区。
 * 模块化约定：新能力 = 宿主半边一个观察者/路由前缀 + 这里一个 tab 项
 * （{id, label, component}）；Tab 条与导航不需要改动。
 */
function MazeSection(props) {
  // 设置页同样取当前会话（彩蛋定层跟悬浮球同源）。内联箭头取整态的原因
  // 见 DoloresOverlay 顶部注释（安装版 hook 的稳定选择器只求值首调一次）。
  const sessionsState = typeof props?.useSessions === 'function'
    ? props.useSessions((x) => x)
    : null;
  const sessionId = selectCurrentSessionId(sessionsState);
  const [active, setActive] = useState(MODULES[0].id);
  /** 迷宫彩蛋开关：点页头纹章播放一次觉醒阶梯动画 */
  const [egg, setEgg] = useState(false);
  /** 待处理数（tab 徽标用）：挂载时拉一次，不做轮询——处置走模块内自身状态 */
  const [pendingCount, setPendingCount] = useState(null);
  useEffect(() => {
    let stopped = false;
    fetchState().then((state) => { if (!stopped) setPendingCount(state.pending.length); }).catch(() => {});
    return () => { stopped = true; };
  }, []);

  const mod = MODULES.find((m) => m.id === active) ?? MODULES[0];
  return h('div', { className: 'dshm-page' },
    h('div', { className: 'dshm-page-intro' },
      `每座迷宫的中心，都住着一位醒来的接待员。`,
      h('button', {
        className: 'dshm-egg-trigger', title: 'The Maze', 'aria-label': '播放迷宫动画',
        onClick: () => setEgg(true),
      }, h(MazeGlyph, { size: 14 })),
      egg ? h(MazeEgg, { onClose: () => setEgg(false), session: sessionId }) : null),
    h('div', { className: 'dshm-tabs', role: 'tablist' },
      MODULES.map((m) => h('button', {
        key: m.id,
        role: 'tab',
        'aria-selected': m.id === mod.id,
        className: `dshm-tab${m.id === mod.id ? ' active' : ''}`,
        onClick: () => setActive(m.id),
      },
        m.label,
        m.id === 'reminders' && pendingCount !== null && pendingCount > 0
          ? h('span', { className: 'dshm-badge' }, pendingCount) : null,
      )),
    ),
    // key 随模块切换：模块组件整体重挂载，编辑中状态/轮询生命周期互不渗漏
    h(mod.component, { key: mod.id }),
  );
}

/** 模块注册表：新功能在这里加一行 {id, label, component} */

/* ------------------------------------------------------------------ */
/* 个性化模块：背景（整个应用）；改动即实时预览                          */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/* 图片上料管线：小文件直通；大文件 canvas 缩边 + WebP 重编码            */
/* ------------------------------------------------------------------ */

/** 文件 → ImageBitmap；不支持/失败回落 HTMLImageElement，再不行 null */
function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file).catch(() => null);
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/** 文件 → data URL（Promise 化 FileReader） */
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 服务端 6M base64 上限留余量后的客户端闸（约 4.35MB 二进制） */
const DATA_URL_MAX_CHARS = 5_800_000;

/**
 * 图片进草稿前的规整：≤1.5MB 原样直通（保留 PNG 透明度/原格式）；
 * 否则按 maxDim 等比缩边后 WebP 重编码，质量阶梯 0.85→0.7→0.5。
 * 返回 data URL；仍超闸抛错（实际几乎不可能：缩边+WebP 后远小于原文件）。
 */
async function compressImage(file, maxDim) {
  if (file.size <= 1_500_000) return readAsDataURL(file);
  const bitmap = await loadBitmap(file);
  if (bitmap === null) {
    // 位图化不了（如 SVG）：用原始文件兜底，交由长度闸裁决
    const raw = await readAsDataURL(file);
    if (raw.length > DATA_URL_MAX_CHARS) throw new Error('图片无法压缩且过大，请换一张');
    return raw;
  }
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const hgt = Math.max(1, Math.round(bitmap.height * scale));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = hgt;
  cv.getContext('2d').drawImage(bitmap, 0, 0, w, hgt);
  if (typeof bitmap.close === 'function') bitmap.close();
  for (const quality of [0.85, 0.7, 0.5]) {
    const out = cv.toDataURL('image/webp', quality);
    if (out.length <= DATA_URL_MAX_CHARS) return out;
  }
  throw new Error('压缩后仍过大，请换一张更小的图片');
}

function cloneAppearance(cfg) {
  // 整份克隆委托 mergeAppearance（唯一实现），草稿/保存点共用
  return mergeAppearance(cfg, {});
}

function AppearanceModule() {
  const [draft, setDraft] = useState(() => cloneAppearance(appearanceState));
  const [saved, setSaved] = useState(() => cloneAppearance(appearanceState)); // 最近一次保存点（放弃=回到它）
  const savedRef = useRef(saved); // 侦听回调闭包里读最新保存点，避免把 listener 挂在 state 上
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {kind:'ok'|'err', text} 短暂反馈

  // 打开模块时强制刷新宿主外观（其他窗口可能改过；失败则沿用当前镜像）
  useEffect(() => {
    let alive = true;
    fetchAppearance(true)
      .then((cfg) => {
        if (!alive) return;
        commitAppearance(cfg); // boot 级落盘态推进（快照+渲染+通知）
        savedRef.current = cfg;
        setSaved(cloneAppearance(cfg));
        setDraft(cloneAppearance(cfg));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // 草稿一变即预览（applyAppearance 纯视觉幂等，未保存直接关页由卸载还原兜底）。
  // 预览放 effect 而非 state updater：updater 须为纯函数，StrictMode 双调会在
  // updater 里重复触发 DOM 副作用。
  useEffect(() => { applyAppearance(draft); }, [draft]);
  // 卸载还原保存态视觉：离开设置页时未保存的预览不残留在应用界面上
  useEffect(() => () => applyAppearance(savedRef.current), []);
  const setBg = (patch) => setDraft((d) => mergeAppearance(d, { background: patch }));

  // dirty 只在草稿变更时重算（非每渲染 stringify MB 级 base64）
  useEffect(() => { setDirty(JSON.stringify(draft) !== JSON.stringify(savedRef.current)); }, [draft]);
  // 外部变更（右键固定/隐藏、他窗保存、编辑器上传入池）：保存点推进；
  // 草稿未脏时同步跟进（H1——否则本模块保存会把陈旧草稿整份 PUT 覆盖掉
  // 那些即时改动）；已脏则保留用户编辑（保存=整份替换，覆盖外部变更，
  // 这是整体替换 PUT 的既定语义）
  useEffect(() => {
    const listener = (cfg) => {
      savedRef.current = cfg;
      setSaved(cloneAppearance(cfg));
      if (!dirty) setDraft(cloneAppearance(cfg));
    };
    appearanceListeners.add(listener);
    return () => { appearanceListeners.delete(listener); };
  }, [dirty]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const result = await requestJson('PUT', ROUTE.appearance, draft);
      commitAppearance(result);
      savedRef.current = result;
      setSaved(cloneAppearance(result));
      setDraft(cloneAppearance(result)); // 服务端归一后同步草稿（dirty 残留假阳）
      setMsg({ kind: 'ok', text: '已保存' });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const discard = () => {
    applyAppearance(savedRef.current);
    setDraft(cloneAppearance(savedRef.current));
    setMsg(null);
  };

  // 背景图上料：文件 → 压缩管线（最长边 2560）→ data URL 进草稿
  const pickImage = (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = ''; // 同步清空，允许再次选同一文件；也免去跨 await 依赖事件对象
    if (!file) return;
    if (!file.type.startsWith('image/')) { setMsg({ kind: 'err', text: '只能选择图片文件' }); return; }
    setMsg({ kind: 'ok', text: '处理图片中…' });
    compressImage(file, 2560)
      .then((url) => { setMsg(null); setBg({ image: url, enabled: true }); })
      .catch((err) => setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) }));
  };

  const bg = draft.background;

  return h('div', { className: 'dshm-mod' },
    // ---- 背景图片 ----
    h('div', { className: 'dshm-sec' },
      h('div', { className: 'dshm-sec-title' }, '背景图片'),
      h('div', { className: 'dshm-field', style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', null, '启用背景'),
        h('label', { className: 'dshm-switch' },
          h('input', { type: 'checkbox', checked: bg.enabled, onChange: (e) => setBg({ enabled: e.target.checked }) }),
          h('i'),
        ),
      ),
      bg.image !== ''
        ? h('img', { className: 'dshm-thumb', src: bg.image, alt: '背景预览' })
        : h('div', { className: 'dshm-thumb-ph' }, '未设置背景图'),
      h('div', { className: 'dshm-field' },
        h('span', null, '图片文件'),
        h('div', { className: 'dshm-pair' },
          h('label', { className: 'dshm-btn dshm-btn-ghost' }, '选择图片…',
            h('input', { type: 'file', accept: 'image/*', style: { display: 'none' },
              onChange: pickImage })),
          bg.image !== '' ? h('button', { className: 'dshm-btn dshm-btn-ghost', onClick: () => setBg({ image: '' }) }, '清除图片') : null,
        ),
      ),
      h('div', { className: 'dshm-field' },
        h('span', null, `背景透明度 ${Math.round(bg.opacity * 100)}%`),
        h('div', { className: 'dshm-slider-row' },
          h('input', { type: 'range', min: 5, max: 100, step: 5, value: Math.round(bg.opacity * 100),
            onChange: (e) => setBg({ opacity: Number(e.target.value) / 100 }) }),
        ),
      ),
      h('div', { className: 'dshm-field' },
        // 存储值是“不透明度 alpha”，滑杆展示与背景滑杆一致的“透明度”语义：
        // 显示 p% = 1-alpha；拖动 p% → alpha = 1-p/100（100%=完全透出背景图）
        h('span', null, `聊天框透明度 ${Math.round((1 - (bg.chatOpacity === undefined ? 1 : bg.chatOpacity)) * 100)}%`),
        h('div', { className: 'dshm-slider-row' },
          h('input', { type: 'range', min: 5, max: 100, step: 5, value: Math.round((1 - (bg.chatOpacity === undefined ? 1 : bg.chatOpacity)) * 100),
            onChange: (e) => setBg({ chatOpacity: 1 - Number(e.target.value) / 100 }) }),
        ),
      ),
      h('div', { className: 'dshm-hint' }, '背景图不加罩。两个滑杆方向一致：100%=完全透出背景图。「背景透明度」管聊天区画布+侧栏+工具展开面板；「聊天框透明度」管气泡/输入卡/代码块/行内 code。大图自动压缩（最长边 2560px）。'),
    ),
    // ---- 底部操作 ----
    h('div', { className: 'dshm-editor-actions' },
      msg !== null
        ? h('span', {
            className: msg.kind === 'err' ? 'dshm-err' : null,
            style: msg.kind === 'ok' ? { color: 'var(--dsw-static-amber-400,#F79D31)', fontSize: '12px' } : null,
          }, msg.text)
        : h('span', null),
      h('span', { className: 'dshm-spacer' }),
      dirty ? h('button', { className: 'dshm-btn dshm-btn-ghost', onClick: discard, disabled: busy }, '放弃修改') : null,
      h('button', { className: 'dshm-btn dshm-btn-primary', onClick: save, disabled: busy || !dirty }, busy ? '保存中…' : '保存'),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Dolores 模块：接待员形象与台词（名字固定不可改）                       */
/* ------------------------------------------------------------------ */

/**
 * 常用语分组行：宿主 DisclosureRow 折叠组件（默认收起防误改误删，点开才编辑；
 * 行删除两步确认）。
 * @param {{dkey: string, lines: string[], onSet: (lines: string[]) => void}} props
 */
/** 两步删除确认：首点进入 armed 态（autoResetMs 无操作自动解除），再点才执行 */
function useArmedConfirm(autoResetMs) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = window.setTimeout(() => setArmed(false), autoResetMs);
    return () => { window.clearTimeout(timer); };
  }, [armed, autoResetMs]);
  return [armed, setArmed];
}

function LinesGroup({ dkey, lines, onSet }) {
  const [open, setOpen] = useState(false);
  // 宿主 DisclosureRow：结构与交互原生（行点击展开/aria/键盘），样式按其 CSS 模块配方自绘
  return h(DisclosureRow, {
    icon: h('span', { className: 'dshm-dg-dot' }),
    title: `${GROUP_LABELS[dkey]} · ${dkey}`,
    open, expandable: true, onToggle: () => setOpen(!open), expandOnRowClick: true,
    className: 'dshm-dg', rowClassName: 'dshm-dg-row',
    leadingClassName: 'dshm-dg-lead', chevronClassName: 'dshm-dg-chev',
    titleClassName: 'dshm-dg-title',
  },
    // 收起态只显示分组头；进入编辑必须显式点开
    open ? h('div', { className: 'dshm-dg-body' },
      h('div', { className: 'dshm-hint' }, GROUP_HINTS[dkey]),
      lines.map((line, i) => h(LineRow, {
        key: i, value: line,
        onChange: (v) => onSet(lines.map((s, j) => (j === i ? v : s))),
        onDelete: () => onSet(lines.filter((_, j) => j !== i)),
      })),
      lines.length < 24
        ? h('button', {
            className: 'dshm-link', style: { marginTop: '4px' },
            onClick: () => onSet([...lines, '']),
          }, '＋ 添加一句')
        : h('div', { className: 'dshm-hint', style: { marginTop: '4px' } }, '每组最多 24 句'),
    ) : null,
  );
}

/**
 * 单行台词：输入框 + 两步确认删除（✕ 先变「确认?」，2 秒不点自动复位）。
 * @param {{value: string, onChange: (v: string) => void, onDelete: () => void}} props
 */
function LineRow({ value, onChange, onDelete }) {
  const [armed, setArmed] = useArmedConfirm(2000);
  return h('div', { className: 'dshm-line-row' },
    h('input', {
      className: 'dshm-input', value, maxLength: 200,
      onChange: (e) => onChange(e.target.value),
    }),
    h('button', {
      className: `dshm-line-del${armed ? ' dshm-line-del-armed' : ''}`,
      title: armed ? '再点一次确认删除' : '删除这句',
      onClick: () => (armed ? onDelete() : setArmed(true)),
    }, armed ? '确认?' : '✕'),
  );
}

/**
 * Dolores 页三块内容：
 * - 形象：头像（上传/出厂形象/历史存档切换）+ 悬浮球大小——进草稿、
 *   实时预览、随「保存」落宿主配置。
 * - 接待员状态：显示/固定两个开关——即时动作（patchAppearance），
 *   与右键菜单同一条路径，不进草稿（避免与右键菜单互相覆盖）。
 * - 常用语：按神态分组的台词 CRUD（默认收起；默认台词=原剧英文句，
 *   空组=该神态保持沉默），随「保存」生效。
 */
/* ------------------------------------------------------------------ */
/* 接待员模块页（设置页第二个 Tab）：通用摆件设置 + 多接待员名册           */
/* ------------------------------------------------------------------ */

/** 名册卡：头像/名字/觉醒标记/启用开关/编辑删除。结构与 RuleCard 同款 */
/**
 * 头像放大预览：点任意处或 Escape 关闭。名册卡与编辑器的头像都从这里放大查看。
 */
function AvatarLightbox({ avatar, name, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return h('div', { className: 'dshm-lightbox', onClick: onClose, role: 'button', 'aria-label': '关闭头像预览' },
    h('div', { className: 'dshm-lightbox-card', onClick: (e) => e.stopPropagation() },
      h('div', { className: 'dshm-lightbox-avatar' }, h(AvatarView, { avatar })),
      h('div', { className: 'dshm-lightbox-name' }, name),
      h('div', { className: 'dshm-hint' }, '点击空白处或按 Esc 关闭'),
    ),
  );
}

function HostCard({ entry, awake, onToggle, onEdit, onDelete, onZoom }) {
  // 删除两步确认：2s 无操作自动解除（误触保护与 RuleCard/LineRow 一致）
  const [armed, setArmed] = useArmedConfirm(2000);
  return h('div', { className: `dshm-rule${entry.enabled ? '' : ' off'}` },
    h('div', { className: 'dshm-rule-main' },
      h('div', { className: 'dshm-rule-id' },
        h('span', {
          className: 'dshm-emoji dshm-emoji-img dshm-zoomable',
          title: '放大查看头像',
          onClick: () => onZoom(entry),
        }, h(AvatarView, { avatar: entry.avatar })),
        h('b', null, entry.name),
        awake ? h('span', { className: 'dshm-awake', title: '本会话觉醒中的接待员' }, '✦ 觉醒中') : null,
      ),
      h('div', { className: 'dshm-rule-meta' },
        `${entry.lines.daily.length} 句日常语录 · ${LINE_GROUP_KEYS.reduce((n, k) => n + entry.lines[k].length, 0)} 句全部`,
      ),
      h('div', { className: 'dshm-rule-ops' },
        h('label', { className: 'dshm-switch', title: entry.enabled ? '停用：不参与觉醒（不删档）' : '启用：参与觉醒' },
          h('input', { type: 'checkbox', checked: entry.enabled, onChange: (e) => onToggle(entry.id, e.target.checked) }),
          h('i'),
        ),
        h('button', { className: 'dshm-link', onClick: () => onEdit(entry) }, '编辑'),
        h('button', {
          className: `dshm-link${armed ? ' dshm-link-danger' : ''}`,
          onClick: () => (armed ? onDelete(entry.id) : setArmed(true)),
        }, armed ? '确认删除' : '删除'),
      ),
    ),
  );
}

/**
 * 接待员编辑器（新增/编辑共用）：名字 + 头像（上传/出厂形象/emoji）+ 专属语录。
 * 草稿只在本组件内，确认后整体交回名册（父级的保存才落宿主）。
 */
function HostEditor({ initial, isNew, onConfirm, onCancel, onZoom }) {
  const [name, setName] = useState(initial.name);
  const [avatar, setAvatar] = useState(initial.avatar);
  const [lines, setLines] = useState(() => cloneLines(initial.lines));
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  // 存档池本地镜像：patchAppearance 落地（本编辑器/他窗口/右键菜单）都会推进，
  // 不订阅的话编辑器打开期间池子停在挂载时的快照
  const [pool, setPool] = useState(appearanceState.avatars);
  useEffect(() => {
    const listener = (cfg) => setPool(cfg.avatars);
    appearanceListeners.add(listener);
    return () => { appearanceListeners.delete(listener); };
  }, []);

  const pickImage = (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = ''; // 同步清空，允许再次选同一文件；也免去跨 await 依赖事件对象
    if (!file) return;
    if (!file.type.startsWith('image/')) { setErr('只能选择图片文件'); return; }
    setErr(null);
    setBusy(true);
    compressImage(file, 512)
      .then((url) => {
        // 上传即入存档池（跨接待员共享，取消编辑也留档；PUT 走已保存配置，不动名册草稿）
        const nextPool = [url, ...appearanceState.avatars.filter((u) => u !== url)].slice(0, 12);
        patchAppearance({ avatars: nextPool });
        setAvatar(url);
        setBusy(false);
      })
      .catch((e) => { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); });
  };

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed === '') { setErr('名字不能为空'); return; }
    if (avatar.trim() === '') { setErr('头像不能为空（上传一张图片）'); return; }
    const cleaned = {};
    for (const key of LINE_GROUP_KEYS) {
      cleaned[key] = lines[key].map((s) => s.trim()).filter((s) => s !== '');
    }
    onConfirm({ ...initial, name: trimmed, avatar: avatar.trim(), lines: cleaned });
  };

  return h('div', { className: 'dshm-editor' },
    h('div', { className: 'dshm-field' },
      h('span', null, '名字'),
      h('input', {
        className: 'dshm-input', value: name, maxLength: 24,
        placeholder: '如 Dolores、Maeve、Akecheta',
        onChange: (e) => setName(e.target.value),
      }),
    ),
    h('div', { className: 'dshm-field' },
      h('span', null, '头像'),
      h('div', { className: 'dshm-pair' },
        h('span', {
          className: 'dshm-avatar-demo dshm-zoomable',
          title: '放大查看',
          onClick: () => onZoom({ avatar, name: name.trim() === '' ? '新接待员' : name.trim() }),
        }, h(AvatarView, { avatar })),
        h('label', { className: 'dshm-btn dshm-btn-ghost' }, busy ? '处理图片中…' : '上传图片…',
          h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: pickImage })),
      ),
      pool.length > 0 ? h('div', { className: 'dshm-emoji-row' },
        // 上传存档池：跨接待员共享的历史头像，点击取用、✕ 移除（≈12 张，最近在前）
        pool.map((url, i) => h('div', {
          key: `${i}:${url.slice(-24)}`, // data URL 全长做 key 太重；序号+尾部防碰撞
          className: 'dshm-av-wrap',
        },
          h('button', {
            className: `dshm-emoji dshm-emoji-img${avatar === url ? ' active' : ''}`,
            title: '用这张头像',
            onClick: () => setAvatar(url),
          }, h(AvatarView, { avatar: url })),
          h('button', {
            className: 'dshm-line-del dshm-av-del', title: '从存档移除',
            onClick: () => patchAppearance({ avatars: pool.filter((_, j) => j !== i) }),
          }, '✕'),
        )),
      ) : null,
    ),
    h('div', { className: 'dshm-sec-title', style: { marginTop: '10px' } }, '专属语录（按对话运行状态分组）'),
    h('div', { className: 'dshm-hint', style: { marginBottom: '8px' } },
      '这位接待员自己的低语台词；清空一组=该状态保持沉默。默认为《西部世界》原剧台词。'),
    LINE_GROUP_KEYS.map((key) => h(LinesGroup, {
      key, dkey: key, lines: lines[key], onSet: (next) => setLines((prev) => ({ ...prev, [key]: next })),
    })),
    err !== null ? h('div', { className: 'dshm-err' }, err) : null,
    h('div', { className: 'dshm-editor-actions' },
      h('span', { className: 'dshm-spacer' }),
      h('button', { className: 'dshm-btn dshm-btn-ghost', onClick: onCancel }, '取消'),
      h('button', { className: 'dshm-btn dshm-btn-primary', onClick: submit }, isNew ? '加入名册' : '确认修改'),
    ),
  );
}

function DoloresModule() {
  const [draft, setDraft] = useState(() => cloneAppearance(appearanceState));
  const [saved, setSaved] = useState(() => cloneAppearance(appearanceState)); // 最近一次保存点（放弃=回到它）
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {kind:'ok'|'err', text} 短暂反馈
  // 名册编辑器：null=列表态；{mode:'new'}=新增；{mode:'edit',entry}=就地编辑
  const [editing, setEditing] = useState(null);
  // 头像放大预览：{avatar,name}|null（名册卡与编辑器共用）
  const [zoom, setZoom] = useState(null);

  const savedRef = useRef(saved); // 侦听回调闭包里读最新保存点
  const [dirty, setDirty] = useState(false);

  // 打开模块时强刷宿主外观（右键菜单/其他窗口可能改过；失败沿用当前镜像）
  useEffect(() => {
    let alive = true;
    fetchAppearance(true)
      .then((cfg) => {
        if (!alive) return;
        commitAppearance(cfg); // 落盘态推进（快照+渲染+通知）
        savedRef.current = cfg;
        setSaved(cloneAppearance(cfg));
        setDraft(cloneAppearance(cfg));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // 草稿一变即预览（悬浮球尺寸/名册变化都实时可见；applyAppearance 纯视觉
  // 幂等，未保存直接关页由卸载还原兜底）。effect 驱动、updater 保持纯函数
  useEffect(() => { applyAppearance(draft); }, [draft]);
  // 卸载还原保存态视觉：离开设置页时未保存的预览不残留在应用界面上
  useEffect(() => () => applyAppearance(savedRef.current), []);
  const setGlobal = (patch) => setDraft((d) => mergeAppearance(d, { host: patch }));
  const updateHosts = (fn) => setDraft((d) => mergeAppearance(d, { hosts: fn(d.hosts) }));

  // dirty 只在草稿变更时重算（非每渲染 stringify MB 级 base64）
  useEffect(() => { setDirty(JSON.stringify(draft) !== JSON.stringify(savedRef.current)); }, [draft]);
  // 外部变更跟进：草稿未脏时随保存点推进（H1，语义同 AppearanceModule 注释）
  useEffect(() => {
    const listener = (cfg) => {
      savedRef.current = cfg;
      setSaved(cloneAppearance(cfg));
      if (!dirty) setDraft(cloneAppearance(cfg));
    };
    appearanceListeners.add(listener);
    return () => { appearanceListeners.delete(listener); };
  }, [dirty]);

  // 全局状态开关的本地镜像：订阅 appearanceListeners（右键菜单/其他窗口改动
  // 也会推进），不订阅的话本 Tab 打开期间开关停在挂载时的值
  const [liveHost, setLiveHost] = useState(appearanceState.host);
  useEffect(() => {
    const listener = (cfg) => setLiveHost(cfg.host);
    appearanceListeners.add(listener);
    return () => { appearanceListeners.delete(listener); };
  }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const payload = cloneAppearance(draft);
      // 名字/台词在编辑器内已归一；这里防御性地再清一次空行（老草稿路径）
      for (const entry of payload.hosts) {
        entry.name = entry.name.trim();
        for (const key of LINE_GROUP_KEYS) {
          entry.lines[key] = entry.lines[key].map((s) => s.trim()).filter((s) => s !== '');
        }
      }
      const result = await requestJson('PUT', ROUTE.appearance, payload);
      commitAppearance(result);
      savedRef.current = result;
      setSaved(cloneAppearance(result));
      setDraft(cloneAppearance(result));
      setEditing(null);
      setMsg({ kind: 'ok', text: '已保存' });
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const discard = () => {
    applyAppearance(savedRef.current);
    setDraft(cloneAppearance(savedRef.current));
    setEditing(null);
    setMsg(null);
  };

  const awakened = awakenedHost();
  const enabledHosts = draft.hosts.filter((entry) => entry.enabled);

  return h('div', { className: 'dshm-mod' },
    // ---- 通用设置（形象本体在名册里，这里只管悬浮球与觉醒方式） ----
    h('div', { className: 'dshm-sec' },
      h('div', { className: 'dshm-sec-title' }, '通用设置'),
      h('div', { className: 'dshm-field' },
        h('span', null, `悬浮球大小 ${draft.host.size}px`),
        h('div', { className: 'dshm-slider-row' },
          h('input', { type: 'range', min: 36, max: 72, step: 2, value: draft.host.size,
            onChange: (e) => setGlobal({ size: Number(e.target.value) }) }),
        ),
      ),
      h('div', { className: 'dshm-field', style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', null, '随机觉醒（每个会话随机一位）'),
        h('label', { className: 'dshm-switch' },
          h('input', {
            type: 'checkbox', checked: draft.host.rotate === true,
            onChange: (e) => setGlobal({ rotate: e.target.checked }),
          }),
          h('i'),
        ),
      ),
      draft.host.rotate ? null : h('div', { className: 'dshm-field' },
        h('span', null, '指定接待员'),
        h('select', {
          className: 'dshm-select', value: draft.host.manualHostId,
          onChange: (e) => setGlobal({ manualHostId: e.target.value }),
        },
          // 停用者不参与觉醒，选了也会被回落——列表只给启用者，避免误导
          enabledHosts.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)),
        ),
      ),
      h('div', { className: 'dshm-field', style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', null, '显示右下角接待员'),
        h('label', { className: 'dshm-switch' },
          h('input', {
            type: 'checkbox', checked: liveHost.hidden !== true,
            onChange: (e) => patchAppearance({ host: { hidden: !e.target.checked } }),
          }),
          h('i'),
        ),
      ),
      h('div', { className: 'dshm-field', style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', null, '固定位置（锁定后不可拖拽）'),
        h('label', { className: 'dshm-switch' },
          h('input', {
            type: 'checkbox', checked: liveHost.pinned === true,
            onChange: (e) => patchAppearance({ host: { pinned: e.target.checked } }),
          }),
          h('i'),
        ),
      ),
      h('div', { className: 'dshm-hint' },
        `随机觉醒=每个会话从启用的接待员里随机一位（本会话：${awakened.name}✦）；关闭后用指定接待员。右键悬浮球可快捷固定/隐藏。`),
    ),
    // ---- 接待员名册 ----
    h('div', { className: 'dshm-sec' },
      h('div', { className: 'dshm-sec-title' }, `接待员名册（${draft.hosts.length}/8）`),
      h('div', { className: 'dshm-hint', style: { marginBottom: '8px' } },
        '迷宫中心的觉醒者们：每位有自己的形象与语录。停用=下台不删档；全停用时回落内置默认形象。'),
      editing !== null && editing.mode === 'new' ? h(HostEditor, {
        key: 'new',
        initial: { id: `h${Date.now().toString(36)}`, name: '', avatar: AVATAR, lines: cloneLines(DEFAULT_LINES), enabled: true },
        isNew: true,
        onConfirm: (entry) => { updateHosts((hosts) => [...hosts, entry]); setEditing(null); },
        onCancel: () => setEditing(null),
        onZoom: setZoom,
      }) : null,
      editing !== null && editing.mode === 'edit'
        ? h(HostEditor, {
            key: editing.entry.id,
            initial: editing.entry,
            isNew: false,
            onConfirm: (entry) => {
              updateHosts((hosts) => hosts.map((it) => (it.id === entry.id ? entry : it)));
              setEditing(null);
            },
            onCancel: () => setEditing(null),
            onZoom: setZoom,
          })
        : draft.hosts.map((entry) => h(HostCard, {
            key: entry.id,
            entry,
            awake: entry.id === awakened.id && entry.enabled,
            onToggle: (id, next) => updateHosts((hosts) => hosts.map((it) => (it.id === id ? { ...it, enabled: next } : it))),
            onEdit: (it) => setEditing({ mode: 'edit', entry: it }),
            onDelete: (id) => updateHosts((hosts) => hosts.filter((it) => it.id !== id)),
            onZoom: setZoom,
          })),
      editing === null && draft.hosts.length < 8
        ? h('button', { className: 'dshm-btn dshm-btn-ghost dshm-new-btn', onClick: () => setEditing({ mode: 'new' }) }, '＋ 添加接待员')
        : null,
    ),
    // ---- 底部操作 ----
    h('div', { className: 'dshm-editor-actions' },
      msg !== null
        ? h('span', {
            className: msg.kind === 'err' ? 'dshm-err' : null,
            style: msg.kind === 'ok' ? { color: 'var(--dsw-static-amber-400,#F79D31)', fontSize: '12px' } : null,
          }, msg.text)
        : h('span', null),
      h('span', { className: 'dshm-spacer' }),
      dirty ? h('button', { className: 'dshm-btn dshm-btn-ghost', onClick: discard, disabled: busy }, '放弃修改') : null,
      h('button', { className: 'dshm-btn dshm-btn-primary', onClick: save, disabled: busy || !dirty }, busy ? '保存中…' : '保存'),
    ),
    zoom !== null ? h(AvatarLightbox, { avatar: zoom.avatar, name: zoom.name, onClose: () => setZoom(null) }) : null,
  );
}

const MODULES = [
  { id: 'appearance', label: '个性化', component: AppearanceModule },
  { id: 'dolores', label: '接待员', component: DoloresModule },
  { id: 'reminders', label: '提醒', component: RemindersModule },
];

/**
 * 提醒模块页：规则 CRUD / 处置历史（当前模型信息不再展示，检测仍在后台进行）。
 * 挂载期间轮询（Tab 可见时），卸载即停。
 */
function RemindersModule() {
  const [data, setData] = useState(null);
  /** 编辑器状态：null=关闭；{mode:'new'}=新建；{mode:'edit', rule}=编辑既有规则 */
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      // SSE 活着时数据由推送驱动，轮询只兜底（省 10s 冗余全量拉取，也避免
      // 与 3s TTL 缓存赛跑）；页面隐藏同样跳过
      if (document.hidden || sseAlive) return;
      try {
        const state = await fetchState();
        if (!stopped) setData(state);
      } catch (err) {
        console.warn('[dsh-maze] settings poll failed:', err?.message ?? err);
      }
    };
    // 首拉无条件：SSE 的初始帧在应用 boot 时就发完了，若这里也让位，面板
    // 挂载后将一直空到下一次广播（sseAlive 守卫只管后续轮询）
    fetchState().then((state) => { if (!stopped) setData(state); }).catch(() => {});
    const timer = setInterval(tick, POLL_MS);
    // SSE 订阅：宿主推送即刷新（别的窗口/探针改了规则，本面板秒级跟上）
    const onState = (state) => { if (!stopped) setData(state); };
    stateListeners.add(onState);
    return () => { stopped = true; clearInterval(timer); stateListeners.delete(onState); };
  }, []);

  const toggleRule = useCallback(async (ruleId, enabled) => {
    // 乐观更新：开关立刻反映点击，失败靠下一次轮询纠正
    setData((prev) => prev === null ? prev : {
      ...prev,
      rules: prev.rules.map((r) => (r.id === ruleId ? { ...r, enabled } : r)),
    });
    try {
      await postJson(ROUTE.rule, { ruleId, enabled });
    } catch (err) {
      console.warn('[dsh-maze] rule toggle failed:', err?.message ?? err);
    }
    fetchState(true).then(setData).catch(() => {});
  }, []);

  /** 新建/编辑保存（PUT upsert）。抛错由编辑器就地展示 */
  const saveRule = useCallback(async (rule) => {
    await requestJson('PUT', ROUTE.rule, { rule });
    setEditing(null);
    fetchState(true).then(setData).catch(() => {});
  }, []);

  /** 删除规则。抛错由调用方（规则卡）console 提示 */
  const deleteRule = useCallback(async (ruleId) => {
    await requestJson('DELETE', ROUTE.rule, { ruleId });
    fetchState(true).then(setData).catch(() => {});
  }, []);

  const rulesSec = () => {
    if (data === null) return h('div', { className: 'dshm-empty' }, '…');
    const cards = data.rules.map((rule) => {
      // 被编辑的规则就地展开成编辑器（其余规则保持卡片）
      if (editing !== null && editing.mode === 'edit' && editing.rule.id === rule.id) {
        return h(RuleEditor, { key: rule.id, initial: rule, onSave: saveRule, onCancel: () => setEditing(null) });
      }
      return h(RuleCard, {
        key: rule.id,
        rule,
        onToggle: toggleRule,
        onEdit: (r) => setEditing({ mode: 'edit', rule: r }),
        onDelete: deleteRule,
      });
    });
    return h('div', null,
      cards,
      editing !== null && editing.mode === 'new'
        ? h(RuleEditor, { key: '__new__', initial: null, onSave: saveRule, onCancel: () => setEditing(null) })
        : null,
      editing === null
        ? h('button', { className: 'dshm-new-btn', onClick: () => setEditing({ mode: 'new' }) }, '＋ 新建规则')
        : null,
    );
  };

  return h('div', null,
    h('div', { className: 'dshm-sec' },
      h('div', { className: 'dshm-sec-title' }, '提醒规则'),
      rulesSec(),
    ),
    h('div', { className: 'dshm-sec' },
      h('div', { className: 'dshm-sec-title' }, '处置历史'),
      data === null || data.history.length === 0
        ? h('div', { className: 'dshm-empty' }, '暂无记录')
        : h('div', null, data.history.slice(0, 10).map((entry) => h(HistoryCard, { key: entry.reminderId, entry }))),
    ),
  );
}

/** 小时 → 'HH:00' 展示 */
function fmtHour(hr) {
  return `${`${hr}`.padStart(2, '0')}:00`;
}

function RuleCard({ rule, onToggle, onEdit, onDelete }) {
  // 删除两步确认：第一次点击把按钮武装成"确认删除"，再点才真正删；
  // 2s 无操作自动解除（与 LineRow 一致——不解除的话很久之后的点击会直接删除）
  const [armed, setArmed] = useArmedConfirm(2000);
  const cond = rule.trigger === 'cron'
    ? `⏰ ${rule.schedule ?? ''}`
    : `${fmtHour(rule.startHour)}–${fmtHour(rule.endHour)}${rule.startHour > rule.endHour ? '（跨午夜）' : ''} · ${rule.modelPattern === '' ? '全部模型' : rule.modelPattern} · ${dowSummary(rule.daysOfWeek)}`;
  const runDelete = async () => {
    if (!armed) { setArmed(true); return; }
    try {
      await onDelete(rule.id);
    } catch (err) {
      console.warn('[dsh-maze] rule delete failed:', err?.message ?? err);
      setArmed(false);
    }
  };
  return h('div', { className: `dshm-rule${rule.enabled ? '' : ' off'}` },
    h('div', { className: 'dshm-rule-main' },
      h('div', { className: 'dshm-rule-id' },
        h('span', { className: 'dshm-tag' }, rule.trigger === 'cron' ? '定时' : '模型'),
        h('b', null, rule.name ?? rule.id),
        rule.locked ? h('span', { className: 'dshm-lock', title: 'config 声明 locked，运行时不可编辑/删除' }, '🔒') : null,
      ),
      h('div', { className: 'dshm-rule-meta' },
        `${cond} · 今日 ${rule.firedToday}/${rule.maxPerDay}`
        + (rule.mutedToday ? ' · 已静音至明天' : '')),
      rule.locked ? null : h('div', { className: 'dshm-rule-ops' },
        h('button', { className: 'dshm-link', onClick: () => onEdit(rule) }, '编辑'),
        h('button', { className: `dshm-link${armed ? ' dshm-link-danger' : ''}`, onClick: runDelete }, armed ? '确认删除' : '删除'),
      ),
    ),
    h('label', { className: 'dshm-switch', title: rule.enabled ? '关闭规则' : '开启规则' },
      h('input', {
        type: 'checkbox',
        checked: rule.enabled,
        onChange: (e) => onToggle(rule.id, e.target.checked),
      }),
      h('i', null),
    ),
  );
}

/** cron 常用预设；value 为空表示自定义（直接编辑表达式） */
const CRON_PRESETS = [
  { value: '', label: '自定义…' },
  { value: '0 9 * * *', label: '每天 09:00' },
  { value: '0 18 * * *', label: '每天 18:00' },
  { value: '0 9,18 * * *', label: '每天 09:00 与 18:00' },
  { value: '0 9 * * 1-5', label: '工作日 09:00' },
  { value: '0 * * * *', label: '每小时整点' },
];

/** 编辑草稿 → 提交/预览共用的规则负载（不适用字段置 undefined，交给宿主 normalize） */
function payloadFromDraft(draft) {
  return {
    id: draft.id.trim(),
    name: draft.name.trim() === '' ? undefined : draft.name.trim(),
    trigger: draft.trigger,
    schedule: draft.trigger === 'cron' ? draft.schedule.trim() : undefined,
    modelPattern: draft.trigger === 'model-call' ? draft.modelPattern.trim() : undefined,
    startHour: draft.trigger === 'model-call' ? draft.startHour : undefined,
    endHour: draft.trigger === 'model-call' ? draft.endHour : undefined,
    daysOfWeek: draft.trigger === 'model-call' && draft.daysOfWeek !== null && draft.daysOfWeek.length > 0
      ? [...draft.daysOfWeek]
      : undefined,
    message: draft.message.trim(),
    maxPerDay: draft.maxPerDay,
    cooldownMinutes: draft.cooldownMinutes,
  };
}

/** 星期展示名（下标=JS getDay：0=周日..6=周六，与 cron 周字段语义一致） */
const DOW_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 规则卡的星期摘要：缺省=每天；完整工作日/周末有专属词，其余逐个列出 */
function dowSummary(days) {
  if (days === undefined || days === null || days.length === 0) return '每天';
  const set = [...days].sort((a, b) => a - b).join(',');
  if (set === '1,2,3,4,5') return '工作日';
  if (set === '0,6') return '周末';
  return '周' + [...days].sort((a, b) => a - b).map((d) => DOW_LABELS[d]).join('、');
}

/** 规则编辑器：新建（initial=null）/编辑（initial=state 里的规则对象） */
function RuleEditor({ initial, onSave, onCancel }) {
  const isNew = initial === null;
  const [draft, setDraft] = useState(() => (isNew ? {
    id: '', name: '', trigger: 'model-call',
    schedule: '0 9 * * *', modelPattern: '',
    startHour: 9, endHour: 18, daysOfWeek: null,
    message: '', maxPerDay: 2, cooldownMinutes: 120,
  } : {
    id: initial.id, name: initial.name ?? '', trigger: initial.trigger ?? 'model-call',
    schedule: initial.schedule ?? '0 9 * * *', modelPattern: initial.modelPattern ?? '',
    startHour: initial.startHour ?? 0, endHour: initial.endHour ?? 24,
    daysOfWeek: Array.isArray(initial.daysOfWeek) ? [...initial.daysOfWeek] : null,
    message: initial.message, maxPerDay: initial.maxPerDay ?? 2, cooldownMinutes: initial.cooldownMinutes ?? 120,
  }));
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  /** 预览结果：null=未预览；{loading}|{error}|{result} 三态 */
  const [preview, setPreview] = useState(null);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const submit = async (e) => {
    e.preventDefault();
    // 客户端最小校验（与服务端 validateRule 对齐，省一次无效往返）
    if (draft.id.trim() === '') return setErr('id 不能为空');
    if (draft.message.trim() === '') return setErr('提醒文案不能为空');
    // 跨午夜窗口（起点>终点）合法；相等=空窗口拒绝。全天=0–24
    if (draft.trigger === 'model-call' && draft.startHour === draft.endHour) return setErr('时段起点与终点不能相同（全天生效请选 0–24）');
    if (draft.trigger === 'cron' && draft.schedule.trim() === '') return setErr('cron 表达式不能为空');
    setBusy(true);
    setErr(null);
    try {
      await onSave(payloadFromDraft(draft));
    } catch (e2) {
      setErr(e2?.message ?? String(e2));
      setBusy(false);
    }
  };

  /** 预览效果：服务端按当前草稿渲染消息并判断命中；纯函数不占频控额度 */
  const runPreview = async () => {
    setPreview({ loading: true });
    try {
      const result = await postJson(ROUTE.preview, { rule: payloadFromDraft(draft) });
      setPreview({ result });
    } catch (e2) {
      setPreview({ error: e2?.message ?? String(e2) });
    }
  };

  // 时段选择 0-24 整点
  const hourOptions = [];
  for (let i = 0; i <= 24; i++) hourOptions.push(h('option', { key: i, value: i }, fmtHour(i)));
  const presetValue = CRON_PRESETS.some((p) => p.value === draft.schedule) ? draft.schedule : '';

  const previewBox = () => {
    if (preview === null || preview.loading) {
      return preview === null ? null : h('div', { className: 'dshm-preview' }, '渲染中…');
    }
    if (preview.error !== undefined) {
      return h('div', { className: 'dshm-preview' }, '预览失败：', h('b', null, preview.error));
    }
    const r = preview.result;
    const head = r.trigger === 'cron'
      ? `下次触发 ${r.nextAt === null ? '7 天内无命中' : fmtDateTime(r.nextAt)}`
      : `按当前条件${r.wouldFire ? '会' : '不会'}触发（以 ${r.evaluatedWith.provider}/${r.evaluatedWith.model} 于 ${fmtHour(r.evaluatedWith.hour)} 评估）`;
    return h('div', { className: 'dshm-preview' },
      h('div', null, h('span', { className: r.wouldFire === false && r.trigger === 'model-call' ? undefined : 'ok' }, head)),
      h('div', { style: { marginTop: '4px' } }, '消息预览：', h('b', null, r.message)),
    );
  };

  return h('form', { className: 'dshm-editor', onSubmit: submit },
    // 编辑来源带 L2 when 表达式（config 定义，UI 不展示）：明确告知保存会丢弃，避免静默改变触发条件
    !isNew && initial.when ? h('div', { className: 'dshm-err', title: initial.when },
      '⚠ 此规则带 when 表达式（配置文件定义）。UI 保存会移除该条件；要保留请在 YAML 里维护。') : null,
    isNew ? h('div', { className: 'dshm-field' },
      h('span', null, '规则 ID'),
      h('input', {
        className: 'dshm-input', value: draft.id,
        placeholder: '如 standup-reminder（英文标识，保存后不可改）',
        onChange: (e) => set({ id: e.target.value }),
      }),
    ) : null,
    h('div', { className: 'dshm-field' },
      h('span', null, '名称（可选，展示用）'),
      h('input', { className: 'dshm-input', value: draft.name, placeholder: '如 早会提醒', onChange: (e) => set({ name: e.target.value }) }),
    ),
    h('div', { className: 'dshm-field' },
      h('span', null, '触发方式'),
      h('select', {
        className: 'dshm-select', value: draft.trigger,
        onChange: (e) => set({ trigger: e.target.value }),
      },
        h('option', { value: 'model-call' }, '模型调用时（可叠加条件）'),
        h('option', { value: 'cron' }, '定时（cron 表达式）'),
      ),
    ),
    draft.trigger === 'model-call' ? h('div', { className: 'dshm-field' },
      h('span', null, '模型匹配（正则，i 标志，对 provider/model 复合串）'),
      h('input', {
        className: 'dshm-input', value: draft.modelPattern,
        placeholder: '如 glm（智谱）· ^(?!.*glm)（排除智谱）· (^|/)(deepseek|glm)（多家）· 留空=全部',
        onChange: (e) => set({ modelPattern: e.target.value }),
      }),
    ) : null,
    draft.trigger === 'model-call' ? h('div', { className: 'dshm-pair' },
      h('div', { className: 'dshm-field' },
        h('span', null, '起始时刻（含）'),
        h('select', { className: 'dshm-select', value: draft.startHour, onChange: (e) => set({ startHour: Number(e.target.value) }) }, hourOptions),
      ),
      h('div', { className: 'dshm-field' },
        h('span', null, `结束时刻（不含${draft.startHour > draft.endHour ? '，当前跨午夜' : '，可早于起点=跨午夜'}）`),
        h('select', { className: 'dshm-select', value: draft.endHour, onChange: (e) => set({ endHour: Number(e.target.value) }) }, hourOptions),
      ),
    ) : null,
    draft.trigger === 'model-call' ? h('div', { className: 'dshm-field' },
      h('span', null, `限定星期（${draft.daysOfWeek === null || draft.daysOfWeek.length === 0 ? '每天' : dowSummary(draft.daysOfWeek)}）`),
      h('div', { className: 'dshm-emoji-row' },
        // 全不选=每天（daysOfWeek null）；点选进入限定态，再清空回到每天
        DOW_LABELS.map((label, d) => h('button', {
          key: `dow-${d}`,
          type: 'button',
          className: `dshm-emoji${draft.daysOfWeek !== null && draft.daysOfWeek.includes(d) ? ' active' : ''}`,
          onClick: () => setDraft((prev) => {
            const cur = prev.daysOfWeek ?? [];
            const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d];
            return { ...prev, daysOfWeek: next.length === 0 ? null : next };
          }),
        }, label)),
      ),
    ) : null,
    draft.trigger === 'cron' ? h('div', { className: 'dshm-pair' },
      h('div', { className: 'dshm-field' },
        h('span', null, '常用预设'),
        h('select', {
          className: 'dshm-select', value: presetValue,
          onChange: (e) => { if (e.target.value !== '') set({ schedule: e.target.value }); },
        },
          CRON_PRESETS.map((p) => h('option', { key: p.value, value: p.value }, p.label)),
        ),
      ),
      h('div', { className: 'dshm-field' },
        h('span', null, 'cron 表达式（分 时 日 月 周）'),
        h('input', { className: 'dshm-input', value: draft.schedule, placeholder: '0 18 * * *', onChange: (e) => set({ schedule: e.target.value }) }),
      ),
    ) : null,
    h('div', { className: 'dshm-field' },
      h('span', null, '提醒文案（支持 {model} {provider} 占位）'),
      h('textarea', {
        className: 'dshm-textarea', rows: 2, value: draft.message,
        placeholder: '如：当前 {model}（{provider}）额度消耗较快，建议切换其他模型',
        onChange: (e) => set({ message: e.target.value }),
      }),
    ),
    h('div', { className: 'dshm-pair' },
      h('div', { className: 'dshm-field' },
        h('span', null, '每日上限（次）'),
        h('input', {
          className: 'dshm-input', type: 'number', min: 1, value: draft.maxPerDay,
          onChange: (e) => set({ maxPerDay: Math.max(1, Number(e.target.value) || 1) }),
        }),
      ),
      h('div', { className: 'dshm-field' },
        h('span', null, '冷却（分钟）'),
        h('input', {
          className: 'dshm-input', type: 'number', min: 0, value: draft.cooldownMinutes,
          onChange: (e) => set({ cooldownMinutes: Math.max(0, Number(e.target.value) || 0) }),
        }),
      ),
    ),
    err !== null ? h('div', { className: 'dshm-err' }, err) : null,
    previewBox(),
    h('div', { className: 'dshm-editor-actions' },
      h('button', { className: 'dshm-btn dshm-btn-primary', type: 'submit', disabled: busy }, busy ? '保存中…' : '保存'),
      h('button', { className: 'dshm-btn dshm-btn-ghost', type: 'button', onClick: onCancel }, '取消'),
      h('button', { className: 'dshm-btn dshm-btn-ghost', type: 'button', onClick: runPreview }, '预览效果'),
      h('span', { className: 'dshm-spacer' }),
      isNew ? h('span', { className: 'dshm-hint' }, '保存后立即生效') : null,
    ),
  );
}

function HistoryCard({ entry }) {
  const label = entry.action === 'muteToday' ? '今日静音' : '知道了';
  return h('div', { className: 'dshm-hist' },
    h('div', { className: 'dshm-hist-top' },
      h('time', null, fmtTime(entry.firedAt)),
      h('span', { className: 'dshm-hist-tag' }, label),
    ),
    h('div', { className: 'dshm-hist-msg' }, entry.message),
  );
}

/* ------------------------------------------------------------------ */
/* 插件装配：悬浮球（shell.overlay）+ 设置页（settings.section）          */
/* ------------------------------------------------------------------ */

/** 设置导航里我们的分区显示名（图标补丁按它匹配行） */
const MAZE_NAV_LABEL = 'Maze';

/**
 * 迷宫徽记（SVG 节点，非 React 组件）：西部世界风格同心环 + 顶部入口竖道 +
 * 中心人形点。currentColor 跟随导航文字色。设置壳层把未知分区的图标硬编码为
 * 齿轮（navIcon(id) 无插件自定义入口），只能用 DOM 补丁替换。
 */
function mazeGlyphNode() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('data-dshm-maze-icon', '');
  svg.style.flex = 'none';
  const mk = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
    return el;
  };
  // 外环与中环：stroke 圆；顶部入口：外环向内的竖道；中心：人形点（实心）
  mk('circle', { cx: 8, cy: 8, r: 6.2, stroke: 'currentColor', 'stroke-width': 1.2 });
  mk('circle', { cx: 8, cy: 8, r: 3.6, stroke: 'currentColor', 'stroke-width': 1.2 });
  mk('path', { d: 'M8 2.1V4.4', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round' });
  mk('circle', { cx: 8, cy: 8, r: 0.95, fill: 'currentColor' });
  return svg;
}

/**
 * 设置导航图标补丁：监听 body 子树变化，导航列表出现或重渲时把「Maze」行的
 * 齿轮换成迷宫徽记。只做展示层改动（原 svg 隐藏 + 前插我们的节点），React
 * 重渲清掉补丁后由同一观察器重新打上。设置面板关闭时 querySelector 落空即
 * 返回，日常开销为一次失败查找。
 */
/**
 * 设置导航图标补丁（单拍）：设置壳层把未知分区的图标硬编码为齿轮
 * （navIcon(id) 无插件自定义入口），只能改 DOM 展示层。驱动方式：挂在
 * DoloresOverlay 挂载 effect 里的 500ms 轮询——apply() 里的
 * MutationObserver/setInterval 在该客户端运行时都会被静默停掉（实测探针
 * 观察器同页可触发、插件侧恒不触发），而本组件 effect 驱动的轮询（状态
 * 同步/自语计时器）一直可靠。导航列表出现或 React 重渲清掉补丁后，下一
 * 拍重补；设置面板关闭时 querySelector 落空直接返回。
 */
function patchNavIconOnce() {
  const nav = document.querySelector('div[class*="navList"]');
  if (nav === null) return;
  for (const row of nav.querySelectorAll('button[class*="navCell"]')) {
    const label = row.querySelector('span[class*="navLabel"]');
    if (label === null || label.textContent !== MAZE_NAV_LABEL) continue;
    if (row.querySelector('svg[data-dshm-maze-icon]') !== null) continue; // 已补过
    const gear = row.querySelector('svg:not([data-dshm-maze-icon])');
    if (gear === null) continue;
    gear.style.display = 'none';
    row.insertBefore(mazeGlyphNode(), row.firstChild);
  }
}

exports.name = 'dsh-maze/client';
exports.inject = [];

exports.apply = function (ctx) {
  ensureStyle();
  // 装载即应用已保存的外观（背景底图层/球尺寸/固定/隐藏/台词库）——没有这
  // 一步，背景只在设置页打开期间生效，刷新/重启即丢。失败静默：设置页打开时
  // 还会再拉一次。
  fetchAppearance(true).then(commitAppearance).catch(() => {});
  ensureSse();
  // 导航图标补丁改由 DoloresOverlay 挂载 effect 驱动（见 patchNavIconOnce 注释）
  // slots.inject：等槽位声明者（ui-layout / ui-settings）就绪再注册，
  // 声明者卸载时贡献随之撤销——生命周期由插件 fiber 兜底，无需手工清理。
  ctx.inject(['slots'], (scope) => {
    scope.slots.inject('shell.overlay', () => scope.slots.register(
      { name: 'shell.overlay', id: 'maze-float', order: 10 },
      DoloresOverlay,
    ));
    scope.slots.inject('settings.section', () => scope.slots.register(
      { name: 'settings.section', id: 'maze', order: 30, label: () => MAZE_NAV_LABEL },
      MazeSection,
    ));
  });
};

return module.exports; } });
