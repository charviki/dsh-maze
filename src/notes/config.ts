/**
 * 小记连接配置持久化：<dataDir>/notes-config.json。
 *
 * 为何不入 cordis 配置：baseUrl/token/machineName 是每台机器各异的运行时数据
 * （token 属于机器凭据，不应进可能被分享/提交的 yml），与 reminders store 同级
 * 放 profile 数据目录，由设置页「小记」Tab 编辑。
 * token 以明文落盘：与 rules.json/appearance.json 同信任级（用户自己的本地文件），
 * 生产收紧方案是接入 DSH credentials 管理 token（留待后续）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 小记连接配置形状；后续新增字段一律追加到末尾（遵循"追末尾"约定） */
export interface NotesConfig {
  /** Vikunja 地址（host 或带 /api/v1 均可，实现侧归一） */
  baseUrl: string;
  /** scoped API token（Bearer） */
  token: string;
  /** 本机机器名（= Vikunja 用户名，任务认领键） */
  machineName: string;
  /** Inbox 项目 id（首次连接发现后回写，加速装载） */
  inboxProjectId?: number;
  /** 已知机器名（转任务对话框 datalist；手动积累） */
  machines: string[];
}

/** 空配置（未配置态） */
export function emptyNotesConfig(): NotesConfig {
  return { baseUrl: '', token: '', machineName: '', machines: [] };
}

/** 归一与校验：类型收敛 + 必要字段非空（空 baseUrl/token 视为未配置，由调用方分支） */
export function validateNotesConfig(raw: unknown): NotesConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('小记配置必须是对象');
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const machines = Array.isArray(r.machines)
    ? r.machines.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map(m => m.trim())
    : [];
  const cfg: NotesConfig = {
    // 尾斜杠统一剥除：落盘即规范形（store 侧仍带归一逻辑作防御，二者幂等）
    baseUrl: str(r.baseUrl).replace(/\/+$/, ''),
    token: str(r.token),
    machineName: str(r.machineName),
    ...(typeof r.inboxProjectId === 'number' ? { inboxProjectId: r.inboxProjectId } : {}),
    machines: [...new Set(machines)],
  };
  return cfg;
}

/** 同步读；文件缺失=空配置，结构损坏 throw（调用方降级为未配置并告警） */
export function loadNotesConfigSync(dataDir: string): NotesConfig {
  const file = join(dataDir, 'notes-config.json');
  if (!existsSync(file)) return emptyNotesConfig();
  return validateNotesConfig(JSON.parse(readFileSync(file, 'utf8')));
}

/** 原子写（tmp + rename），与 rules.json 同策略 */
export function saveNotesConfigSync(dataDir: string, cfg: NotesConfig): void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'notes-config.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}
