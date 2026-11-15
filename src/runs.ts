/**
 * 故事线场次（runs）：把 workflow 工具调用投影为一条条运行记录。
 *
 * 纯投影 + 持久化分离：projectSessionEvent 只做归约（可单测），
 * index.ts 负责 监听/落盘/SSE 广播。场次按会话归属，历史全局留最近 20 场。
 * @module dsh-maze/runs
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 一场运行（一次 workflow 工具调用）。 */
export interface RunRecord {
  /** 工具调用 id（tool/call 的 callId）。 */
  readonly id: string
  readonly templateId: string
  readonly templateName: string
  readonly sessionId: string
  readonly startedAt: number
  readonly endedAt?: number
  /** 收束 / 失灵；未结束的场次缺省。 */
  readonly verdict?: 'done' | 'failed'
  /** tool/result 的错误名（失灵时记录）。 */
  readonly errorName?: string
}

/** 场次历史容量（最近的运行留档）。 */
export const RUNS_MAX = 20

/** 会话事件的最小视图（投影只关心这几个字段）。 */
export interface SessionEventLike {
  readonly type: string
  /** 原始事件时间戳（归约用显式 now，不依赖此字段）。 */
  readonly time?: unknown
  readonly data: unknown
}

/** 从 workflow 工具参数里提取故事线名。只认 meta.name/phase 标题约定里的《名字》——
 * 启程消息的环提示等文本也含《…》字样，裸抓第一个会把轨迹挂到错的故事线上。 */
