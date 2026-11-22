/**
 * 配置云端同步（WebDAV）：把提醒规则 store、外观配置、故事线模板打包成
 * 单个 JSON 文档上传/下载。跨机器迁移配置用，替代手工拷数据文件。
 *
 * 首版为手动同步（设置页按钮）：上传=本机三份文件 → 云端一份；下载=云端
 * 一份 → 校验后经运行时同款出口应用（热生效）。冲突策略 last-write-wins：
 * 下载前 UI 先 peek 云端摘要，由用户确认覆盖。
 *
 * 连接信息（含 WebDAV 应用密码）以 0600 权限明文存放在插件数据目录的
 * sync.json——与 .env/多数 CLI 同一威胁模型；密码用坚果云「应用密码」等
 * 可单独吊销的凭据，不用主账号密码。
 */

/** WebDAV 连接配置（server+remotePath 唯一确定远端文档地址） */
export interface SyncConnection {
  server: string;
  username: string;
  password: string;
  remotePath: string;
}

/**
 * 同步包：一份完整配置快照。section 为 null 表示上传机器上没有该项
 * （如从未编辑过故事线），下载时跳过该项不覆盖本地。
 */
export interface SyncBundle {
  kind: 'dsh-maze-config';
  version: 1;
  /** 上传时刻（epoch ms），peek 摘要与 last-write-wins 判断的依据 */
  uploadedAt: number;
  /** 上传机器标识（hostname），仅用于摘要展示"这是哪台机器传的" */
  machine: string;
  /** 提醒规则 store 形状：{version:1, rules:[], deletedIds:[]} */
  rules: unknown | null;
  /** 外观配置 AppearanceConfig */
  appearance: unknown | null;
  /** 故事线 store 形状：{templates:[], deletedIds:[], selectedTemplateId:''} */
  narratives: unknown | null;
}

/** peek 返回的用户可读摘要（不含提示词等大字段） */
export interface SyncSummary {
  uploadedAt: number;
  machine: string;
  rules: { id: string; name: string; trigger: string }[];
  ruleDeletedCount: number;
  appearance: { hasBackground: boolean; backgroundEnabled: boolean; hostCount: number } | null;
  narratives: { templates: { id: string; name: string }[]; selectedTemplateId: string } | null;
}

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SYNC_FILE = 'sync.json';

/**
 * 校验并归一连接配置：server 必须是 http(s) URL、账号密码非空、
 * remotePath 以 / 开头。全部字段 trim（密码 trim 掉手滑的首尾空格）。
 */
export function validateSyncConnection(raw: unknown): SyncConnection {
  if (typeof raw !== 'object' || raw === null) throw new Error('同步连接配置必须是对象');
  const r = raw as Record<string, unknown>;
  const server = typeof r.server === 'string' ? r.server.trim().replace(/\/+$/, '') : '';
  const username = typeof r.username === 'string' ? r.username.trim() : '';
  const password = typeof r.password === 'string' ? r.password.trim() : '';
  let remotePath = typeof r.remotePath === 'string' ? r.remotePath.trim() : '';
  if (remotePath === '') remotePath = '/dsh-maze/config.json';
  if (!/^https?:\/\/.+/.test(server)) throw new Error('服务器地址必须是 http(s) URL，如 https://dav.jianguoyun.com/dav/');
  if (username === '') throw new Error('用户名不能为空');
  if (password === '') throw new Error('应用密码不能为空');
  if (!remotePath.startsWith('/')) throw new Error('远程路径必须以 / 开头');
  return { server, username, password, remotePath };
}

/** 读取连接配置；未配置返回 null；文件损坏向上抛（由路由转 500 提示重填） */
export function loadSyncConnection(dataDir: string): SyncConnection | null {
  const file = join(dataDir, SYNC_FILE);
  if (!existsSync(file)) return null;
  return validateSyncConnection(JSON.parse(readFileSync(file, 'utf8')));
}

