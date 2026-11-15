/**
 * 故事线生成：把环序模板 + 目标合成发给主会话的紧凑「启程」消息。
 *
 * 模型只需要任务规格，不需要理解西部世界概念（那是配置层的语言）：
 * 所有数字（拆解上限、并行数、回溯轮数）由生成器预计算写死，模型
 * 零算术；「子任务」是唯一的结构词。固定流程：第 0 环（拆解）在当前
 * 会话执行——基石 + 子任务清单，停下等确认；确认后从第 1 环起按骨架
 * 执行 workflow；单环故事线不启编排（清单即交付）。
 * @module dsh-maze/narrative-script
 */
import { type NarrativeHost, type NarrativeTemplate } from './narratives.js';
/** 接待员名册的最小视图（compose 只需要 id → 显示名）。 */
export interface HostNameLookUp {
    (hostId: string): string | undefined;
}
/** 接待员调用描述：生成 agent() 覆盖参数的依据（agent/model 空串=不覆盖）。 */
export interface HostCallSpec {
    readonly provider?: string;
    readonly model?: string;
    readonly label: string;
}
/** 环接待员的调用描述（hostName 仅用于展示）。 */
export interface HostBucket {
    readonly host: NarrativeHost;
    readonly hostName: string;
    readonly spec: HostCallSpec;
}
/** agent 调用覆盖的脚本片段（空配置=省略，继承环境默认；值经 JSON 转义）。 */
export declare function agentOptsLiteral(spec: HostCallSpec): string;
/**
 * 合成启程消息（紧凑规格）：目标一行 + 第一步（当前会话：基石+拆解，等确认）
 * + 执行环节列表 + 骨架代码块。单环故事线只有第一步，不启编排。
 * @param tpl - 环序模板。
 * @param hostOf - 接待员名册查找。
 * @param goal - 用户目标（''=纯从对话总结）；只是基石的种子，不跳过确认。
 * @returns 完整启程消息文本。
 */
export declare function composeNarrativeMessage(tpl: NarrativeTemplate, hostOf: HostNameLookUp, goal: string): string;
/**
 * 脚本骨架（多环故事线）：从第 1 环起每环一段——工作环 pipeline、质检环
 * verdicts+退回循环、末环收束；接待员覆盖参数按接待员表生成（多接待员轮转）。
 * 单环故事线返回空串（不启编排）。
 * @param tpl - 环序模板。
 * @param hostOf - 接待员名册查找。
 */
export declare function buildScriptSkeleton(tpl: NarrativeTemplate, hostOf: HostNameLookUp): string;
