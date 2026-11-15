/**
 * 故事线场次（runs）：把 workflow 工具调用投影为一条条运行记录。
 *
 * 纯投影 + 持久化分离：projectSessionEvent 只做归约（可单测），
 * index.ts 负责 监听/落盘/SSE 广播。场次按会话归属，历史全局留最近 20 场。
 * @module dsh-maze/runs
 */
/** 一场运行（一次 workflow 工具调用）。 */
export interface RunRecord {
    /** 工具调用 id（tool/call 的 callId）。 */
    readonly id: string;
    readonly templateId: string;
    readonly templateName: string;
    readonly sessionId: string;
    readonly startedAt: number;
    readonly endedAt?: number;
    /** 收束 / 失灵；未结束的场次缺省。 */
    readonly verdict?: 'done' | 'failed';
    /** tool/result 的错误名（失灵时记录）。 */
    readonly errorName?: string;
}
/** 场次历史容量（最近的运行留档）。 */
export declare const RUNS_MAX = 20;
/** 会话事件的最小视图（投影只关心这几个字段）。 */
export interface SessionEventLike {
    readonly type: string;
    /** 原始事件时间戳（归约用显式 now，不依赖此字段）。 */
    readonly time?: unknown;
    readonly data: unknown;
}
/** 从 workflow 工具参数里提取故事线名。只认 meta.name/phase 标题约定里的《名字》——
 * 启程消息的环提示等文本也含《…》字样，裸抓第一个会把轨迹挂到错的故事线上。 */
export declare function extractTemplateName(argumentsText: string): string | undefined;
/**
 * 归约一条会话事件到场次历史（纯函数）。
 * @param runs - 当前历史（新→旧）。
 * @param sessionId - 事件所属会话。
 * @param event - 会话事件。
 * @param now - 当前毫秒时钟。
 * @returns 更新后的历史；无变化时原样返回（调用方按引用判等省一次落盘）。
 */
export declare function projectSessionEvent(runs: readonly RunRecord[], sessionId: string, event: SessionEventLike, now: number, resolveTemplateId?: (templateName: string) => string): readonly RunRecord[];
/** store 文件形状。 */
export interface RunsFile {
    readonly version: 1;
    readonly runs: readonly RunRecord[];
}
/**
 * 关闭仍处进行中的场次：应用重启后旧 workflow 调用永不回归结果，
 * 留着只会永远显示「进行中」。在装载时调用，把无主的开放场次标记为
 * interrupted（呈现为出岔）。
 * @param runs - 装载出的历史场次。
 * @param now - 关闭时刻（毫秒）。
 * @returns 关闭后的新数组；无开放场次时原样返回（引用相等，便于跳过落盘）。
 */
export declare function closeStaleRuns(runs: readonly RunRecord[], now: number): readonly RunRecord[];
/** 读场次历史；缺文件返回空，损坏由调用方降级。 */
export declare function loadRunsSync(runsPath: string): readonly RunRecord[];
/** 原子写场次历史（tmp + rename）。 */
export declare function saveRunsSync(runsPath: string, runs: readonly RunRecord[]): void;
/** 场次 store 路径（与 rules/appearance 同目录）。 */
export declare function runsPathOf(dataDir: string): string;
