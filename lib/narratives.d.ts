/**
 * 故事线（Narratives）模板模型与校验。
 *
 * 模板是一条由环（layer）组成的路径：每环同构（环名 + 共用提示词 +
 * 接待员表 + 并行数 + 可选回溯），职责由位置决定——首环（当前会话）
 * 拆解子任务、中间环逐子任务处理（带回溯的环即质检环：fail 打回
 * 更早的环重做）、末环
 * 收束、单环直通。存储语义与提醒规则一致：内置模板为基底，store
 * 同 id 覆盖，墓碑记录删除。
 * @module dsh-maze/narratives
 */
/** 一名接待员：执行路由配置（agent/model 空串 = 跟随环境默认）。 */
export interface NarrativeHost {
    readonly hostId: string;
    /** 执行路由：'' = dsh 标准子代理；其余为环境里可用的路由名（如 codex）。 */
    readonly agent: string;
    /** 模型：'' = 不指定（继承环境默认模型）；填具体模型 id 只对该接待员生效。 */
    readonly model: string;
    /** 并行数：该接待员本环内最多同时处理几个子任务（1–8）。 */
    readonly parallel: number;
}
/** 回溯配置：本环判定 fail 的子任务打回此前某环重做（带 issues）。 */
export interface NarrativeRetry {
    /** 回溯目标环 id（必须是更早的环）。 */
    readonly toLayerId: string;
    /** 最多回溯轮数（1–3）。 */
    readonly maxRounds: number;
}
/** 一环：环名 + 共用提示词 + 接待员表；任何非首环可带回溯（= 质检环）。 */
export interface NarrativeLayer {
    readonly id: string;
    /** 环名（用户自定义显示名，如「拆解」「实现」）。 */
    readonly name: string;
    /** 本环共用提示词（环内所有接待员共享，随子任务一起下发）。 */
    readonly prompt: string;
    readonly hosts: readonly NarrativeHost[];
    /** 非首环可配；按子任务 pass/fail 打回重做，映射不到子任务时整环兜底。 */
    readonly retry?: NarrativeRetry;
}
/** 一条故事线模板：环序 + 全局文案。 */
export interface NarrativeTemplate {
    readonly id: string;
    readonly name: string;
    readonly goalHint: string;
    readonly layers: readonly NarrativeLayer[];
    /** 内置模板标记：允许编辑与删除（store 覆盖/墓碑），仅作 UI 标识。 */
    readonly builtin?: boolean;
    /** 第一步是否拆分子任务（默认 true）。false = 只明确任务、整体作为单个任务执行（评审类场景）。 */
    readonly decompose?: boolean;
}
/** 名册容量上限（与接待员名册一致，防误建一堆）。 */
export declare const NARRATIVES_MAX = 12;
/** 内置模板：出厂基底（用户可改接待员与环配置，store 同 id 覆盖）。 */
export declare const BUILTIN_TEMPLATES: readonly NarrativeTemplate[];
/**
 * 校验一条模板的原始输入（HTTP PUT 或 store 文件），非法即 throw。
 * 结构约束：至少一环；回溯只出现在非首环且目标必须是更早的环。
 * 环职责由位置决定（首环=当前会话拆解 / 末环收束 / 带回溯 = 质检），无类型字段。
 * @param raw - 任意来源的原始对象。
 * @returns 通过校验的模板（缺省字段已补齐；未知字段如旧版 kind 自然剥离）。
 */
export declare function validateNarrativeTemplate(raw: unknown): NarrativeTemplate;
/**
 * 旧版（v0.0.5 早期 roles 形状）store 条目 → 统一环模型迁移。
 * 环序按旧 kind 重建，旧角色表（roles）映射到对应环的接待员表；无法识别的形状 throw
 * （由调用方丢弃该条并降级）。另：v0.0.5 中期带 kind 的环序条目无需此
 * 迁移——validate 构造时自然剥离未知字段。
 * @param raw - store 里的旧模板对象。
 */
export declare function migrateLegacyTemplate(raw: unknown): NarrativeTemplate;
/**
 * 合并三层来源：config（YAML）为基底，store 覆盖同 id，墓碑跳过。
 * 超出 NARRATIVES_MAX 即 throw（静默截断会让模板不可见也不可管）。
 * @param configRules - 配置文件声明的模板。
 * @param storeRules - store 文件里的运行时编辑。
 * @param deletedIds - 墓碑（内置/config 来源被删时防复活）。
 * @returns 合并视图（store 未覆盖的内置/config 在前，store 附加在后）。
 */
export declare function mergeNarratives(configRules: readonly unknown[], storeRules: readonly NarrativeTemplate[], deletedIds: ReadonlySet<string>): NarrativeTemplate[];
/** 内置故事线 id 集（视图据此标注 内置/已定制 徽标）——由内置清单派生，新增内置条目自动跟进。 */
export declare const BUILTIN_TEMPLATE_IDS: readonly string[];
/** 故事线集版本指纹：模板全量语义（含提示词）+ 选中态。
 *  SSE 广播帧剥离提示词后靠它让客户端发现「模板变了，该重新拉全文」。 */
export declare function storylinesVersion(templates: readonly NarrativeTemplate[], selectedTemplateId: string): string;
/** 装载期三源软去重结果：消化掉可预见的名字/id 冲突与超量，兜底 merge 只剩真正意外的情况。 */
export interface AssembledNarratives {
    /** 过滤后的 config 条目（无冲突、容量内）。 */
    config: readonly NarrativeTemplate[];
    /** 过滤后的 store 条目（无冲突）。 */
    store: readonly NarrativeTemplate[];
}
/** 装载期三源（内置/config/store）软去重与容量收敛（纯函数，诊断经 warn 回调外泄）。
 *  冲突条目只丢该条并 warn——不让一条重名配置把用户声明的全部模板拖进兜底清空；
 *  容量按合并基底（内置 ∪ config，按 id 去重）计：覆盖内置的条目不占新增额度，
 *  超量按 config 声明顺序保留能装下的（故事线是软功能，超量不炸装载）。 */
export declare function assembleNarrativeTemplates(builtin: readonly NarrativeTemplate[], config: readonly NarrativeTemplate[], store: readonly NarrativeTemplate[], opts: {
    max: number;
    warn: (message: string) => void;
}): AssembledNarratives;