/** 保存连接配置：原子写（tmp+rename）+ 0600（含应用密码，只限当前用户可读） */
export function saveSyncConnection(dataDir: string, conn: SyncConnection): void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, SYNC_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(conn, null, 2) + '\n', 'utf8');
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** 校验同步包形状（只做外壳门禁；各 section 的内容校验在应用前做） */
export function validateSyncBundle(raw: unknown): SyncBundle {
  if (typeof raw !== 'object' || raw === null) throw new Error('同步包必须是对象');
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'dsh-maze-config') throw new Error('不是 dsh-maze 配置包（kind 不符）');
  if (r.version !== 1) throw new Error(`不支持的配置包版本: ${String(r.version)}`);
  if (typeof r.uploadedAt !== 'number' || !Number.isFinite(r.uploadedAt)) throw new Error('配置包缺少有效的 uploadedAt');
  if (typeof r.machine !== 'string') throw new Error('配置包缺少 machine 标识');
  for (const key of ['rules', 'appearance', 'narratives'] as const) {
    const v = r[key];
    if (v !== null && typeof v !== 'object') throw new Error(`配置包 ${key} 段必须是对象或 null`);
  }
  return {
    kind: 'dsh-maze-config',
    version: 1,
    uploadedAt: r.uploadedAt,
    machine: r.machine,
    rules: r.rules ?? null,
    appearance: r.appearance ?? null,
    narratives: r.narratives ?? null,
  };
}

/**
 * 从同步包提取用户可读摘要（peek 用）：规则名列表/外观要点/故事线名列表，
 * 不带提示词与大字段，UI 确认覆盖前看这个。
 */
export function summarizeBundle(bundle: SyncBundle): SyncSummary {
  const rules = bundle.rules as { rules?: unknown[]; deletedIds?: unknown[] } | null;
  const ruleList = Array.isArray(rules?.rules) ? rules!.rules! : [];
  const appearance = bundle.appearance as {
    background?: { image?: string; enabled?: boolean };
    hosts?: unknown[];
  } | null;
  const narratives = bundle.narratives as {
    templates?: { id?: unknown; name?: unknown }[];
    selectedTemplateId?: unknown;
  } | null;
  return {
    uploadedAt: bundle.uploadedAt,
    machine: bundle.machine,
    // 条目防御式读取：云端文档只过了外壳门禁，数组里混进 null/标量不该炸 peek
    rules: ruleList.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { id: String(o.id ?? ''), name: String(o.name ?? o.id ?? ''), trigger: String(o.trigger ?? '') };
    }),
    ruleDeletedCount: Array.isArray(rules?.deletedIds) ? rules!.deletedIds!.length : 0,
    appearance: appearance === null ? null : {
      hasBackground: typeof appearance.background?.image === 'string' && appearance.background.image !== '',
      backgroundEnabled: appearance.background?.enabled === true,
      hostCount: Array.isArray(appearance.hosts) ? appearance.hosts.length : 0,
    },
    narratives: narratives === null ? null : {
      templates: (Array.isArray(narratives.templates) ? narratives.templates : []).map((t) => ({
        id: String(t?.id ?? ''),
        name: String(t?.name ?? t?.id ?? ''),
      })),
      selectedTemplateId: typeof narratives.selectedTemplateId === 'string' ? narratives.selectedTemplateId : '',
    },
  };
}

/** 远端文档完整 URL（server 已去尾斜杠、remotePath 已保头斜杠，直接拼接） */
export function davUrl(conn: SyncConnection): string {
  return `${conn.server}${conn.remotePath}`;
}

/**
 * 逐级创建 remotePath 的父目录（MKCOL）。坚果云等服务器在父集合不存在时
 * PUT 返回 409，先建目录再重试。逐级（非仅最后一级）是为任意深度路径；
 * 201=已建、405=已存在、200/301 也视为成功，其余状态返回 false 由调用方决定。
 */
export async function ensureDavParents(conn: SyncConnection): Promise<boolean> {
  const segs = conn.remotePath.split('/').filter(s => s !== '');
  // 去掉最后一段（那是文档本身，不是目录）
  segs.pop();
  let ok = true;
  for (let i = 0; i < segs.length; i++) {
    const path = `/${segs.slice(0, i + 1).join('/')}/`;
    const res = await davRequest({ ...conn, remotePath: path }, 'MKCOL');
    if (res.status !== 201 && res.status !== 405 && res.status !== 200 && res.status !== 301) ok = false;
  }
  return ok;
}

/**
 * 单次 WebDAV 请求（GET/PUT/MKCOL）。网络层错误（DNS/超时/TLS）向上抛带原因的
 * Error；HTTP 状态由调用方解释（404=云端为空，2xx=成功，其余=远端拒绝）。
 */
export async function davRequest(
  conn: SyncConnection,
  method: 'GET' | 'PUT' | 'MKCOL',
  body?: string,
): Promise<{ status: number; text: string }> {
  const auth = Buffer.from(`${conn.username}:${conn.password}`, 'utf8').toString('base64');
  let res: Response;
  try {
    res = await fetch(davUrl(conn), {
      method,
      headers: {
        authorization: `Basic ${auth}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`WebDAV 连接失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { status: res.status, text: await res.text() };
}
