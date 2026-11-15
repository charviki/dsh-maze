/**
 * 故事线模板 store：data/dsh-maze/narratives.json 的读写与校验。
 *
 * 形状与提醒规则 store 同构（{version, templates, deletedIds}）；损坏由
 * 调用方降级（故事线是软功能，不值得阻断插件装载）。
 * @module dsh-maze/narrative-store
 */
import { type NarrativeTemplate } from './narratives.js';
/** store 文件形状。 */
export interface NarrativesFile {
    readonly version: 1;
    readonly templates: readonly NarrativeTemplate[];
    readonly deletedIds: readonly string[];
    /** 输入框工具行 chip 选中的故事线 id（'' = 未选择）；斜杠命令据此取故事线。 */
    readonly selectedTemplateId: string;
}
/** store 路径（与 rules/appearance/runs 同目录）。 */
export declare function narrativesPathOf(dataDir: string): string;
/**
 * 读模板 store；缺文件返回空集，坏形状/坏条目 throw（由调用方降级）。
 * @returns 解析并校验后的 {templates, deletedIds}。
 */
export declare function loadNarrativesSync(narrativesPath: string): {
    templates: NarrativeTemplate[];
    deletedIds: string[];
    selectedTemplateId: string;
};
/** 原子写模板 store（tmp + rename）。 */
export declare function saveNarrativesSync(narrativesPath: string, templates: readonly NarrativeTemplate[], deletedIds: readonly string[], selectedTemplateId?: string): void;
