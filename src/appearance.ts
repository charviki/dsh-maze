/**
 * 外观偏好持久化：背景图（整个应用界面）+ 接待员全局摆件设置（大小/固定/隐藏/
 * 随机觉醒）+ 多接待员名册（hosts：每位 = 名字/头像/专属语录/启用）。
 * 独立于规则 store（rules.json）：更新节奏与语义不同——外观是整体替换，
 * 无合并/墓碑；文件损坏按"无偏好"处理（外观退回默认，不阻断装载）。
 * 出厂默认 = 资产版（resolveDefaultAppearance：背景图+五位接待员头像走
 * assets/，台词库在 host-lines.ts，全局摆件偏好烘焙在 DEFAULT_APPEARANCE.host）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Demeanor } from './narrative.js';
import { DEFAULT_HOST_LINES, DEFAULT_HOST_NAMES, DEFAULT_HOST_ORDER } from './host-lines.js';

/** 外观配置形状；version 供未来结构迁移 */
export interface BackgroundConfig {
  enabled: boolean;
  /** 背景 图（data:image/*;base64 数据 URL；空串=未设置） */
  image: string;
  /** 背景透明度 0.05–1（调聊天区画布+侧栏+工具面板同一曲线；越高越透） */
  opacity: number;
  /** 聊天框透明度 0–1（1=气泡/输入卡不透明原样；只调聊天气泡与输入区） */
  chatOpacity: number;
}

/** 接待员全局摆件设置（形象本体在 hosts 名册里） */
export interface HostConfig {
  /** 悬浮球直径 px */
  size: number;
  /** 固定位置：锁定后不可拖拽（防误碰；右键菜单/接待员页可切换） */
  pinned: boolean;
  /** 隐藏接待员：悬浮球不再渲染，但提醒气泡照常弹出（接待员页可恢复） */
  hidden: boolean;
  /** 随机觉醒：true=每个会话从启用的接待员里随机一位（场次内稳定）；false=用 manualHostId */
  rotate: boolean;
  /** 手动指定的接待员 id（rotate=false 时生效；空串/失效时回落首位启用者） */
  manualHostId: string;
}

/** 台词分组固定顺序（校验遍历与 UI 分组展示共用） */
export const LINE_GROUPS: readonly LineGroup[] = ['daily', 'done', 'failed'];

/** 常用语：按台词分组（日常大池/收束/失灵；空数组=该组保持沉默） */
export type LineGroup = 'daily' | 'done' | 'failed';
export type LinesConfig = { [K in LineGroup]: string[] };

/** 一位接待员：迷宫中心的一位觉醒者（形象+专属剧本） */
export interface HostEntry {
  /** 稳定标识（启用/手动指定引用；保持不变便于外部引用） */
  id: string;
  /** 名字（悬浮球提示/接待员卡展示，如 Dolores、Maeve） */
  name: string;
  /** 头像：单个 emoji 字符或 data:image/* 数据 URL */
  avatar: string;
  /** 专属语录：该接待员自己的台词库（daily/done/failed 三组） */
  lines: LinesConfig;
  /** 启用：false=不参与觉醒（下台不删档） */
  enabled: boolean;
}

export interface AppearanceConfig {
  version: 1;
  background: BackgroundConfig;
  host: HostConfig;
  /** 接待员名册（第一位的 hosts[0] 是迁移来源；空名册=客户端回落内置默认形象） */
  hosts: HostEntry[];
  /** 上传过的头像存档池（跨接待员共享，最近的在前；方便换形象时直接取用） */
  avatars: string[];
}

/** 迁移/默认时内建的第一位接待员（id 固定，供 manualHostId 引用） */
export const DEFAULT_HOST_ID = 'dolores';

/**
 * 默认台词（Dolores）：接待员未提供某组台词时回落到她的库。
 * 五位接待员的完整出厂台词库在 host-lines.ts（逐字取自《西部世界》S1-S4，
 * Wikiquote 校对，由 live 配置烘焙生成，不要手改）。
 */
export const DEFAULT_LINES: LinesConfig = DEFAULT_HOST_LINES[DEFAULT_HOST_ID] as LinesConfig;

/** 资产缺失时各接待员的 emoji 回落形象 */
const FALLBACK_EMOJI: Record<string, string> = {
  dolores: '🧚', maeve: '🦋', bernard: '🐼', teddy: '🐱', william: '🦊',
};

