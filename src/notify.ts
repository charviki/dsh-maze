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

/** 审批等待项（含补提节律的内部记账）。open 计数：同会话可能叠多笔审批，
 *  decided 逐笔递减，归零才删——否则第一笔 decided 会误杀仍挂着的后续笔。 */
interface ApprovalPending {
  sessionId: string;
  /** 最早一笔 asked 的时间（提示口径：等了多久从第一笔算） */
  askedAt: number;
  /** 仍在等待的审批笔数（asked++ / decided--） */
  open: number;
  lastNagAt: number;
}

/** 待答问题项（ask_user_question 工具弹的问题卡，含补提节律的内部记账）。
 *  按 callId 精确配对：tool/call(ask_user_question) 进、对应 tool/result 出。 */
interface QuestionPending {
  sessionId: string;
  /** 最早一张问题卡弹出的时间（提示口径） */
  askedAt: number;
  /** 挂起中的问题卡 callId 集 */
  callIds: Set<string>;
  lastNagAt: number;
}

/** 会话运行态记账（卡死检测用） */
interface RunningSession {
  sessionId: string;
  turnStartedAt: number;
  lastEventAt: number;
  notifiedAt?: number;
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

export const DEFAULT_NOTIFY_TUNING: NotifyTuning = {
  approvalDelayMs: 30_000,
  approvalRenagMs: 600_000,
  stuckSilenceMs: 600_000,
};

export class NotifyTracker {
  private readonly approvals = new Map<string, ApprovalPending>();
  private readonly questions = new Map<string, QuestionPending>();
  private readonly running = new Map<string, RunningSession>();
  constructor(private readonly tuning: NotifyTuning = DEFAULT_NOTIFY_TUNING) {}

  /** 喂一个会话事件（与神态投影共用同一事件流；事件类型不相关时原样忽略）。
   *  data 为该事件的 data 载荷（只读 tool/call 与 tool/result 的字段，防御式）。 */
  observe(sessionId: string, eventType: string, data: unknown, now: number): void {
    if (eventType === 'approval/asked') {
      // 同会话叠多笔审批：计数累加，提示时间口径用最早一笔（"有审批在等"足够）
      const rec = this.approvals.get(sessionId);
      if (rec === undefined) this.approvals.set(sessionId, { sessionId, askedAt: now, open: 1, lastNagAt: 0 });
      else rec.open += 1;
      return;
    }
    if (eventType === 'approval/decided') {
      // 逐笔递减：还有挂着的后续笔就保留记录（askedAt 保留最早口径）
      const rec = this.approvals.get(sessionId);
      if (rec !== undefined) {
        rec.open -= 1;
        if (rec.open <= 0) this.approvals.delete(sessionId);
      }
      return;
    }
    if (eventType === 'tool/call' || eventType === 'tool/result') {
      // ask_user_question 弹的问题卡=另一种"会话里有弹窗在等"（通用，非故事线专用）。
      // 配对：tool/call(ask_user_question) 进、对应 tool/result 出；无论是否问题卡，
      // 都落到末尾的活性刷新（工具活动=会话活着，不能漏刷而误报卡死）
      if (eventType === 'tool/call') {
        const rec = asRecord(data);
        if (rec?.name === 'ask_user_question') {
          const callId = rec.callId;
          if (typeof callId === 'string' && callId !== '') {
            const q = this.questions.get(sessionId);
            if (q === undefined) this.questions.set(sessionId, { sessionId, askedAt: now, callIds: new Set([callId]), lastNagAt: 0 });
            else q.callIds.add(callId);
          }
        }
      } else {
        // 问题卡出结果（作答/超时/中断修复的合成结果都算"不再挂着"）即销账
        const callId = asRecord(asRecord(data)?.message)?.toolCallId;
        if (typeof callId === 'string' && callId !== '') {
          const q = this.questions.get(sessionId);
          if (q !== undefined) {
            q.callIds.delete(callId);
            if (q.callIds.size === 0) this.questions.delete(sessionId);
          }
        }
      }
    }
    if (eventType === 'turn/start') {
      this.running.set(sessionId, { sessionId, turnStartedAt: now, lastEventAt: now });
      return;
    }
    if (eventType === 'turn/end' || eventType === 'session/disposed') {
      // 会话收束：卡死观察终止；销毁时审批与问题卡一起清——会话没了弹窗流
      //  不复存在，挂着只会变成对死会话的永生补提（turn/end 不清审批/问题：
      //  会话还活着，跨 turn 的弹窗仍可能被回来处理）
      this.running.delete(sessionId);
      if (eventType === 'session/disposed') {
        this.approvals.delete(sessionId);
        this.questions.delete(sessionId);
      }
      return;
    }
    // 其余任何事件都算"会话还活着"：刷新静默计时并结束上一轮卡死（有新事件
    // 之后的再次静默算新一轮，值得再报）。只刷新已在观察的会话，不为无关会话
    // 凭空建账——turn/start 才是开观察的唯一入口
    const rec = this.running.get(sessionId);
    if (rec !== undefined) {
      rec.lastEventAt = now;
      delete rec.notifiedAt;
    }
  }

  /** 拉取到期通知（有副作用：推进补提/去重记账——挂在读上是刻意的，
   *  statePayload 每 3s 轮询一次正好驱动节律，无需独立定时器） */
  collectDue(now: number): MazeNotification[] {
    const out: MazeNotification[] = [];
    for (const a of this.approvals.values()) {
      const waited = now - a.askedAt;
      // 首提看 approvalDelayMs；补提看距上次提示的间隔（lastNagAt=0 是"从未提示过"哨兵——
      // 不能把首提也套补提间隔，否则首提要等满两个阈值）
      if (waited >= this.tuning.approvalDelayMs && (a.lastNagAt === 0 || now - a.lastNagAt >= this.tuning.approvalRenagMs)) {
        a.lastNagAt = now;
        out.push({ kind: 'approval', sessionId: a.sessionId, since: a.askedAt, nagAt: now });
      }
    }
    for (const q of this.questions.values()) {
      // 问题卡与审批同一节律：挂久了同样是"阻塞了却没人看得见"
      const waited = now - q.askedAt;
      if (waited >= this.tuning.approvalDelayMs && (q.lastNagAt === 0 || now - q.lastNagAt >= this.tuning.approvalRenagMs)) {
        q.lastNagAt = now;
        out.push({ kind: 'question', sessionId: q.sessionId, since: q.askedAt, nagAt: now });
      }
    }
    for (const r of this.running.values()) {
      const silent = now - r.lastEventAt;
      // 卡死只报一次（notifiedAt 去重）：持续静默本身不再补提，等事件恢复
      if (silent >= this.tuning.stuckSilenceMs && r.notifiedAt === undefined) {
        r.notifiedAt = now;
        out.push({ kind: 'stuck', sessionId: r.sessionId, since: r.lastEventAt, nagAt: now });
      }
    }
    return out;
  }
}

/** 防御式读事件 data 载荷（跨构建事件形状可能滞后，与 index.ts 的读法一致） */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