export function extractTemplateName(argumentsText: string): string | undefined {
  // meta.name / workflow name 字段，或 phase('《名》· 环名') 标题——两种承载都认；
  // \b 锚定防止误配 filename/xname 等以 name 结尾的键
  const meta = /\bname\\?["']?\s*[:=]\s*\\?["']《([^《》]{1,24})》/u.exec(argumentsText)
  if (meta !== null) return meta[1]
  const phase = /phase\(\s*\\?["']《([^《》]{1,24})》/u.exec(argumentsText)
  if (phase !== null) return phase[1]
  return undefined
}

/** 会话事件里的工具载荷守卫（防御式：坏形状按无关事件处理）。 */
function toolCallData(data: unknown): { callId: string; name: string; arguments: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (typeof d.callId !== 'string' || typeof d.name !== 'string') return undefined
  return { callId: d.callId, name: d.name, arguments: typeof d.arguments === 'string' ? d.arguments : '' }
}

function toolResultData(data: unknown): { callId: string; errorName?: string; failed: boolean } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  const message = d.message
  if (typeof message !== 'object' || message === null) return undefined
  const m = message as Record<string, unknown>
  // 安装版（0.2.2-rc.1）实测载荷是 toolCallId + isError 布尔；repo HEAD 类型声明是 callId + data.error。
  // 两个形状都认：读侧兼容优于单点假设（callId 分支同时喂给单测的 repo 形状用例）。
  const callId = typeof m.toolCallId === 'string'
    ? m.toolCallId
    : typeof m.callId === 'string' ? m.callId : undefined
  if (callId === undefined) return undefined
  const error = d.error
  const errorName = typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>).name === 'string'
    ? (error as Record<string, unknown>).name as string
    : m.isError === true ? 'error' : undefined
  return { callId, errorName, failed: m.isError === true || (error !== undefined && error !== null) }
}

/**
 * 归约一条会话事件到场次历史（纯函数）。
 * @param runs - 当前历史（新→旧）。
 * @param sessionId - 事件所属会话。
 * @param event - 会话事件。
 * @param now - 当前毫秒时钟。
 * @returns 更新后的历史；无变化时原样返回（调用方按引用判等省一次落盘）。
 */
export function projectSessionEvent(
  runs: readonly RunRecord[],
  sessionId: string,
  event: SessionEventLike,
  now: number,
  resolveTemplateId?: (templateName: string) => string,
): readonly RunRecord[] {
  if (event.type === 'tool/call') {
    const call = toolCallData(event.data)
    if (call === undefined || call.name !== 'workflow') return runs
    // 同 callId 重复投影幂等（重放/修复日志时不会翻倍）
    if (runs.some(run => run.id === call.callId)) return runs
    const templateName = extractTemplateName(call.arguments)
    // 无《》标记的 workflow 调用不是故事线运行：跳过（防用户手跑/其他编排混进轨迹）
    if (templateName === undefined) return runs
    const record: RunRecord = {
      id: call.callId,
      // 场次要回指故事线（续场/编辑用）：投影纯函数不自持模板表，由调用方
      // 注入解析器（名字 → id，查无回落空串）
      templateId: resolveTemplateId?.(templateName) ?? '',
      templateName,
      sessionId,
      startedAt: now,
    }
    return [record, ...runs].slice(0, RUNS_MAX)
  }
  if (event.type === 'tool/result') {
    const result = toolResultData(event.data)
    if (result === undefined) return runs
    const index = runs.findIndex(run => run.id === result.callId && run.endedAt === undefined)
    if (index < 0) return runs
    const closed: RunRecord = {
      ...runs[index],
      endedAt: now,
      verdict: result.failed ? 'failed' : 'done',
      ...(result.failed ? { errorName: result.errorName ?? 'error' } : {}),
    }
    const next = [...runs]
    next[index] = closed
    return next
  }
  return runs
}

/** store 文件形状。 */
export interface RunsFile {
  readonly version: 1
  readonly runs: readonly RunRecord[]
}

/**
 * 关闭仍处进行中的场次：应用重启后旧 workflow 调用永不回归结果，
 * 留着只会永远显示「进行中」。在装载时调用，把无主的开放场次标记为
 * interrupted（呈现为出岔）。
 * @param runs - 装载出的历史场次。
 * @param now - 关闭时刻（毫秒）。
 * @returns 关闭后的新数组；无开放场次时原样返回（引用相等，便于跳过落盘）。
 */
export function closeStaleRuns(runs: readonly RunRecord[], now: number): readonly RunRecord[] {
  if (!runs.some(r => r.endedAt === undefined)) return runs
  return runs.map(r => (r.endedAt === undefined
    ? { ...r, endedAt: now, verdict: 'failed' as const, errorName: 'interrupted' }
    : r))
}

/** 读场次历史；缺文件返回空，损坏由调用方降级。 */
export function loadRunsSync(runsPath: string): readonly RunRecord[] {
  if (!existsSync(runsPath)) return []
  const parsed: unknown = JSON.parse(readFileSync(runsPath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('runs 文件格式损坏')
  const runs = (parsed as Record<string, unknown>).runs
  if (!Array.isArray(runs)) throw new Error('runs 文件格式损坏（runs 不是数组）')
  // 只校验会返回的最近 RUNS_MAX 场：窗口外的旧坏条目不影响可用历史（坏条目整体 throw，由调用方降级）
  const kept = runs.slice(0, RUNS_MAX) as readonly RunRecord[]
  for (const run of kept) {
    if (typeof run !== 'object' || run === null || Array.isArray(run)) {
      throw new Error('runs 文件格式损坏（存在非法场次条目）')
    }
    const rec = run as unknown as Record<string, unknown>
    if (typeof rec.id !== 'string'
      || typeof rec.templateId !== 'string'
      || typeof rec.templateName !== 'string'
      || typeof rec.sessionId !== 'string'
      || typeof rec.startedAt !== 'number'
      || (rec.endedAt !== undefined && typeof rec.endedAt !== 'number')
      || (rec.verdict !== undefined && rec.verdict !== 'done' && rec.verdict !== 'failed')
      || (rec.errorName !== undefined && typeof rec.errorName !== 'string')) {
      throw new Error('runs 文件格式损坏（存在非法场次条目）')
    }
  }
  return kept
}

/** 原子写场次历史（tmp + rename）。 */
export function saveRunsSync(runsPath: string, runs: readonly RunRecord[]): void {
  mkdirSync(dirname(runsPath), { recursive: true })
  const tmp = `${runsPath}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, runs } satisfies RunsFile, null, 2)}\n`, 'utf8')
  renameSync(tmp, runsPath)
}

/** 场次 store 路径（与 rules/appearance 同目录）。 */
export function runsPathOf(dataDir: string): string {
  return join(dataDir, 'runs.json')
}