/** 名册条目工厂：按 id 取出厂名字与台词库（未知 id 回 Dolores 库） */
function defaultHostEntry(id: string, avatar: string): HostEntry {
  const source = DEFAULT_HOST_LINES[id] ?? DEFAULT_LINES;
  const lines = {} as LinesConfig;
  for (const key of LINE_GROUPS) lines[key] = [...source[key]];
  return { id, name: DEFAULT_HOST_NAMES[id] ?? id, avatar, lines, enabled: true };
}

/**
 * 纯内置默认（资产全缺失时的兜底）：五位出厂接待员（emoji 形象）+
 * 用户偏好烘焙的全局摆件设置（固定位置、指定 Dolores）。
 */
export const DEFAULT_APPEARANCE: AppearanceConfig = {
  version: 1,
  background: { enabled: false, image: '', opacity: 1, chatOpacity: 1 },
  host: { size: 44, pinned: true, hidden: false, rotate: false, manualHostId: DEFAULT_HOST_ID },
  hosts: DEFAULT_HOST_ORDER.map((id) => defaultHostEntry(id, FALLBACK_EMOJI[id] ?? '🧚')),
  avatars: [],
};

/** 随插件发行的默认资产（assets/ 目录固定文件名，均为 webp） */
const ASSET_BACKGROUND = 'default-background.webp';
/** 名册资产统一命名 host-<id>.webp（dolores 亦然，与其他接待员一致） */
const assetNameFor = (id: string): string => `host-${id}.webp`;
/** 发行默认背景的滑杆值（来自用户当前偏好，烘焙进插件作为出厂设置） */
const ASSET_BG_OPACITY = 0.8;
const ASSET_BG_CHAT_OPACITY = 0.35;

/**
 * 资产版出厂默认：把插件 assets/ 里的默认背景/头像读成 data URL 装进默认配置
 * （背景一对资产，名册每位一资产；单资产缺失只影响该位回落 emoji，不 throw——
 * 默认值可降级，不是硬依赖）。读文件走同步（仅装载时调用一次）。
 * @param assetsDir 插件 assets 目录（通常 join(pluginRoot(), 'assets')）
 */
export function resolveDefaultAppearance(assetsDir: string): AppearanceConfig {
  const readAsset = (name: string): string => {
    try {
      return `data:image/webp;base64,${readFileSync(join(assetsDir, name)).toString('base64')}`;
    } catch {
      // 只吞 ENOENT/权限类读失败：资产缺失=退回内置默认，无更多恢复动作可做
      return '';
    }
  };
  const bg = readAsset(ASSET_BACKGROUND);
  return validateAppearance({
    version: 1,
    background: {
      enabled: bg !== '',
      image: bg,
      opacity: bg !== '' ? ASSET_BG_OPACITY : DEFAULT_APPEARANCE.background.opacity,
      chatOpacity: bg !== '' ? ASSET_BG_CHAT_OPACITY : DEFAULT_APPEARANCE.background.chatOpacity,
    },
    hosts: DEFAULT_HOST_ORDER.map((id) => {
      const asset = readAsset(assetNameFor(id));
      return defaultHostEntry(id, asset !== '' ? asset : FALLBACK_EMOJI[id] ?? '🧚');
    }),
  });
}

/** 图片上限：base64 字符数 6M（约 4.5MB 二进制），防止外观文件失控 */
const IMAGE_MAX_CHARS = 6_000_000;
/** 悬浮球直径范围：再小点不中、再大遮挡内容 */
const SIZE_MIN = 36;
const SIZE_MAX = 72;
/** 单条台词长度上限：低语气泡一行内保持可读 */
const LINE_MAX_CHARS = 200;
/** 每神态台词条数上限：台词库不是文集 */
const LINES_PER_GROUP_MAX = 24;
/** 接待员名册上限：再多图库就要分页了 */
const HOSTS_MAX = 8;
/**
 * 图片字段聚合上限（字符数）：单张 IMAGE_MAX_CHARS 之上再限总量，使任何
 * 合法配置都能装进 PUT body 的 8MiB 上限（base64 为 ASCII，字符≈字节）。
 */
const IMAGES_TOTAL_MAX_CHARS = 7_500_000;
/** 头像存档池上限（与 host 单头像上限同一校验规则，池里只放上传过的图） */
const AVATARS_MAX = 12;
/** 接待员名字长度上限 */
const HOST_NAME_MAX_CHARS = 24;
/** 接待员 id 长度上限（自由文本 id，防怪长载荷） */
const HOST_ID_MAX_CHARS = 64;

