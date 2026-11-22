/**
 * 后台通知：跨会话关注三类"阻塞了却没人看得见"的状态——
 * ① 审批等待：approval/asked 后超过 30 秒仍无 approval/decided（后台会话
 *   弹的审批没有任何全局可见信号，能一直挂到天荒地老）；
 * ② 待答问题卡：ask_user_question 工具弹的问题卡（tool/call 与 tool/result
 *   按 callId 配对），同样 30 秒未答即提示（任何会话通用，非故事线专用）；
 * ③ 会话卡死：turn/start 后超过 10 分钟该会话无任何事件且未 turn/end
 *   （跑长任务挂了/深夜挂机的场景）。
 * 纯状态机：宿主把 session/event 流喂进来，到期由 collectDue 拉取待通知
 * 列表（带补提节律）。只在内存里活——应用重启清零，可接受（重启本身就会
 * 让人看一眼各会话）。神态通道（demeanorBySession）不受影响：通知是独立的
 * 提示层，神态仍严格跟随当前会话。
 */
/** 一条待通知事项（线上的精简形态：客户端用 sessionId 自己解析会话标题） */
export interface MazeNotification {
    kind: 'approval' | 'question' | 'stuck';
    /** 待办归属的会话 */
    sessionId: string;
    /** 开始等待的时间戳（approval/question=最早一次 asked；stuck=最后一次事件时间） */
    since: number;
    /** 本次提示的时间戳（补提周期每轮不同）——客户端按它去重已读提示 */
    nagAt: number;
}
/** 通知状态机的可调参数（测试注入用） */
export interface NotifyTuning {
    /** 审批首提延迟 */
    approvalDelayMs: number;
    /** 审批补提间隔 */
    approvalRenagMs: number;
    /** 卡死判定：running 且无事件的静默时长 */
    stuckSilenceMs: number;
}
export declare const DEFAULT_NOTIFY_TUNING: NotifyTuning;
export declare class NotifyTracker {
    private readonly tuning;
    private readonly approvals;
    private readonly questions;
    private readonly running;
    constructor(tuning?: NotifyTuning);
    /** 喂一个会话事件（与神态投影共用同一事件流；事件类型不相关时原样忽略）。
     *  data 为该事件的 data 载荷（只读 tool/call 与 tool/result 的字段，防御式）。 */
    observe(sessionId: string, eventType: string, data: unknown, now: number): void;
    /** 拉取到期通知（有副作用：推进补提/去重记账——挂在读上是刻意的，
     *  statePayload 每 3s 轮询一次正好驱动节律，无需独立定时器） */
    collectDue(now: number): MazeNotification[];
}
