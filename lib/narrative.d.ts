/**
 * 叙事引擎（纯函数，无副作用）：
 * 把宿主可观察的会话事件投影为 Dolores 的神态（demeanor），
 * 供客户端微动效与台词消费——就像园区叙事部（Narrative Dept.）
 * 为接待员编排的每一幕水面行为。
 * 事件源（桌面 0.2.2-rc.1 实测存在，见 README 机制图）：
 * - llm/stream waterfall（模型调用开始）
 * - session/event 会话事件流（turn/tool/compaction 等）
 */
/** Dolores 的七种神态（客户端按此渲染动效与贴纸） */
export type Demeanor = 'idle' | 'waiting' | 'thinking' | 'tool' | 'review' | 'done' | 'failed';
/** 最近一次神态记录（宿主内存态） */
export interface DemeanorRecord {
    demeanor: Demeanor;
    /** 事件时间戳（ms） */
    at: number;
}
/** done/failed 是瞬态演出：超过该时长应视为回到待机 */
export declare const TRANSIENT_MS = 8000;
/** 非瞬态神态的过期时间：太久没有事件（会话挂起/断流）回到待机 */
export declare const STALE_MS = 90000;
/**
 * 会话事件 → 神态映射；无关联事件返回 undefined（不更新）。
 * @param eventType session/event 的 event.type
 * @param reasonKind turn/end 专用的 data.reason.kind（可选）
 */
export declare function narrativeEventToDemeanor(eventType: string, reasonKind?: string): Demeanor | undefined;
/**
 * 计算当前应展示的神态（含瞬态衰减与过期回退）。
 * @param record 最近一次神态记录；undefined 表示叙事尚未开始
 * @param now 当前时间戳（ms）
 */
export declare function currentDemeanor(record: DemeanorRecord | undefined, now: number): Demeanor;
/** 挑选某会话的神态记录：会话已知时只看它自己的桶——没有桶 = undefined
 *  （客户端兜底 idle），绝不回退到别的会话的记录（后台会话跑任务时，正在
 *  查看的静止会话不能被污染成后台神态）。仅会话 id 缺失（旧运行时拿不到
 *  useSessions）时才回退全局最近活跃，保持单会话体验不变。
 *  @param bySession 各会话的神态桶
 *  @param sessionId 当前查看的会话 id；undefined=未知
 */
export declare function pickDemeanorRecord(bySession: ReadonlyMap<string, DemeanorRecord>, sessionId: string | undefined): DemeanorRecord | undefined;