/** 头像/图片字段统一校验：data URL 或 ≤4 字符 emoji；非法即 throw（field 带字段名） */
function checkAvatar(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${field} 不能为空（emoji 或 data:image/* 数据 URL）`);
  }
  if (!value.startsWith('data:image/')) {
    // 非图片头像只接受短文本（emoji 备选形象；不做严格 emoji 判定——普通短字
    // 符渲染无害，悬浮球只把它当兜底显示，不构成注入面）
    if ([...value].length > 4) throw new Error(`${field} 非 image 时只能是 ≤4 个字符的短文本`);
  } else {
    // MIME 白名单：只收浏览器安全解码的位图格式（svg 等可执行载体拒绝）
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(value)) {
      throw new Error(`${field} 只支持 png/jpeg/webp/gif 数据 URL`);
    }
    if (value.length > IMAGE_MAX_CHARS) {
      throw new Error(`${field} 过大（>${Math.floor(IMAGE_MAX_CHARS / 1_000_000)}M base64），请压缩后再上传`);
    }
  }
  return value;
}

/**
 * 台词库校验：未提供的组回默认（每接待员可只改部分分组），显式空组=沉默，
 * 未知分组 throw。raw 为 undefined 时返回默认克隆。
 * 旧七神态分组自动迁移：idle/waiting/thinking/tool/review 并入 daily，
 * done/failed 原组保留（合并去重，旧配置台词一句不丢）。
 */
const LEGACY_LINE_KEYS: ReadonlySet<string> = new Set([
  'idle', 'waiting', 'thinking', 'tool', 'review', 'done', 'failed',
]);

/** 旧七神态台词对象 → 三组：五组日常并入 daily（保持原组顺序），done/failed 保留 */
function migrateLegacyLines(raw: Record<string, unknown>): Record<string, unknown> {
  if ('daily' in raw) return raw;
  const hasLegacy = Object.keys(raw).some((k) => LEGACY_LINE_KEYS.has(k));
  if (!hasLegacy) return raw;
  const daily: unknown[] = [];
  for (const k of ['idle', 'waiting', 'thinking', 'tool', 'review']) {
    if (Array.isArray(raw[k])) daily.push(...raw[k]);
  }
  const next: Record<string, unknown> = { daily };
  if (Array.isArray(raw.done)) next.done = raw.done;
  if (Array.isArray(raw.failed)) next.failed = raw.failed;
  return next;
}

function validateLines(raw: unknown, field: string): LinesConfig {
  const lines = {} as LinesConfig;
  for (const key of LINE_GROUPS) lines[key] = [...DEFAULT_LINES[key]];
  if (raw === undefined) return lines;
  if (typeof raw !== 'object' || raw === null) throw new Error(`${field} 必须是按台词分组的对象`);
  const input = migrateLegacyLines(raw as Record<string, unknown>);
  const allowed = new Set<string>(LINE_GROUPS);
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw new Error(`${field} 含未知台词分组 "${key}"`);
    if (!Array.isArray(value)) throw new Error(`${field}.${key} 必须为字符串数组`);
    if (value.length > LINES_PER_GROUP_MAX) {
      throw new Error(`${field}.${key} 最多 ${LINES_PER_GROUP_MAX} 条`);
    }
    const entries: string[] = [];
    for (const line of value) {
      if (typeof line !== 'string' || line.trim() === '') {
        throw new Error(`${field}.${key} 的台词必须为非空字符串`);
      }
      if ([...line.trim()].length > LINE_MAX_CHARS) {
        throw new Error(`${field}.${key} 单条台词不能超过 ${LINE_MAX_CHARS} 字`);
      }
      entries.push(line.trim());
    }
    lines[key as LineGroup] = entries;
  }
  return lines;
}

/**
 * 校验并归一外观配置（PUT 路由入口）。违反即 throw，错误信息带字段名。
 * UI 端会先做同款客户端校验，这里仍是权威边界（请求体来自 JSON 反序列化）。
 */
