/**
 * 故事线模板 store：data/dsh-maze/narratives.json 的读写与校验。
 *
 * 形状与提醒规则 store 同构（{version, templates, deletedIds}）；损坏由
 * 调用方降级（故事线是软功能，不值得阻断插件装载）。
 * @module dsh-maze/narrative-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { migrateLegacyTemplate, validateNarrativeTemplate, type NarrativeTemplate } from './narratives.js'

/** store 文件形状。 */
export interface NarrativesFile {
  readonly version: 1
  readonly templates: readonly NarrativeTemplate[]
  readonly deletedIds: readonly string[]
  /** 输入框工具行 chip 选中的故事线 id（'' = 未选择）；斜杠命令据此取故事线。 */
  readonly selectedTemplateId: string
}

/** store 路径（与 rules/appearance/runs 同目录）。 */
export function narrativesPathOf(dataDir: string): string {
  return join(dataDir, 'narratives.json')
}

/**
 * 读模板 store；缺文件返回空集，坏形状/坏条目 throw（由调用方降级）。
 * @returns 解析并校验后的 {templates, deletedIds}。
 */
export function loadNarrativesSync(narrativesPath: string): { templates: NarrativeTemplate[]; deletedIds: string[]; selectedTemplateId: string } {
  if (!existsSync(narrativesPath)) return { templates: [], deletedIds: [], selectedTemplateId: '' }
  const parsed: unknown = JSON.parse(readFileSync(narrativesPath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('narratives 文件格式损坏')
  const file = parsed as Record<string, unknown>
  if (!Array.isArray(file.templates)) throw new Error('narratives 文件格式损坏（templates 不是数组）')
  const rawDeleted = file.deletedIds
  if (rawDeleted !== undefined && !Array.isArray(rawDeleted)) throw new Error('narratives 文件格式损坏（deletedIds 不是数组）')
  return {
    templates: file.templates.map(t => {
      try {
        return validateNarrativeTemplate(t)
      } catch (err) {
        // 仅当形状确实是旧版（roles 数组 + kind 字符串）才迁移；否则保留原始校验错误便于诊断
        const r = t as Record<string, unknown> | null
        if (typeof t === 'object' && t !== null && Array.isArray(r?.roles) && typeof r?.kind === 'string') {
          return migrateLegacyTemplate(t)
        }
        throw err
      }
    }),
    deletedIds: (() => {
      if (rawDeleted === undefined) return []
      // 与规则 store 的墓碑语义一致：非字符串条目=文件损坏，交给调用方降级，不让已删模板静默复活
      if (!rawDeleted.every(id => typeof id === 'string')) throw new Error('narratives 文件格式损坏（deletedIds 含非字符串条目）')
      return [...rawDeleted]
    })(),
    // 类型不符按未选择处理（软字段，不值得整体拒绝）
    selectedTemplateId: typeof file.selectedTemplateId === 'string' ? file.selectedTemplateId : '',
  }
}

/** 原子写模板 store（tmp + rename）。 */
export function saveNarrativesSync(narrativesPath: string, templates: readonly NarrativeTemplate[], deletedIds: readonly string[], selectedTemplateId = ''): void {
  mkdirSync(dirname(narrativesPath), { recursive: true })
  const tmp = `${narrativesPath}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: 1, templates, deletedIds, selectedTemplateId } satisfies NarrativesFile, null, 2)}\n`, 'utf8')
  renameSync(tmp, narrativesPath)
}
