/**
 * 叙事引擎（纯函数，无副作用）：
 * 把宿主可观察的会话事件投影为 Dolores 的神态（demeanor），
 * 供客户端微动效与台词消费——就像园区叙事部（Narrative Dept.）
 * 为接待员编排的每一幕水面行为。
 * 事件源（桌面 0.2.2-rc.1 实测存在，见 README 机制图）：
 * - llm/stream waterfall（模型调用开始）
 * - session/event 会话事件流（turn/tool/compaction 等）
 */
/** done/failed 是瞬态演出：超过该时长应视为回到待机 */
export const TRANSIENT_MS = 8_000;
/** 非瞬态神态的过期时间：太久没有事件（会话挂起/断流）回到待机 */
export const STALE_MS = 90_000;
/**
 * 会话事件 → 神态映射；无关联事件返回 undefined（不更新）。
 * @param eventType session/event 的 event.type
 * @param reasonKind turn/end 专用的 data.reason.kind（可选）
 */
export function narrativeEventToDemeanor(eventType, reasonKind) {
    switch (eventType) {
        case 'turn/start':
            return 'waiting';
        case 'assistant/attempt':
            // 模型调用尝试与 llm/stream 同义；两条路都通向 thinking
            return 'thinking';
        case 'tool/call':
            return 'tool';
        case 'tool/result':
            // 工具结束回到生成节奏（下一步往往是叙事继续书写）
            return 'thinking';
        case 'compaction/start':
        case 'compaction/end':
            // 上下文整理 = 她在审阅自己的记忆碎片
            return 'review';
        case 'llm/retry':
            // 调用失败重试：闪一次失灵演出
            return 'failed';
        case 'turn/end':
            if (reasonKind === 'completed')
                return 'done';
            if (reasonKind === 'blocked' || reasonKind === 'aborted')
                return 'idle';
            // 其余收场原因（错误等）按失灵处理
            return 'failed';
        default:
            return undefined;
    }
}
/**
 * 计算当前应展示的神态（含瞬态衰减与过期回退）。
 * @param record 最近一次神态记录；undefined 表示叙事尚未开始
 * @param now 当前时间戳（ms）
 */
export function currentDemeanor(record, now) {
    if (record === undefined)
        return 'idle';
    const age = now - record.at;
    if (age < 0)
        return record.demeanor; // 时钟回拨：保守沿用
    if ((record.demeanor === 'done' || record.demeanor === 'failed') && age > TRANSIENT_MS)
        return 'idle';
    if (age > STALE_MS)
        return 'idle';
    return record.demeanor;
}