export function validateAppearance(raw: unknown): AppearanceConfig {
  // 数组/标量/null 一律拒绝：静默归一会把这类载荷清空成默认并 200 落盘
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('外观配置必须是对象');
  }
  const input = raw as Record<string, unknown>;
  if (input.background !== undefined
    && (typeof input.background !== 'object' || input.background === null || Array.isArray(input.background))) {
    throw new Error('background 必须是对象');
  }
  if (input.host !== undefined
    && (typeof input.host !== 'object' || input.host === null || Array.isArray(input.host))) {
    throw new Error('host 必须是对象');
  }

  const bg = (typeof input.background === 'object' && input.background !== null ? input.background : {}) as Record<string, unknown>;
  // 类型错误应报错而非静默强转（'' / null 与"未提供"语义不同；enabled 同理见下）
  if (bg.image !== undefined && typeof bg.image !== 'string') {
    throw new Error('background.image 必须是 data:image/* 数据 URL 字符串');
  }
  const image = typeof bg.image === 'string' ? bg.image : '';
  if (image !== '') {
    // 与 checkAvatar 同款 MIME 白名单（位图格式；svg 等可执行载体拒绝）
    if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(image)) {
      throw new Error('background.image 必须是 png/jpeg/webp/gif 数据 URL');
    }
  }
  if (image.length > IMAGE_MAX_CHARS) {
    throw new Error(`background.image 过大（>${Math.floor(IMAGE_MAX_CHARS / 1_000_000)}M base64），请压缩后再上传`);
  }
  if (bg.enabled !== undefined && typeof bg.enabled !== 'boolean') {
    throw new Error('background.enabled 必须为布尔值');
  }
  const opacity = bg.opacity === undefined ? 1 : bg.opacity;
  if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0.05 || opacity > 1) {
    throw new Error('background.opacity 必须为 0.05–1 的数值');
  }
  // 聊天框透明度：老配置缺省视为 1（原样不透明），不影响已存偏好
  const chatOpacity = bg.chatOpacity === undefined ? 1 : bg.chatOpacity;
  // 允许 0：聊天框透明度滑杆 100% 映射为 alpha 0（完全透出背景图）
  if (typeof chatOpacity !== 'number' || !Number.isFinite(chatOpacity) || chatOpacity < 0 || chatOpacity > 1) {
    throw new Error('background.chatOpacity 必须为 0–1 的数值');
  }

  const sp = (typeof input.host === 'object' && input.host !== null ? input.host : {}) as Record<string, unknown>;
  let size: number = DEFAULT_APPEARANCE.host.size;
  if (sp.size !== undefined) {
    if (typeof sp.size !== 'number' || !Number.isInteger(sp.size)) {
      throw new Error(`host.size 必须为 ${SIZE_MIN}–${SIZE_MAX} 的整数（px）`);
    }
    size = sp.size;
  }
  if (size < SIZE_MIN || size > SIZE_MAX) {
    throw new Error(`host.size 必须为 ${SIZE_MIN}–${SIZE_MAX} 的整数（px）`);
  }
  if (typeof sp.pinned !== 'boolean' && sp.pinned !== undefined) {
    throw new Error('host.pinned 必须为布尔值');
  }
  // 未提供时继承 DEFAULT_APPEARANCE.host（出厂偏好烘焙处），不硬编码
  const pinned = sp.pinned === undefined ? DEFAULT_APPEARANCE.host.pinned : sp.pinned === true;
  if (typeof sp.hidden !== 'boolean' && sp.hidden !== undefined) {
    throw new Error('host.hidden 必须为布尔值');
  }
  const hidden = sp.hidden === undefined ? DEFAULT_APPEARANCE.host.hidden : sp.hidden === true;
  if (typeof sp.rotate !== 'boolean' && sp.rotate !== undefined) {
    throw new Error('host.rotate 必须为布尔值');
  }
  const rotate = sp.rotate === undefined ? DEFAULT_APPEARANCE.host.rotate : sp.rotate === true;
  // 手动指定的接待员 id：空串=首位启用者（客户端解析）；非空须为字符串
  // （引用失效不在这里 throw——名册编辑会临时产生悬空引用，客户端回落即可）
  if (sp.manualHostId !== undefined && typeof sp.manualHostId !== 'string') {
    throw new Error('host.manualHostId 必须为字符串（接待员 id 或空串）');
  }
  let manualHostId: string;
  if (typeof sp.manualHostId === 'string' && sp.manualHostId !== '') {
    manualHostId = sp.manualHostId.slice(0, HOST_ID_MAX_CHARS);
  } else if (sp.manualHostId === undefined) {
    manualHostId = DEFAULT_APPEARANCE.host.manualHostId; // 出厂偏好烘焙处
  } else {
    manualHostId = ''; // 显式空串=回落首位启用者
  }

  // 接待员名册：缺省=默认名册（迁移/出厂路径已在外面装配）；逐位校验
  if (input.hosts !== undefined && !Array.isArray(input.hosts)) {
    throw new Error('hosts 必须是接待员数组');
  }
  const rawHosts = (input.hosts ?? DEFAULT_APPEARANCE.hosts) as unknown[];
  if (rawHosts.length > HOSTS_MAX) {
    throw new Error(`接待员名册最多 ${HOSTS_MAX} 位`);
  }
  const hosts: HostEntry[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of rawHosts.entries()) {
    const field = `hosts[${index}]`;
    if (typeof entry !== 'object' || entry === null) throw new Error(`${field} 必须是对象`);
    const rec = entry as Record<string, unknown>;
    if (typeof rec.id !== 'string' || rec.id.trim() === '') throw new Error(`${field}.id 不能为空`);
    const id = rec.id.trim().slice(0, HOST_ID_MAX_CHARS);
    if (seenIds.has(id)) throw new Error(`接待员 id 重复：${id}`);
    seenIds.add(id);
    if (typeof rec.name !== 'string' || rec.name.trim() === '') {
      throw new Error(`${field}.name 不能为空`);
    }
    const name = rec.name.trim();
    if ([...name].length > HOST_NAME_MAX_CHARS) {
      throw new Error(`${field}.name 不能超过 ${HOST_NAME_MAX_CHARS} 字`);
    }
    const avatar = checkAvatar(rec.avatar, `${field}.avatar`);
    const lines = validateLines(rec.lines, `${field}.lines`);
    if (typeof rec.enabled !== 'boolean' && rec.enabled !== undefined) {
      throw new Error(`${field}.enabled 必须为布尔值`);
    }
    hosts.push({ id, name, avatar, lines, enabled: rec.enabled !== false });
  }

  // 头像存档池：跨接待员共享的上传历史；缺省=空池（老配置自然获得）
  if (input.avatars !== undefined && !Array.isArray(input.avatars)) {
    throw new Error('avatars 必须是数组');
  }
  const rawAvatars = (input.avatars ?? []) as unknown[];
  if (rawAvatars.length > AVATARS_MAX) {
    throw new Error(`头像存档最多 ${AVATARS_MAX} 张`);
  }
  const avatars: string[] = [];
  for (const [index, value] of rawAvatars.entries()) {
    avatars.push(checkAvatar(value, `avatars[${index}]`));
  }

  // 聚合图片上限：单张上限之上再限总量，保证合法配置总能装进 PUT body 上限
  // （背景 + 名册头像 + 存档池全部 data URL 计入）
  const imageChars = image.length
    + hosts.reduce((sum, h) => sum + (h.avatar.startsWith('data:') ? h.avatar.length : 0), 0)
    + avatars.reduce((sum, a) => sum + (a.startsWith('data:') ? a.length : 0), 0);
  if (imageChars > IMAGES_TOTAL_MAX_CHARS) {
    throw new Error(`图片总量超过 ${Math.floor(IMAGES_TOTAL_MAX_CHARS / 1_000_000)}M（背景+头像+存档池），请精简后再保存`);
  }

  return {
    version: 1,
    background: { enabled: bg.enabled === true, image, opacity, chatOpacity },
    host: { size, pinned, hidden, rotate, manualHostId },
    hosts,
    avatars,
  };
}

/**
 * 同步读取外观文件；不存在时才求值 fallback（可传工厂避免无谓读资产——
 * 用户文件存在时 resolveDefaultAppearance 完全不执行；缺省退纯内置默认）。
 * 结构损坏 throw（由调用方决定降级）。
 */
export function loadAppearanceSync(
  dataDir: string,
  fallback: AppearanceConfig | (() => AppearanceConfig) = DEFAULT_APPEARANCE,
): AppearanceConfig {
  const file = join(dataDir, 'appearance.json');
  if (!existsSync(file)) return validateAppearance(typeof fallback === 'function' ? fallback() : fallback);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return validateAppearance(raw);
}

/** 原子写入（tmp + rename），避免半写文件在下次装载被当损坏 */
export function saveAppearanceSync(dataDir: string, cfg: AppearanceConfig): void {
  const file = join(dataDir, 'appearance.json');
  const tmp = `${file}.tmp`;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}
