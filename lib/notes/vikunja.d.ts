/**
 * Vikunja 实现 NoteStore（防腐层的第一个后端）。
 *
 * 概念映射（对领域层不可见）：
 * - 小记池 = Inbox 项目（按标题发现，缺失即建；多同名时取 id 最小者＝共享池，
 *   见 ensureInbox 注释）；id 由调用方持久化加速二次装载
 * - 小记 = Inbox 中未完成且无 assignee 的任务；速记首行作 title 其余作 description
 * - 分配 = Vikunja assignee（机器名 = 机器用户名）；进行中 = start_date 非空
 *
 * 凭据：scoped API Token（Bearer）。错误统一包装为中文 message（路由层直接透出），
 * HTTP 错误抛 VikunjaError（带 status/code，供"钉死的 Inbox 失效"自愈判定）。
 */
import { type Note, type NoteStore } from './store.js';
/** Vikunja HTTP 错误：status/code 供调用方区分"项目进回收站(3018)/不存在(404)"等可自愈情形 */
export declare class VikunjaError extends Error {
    readonly status: number;
    readonly code: number | undefined;
    constructor(message: string, status: number, code: number | undefined);
}
/** Vikunja 连接参数；inboxProjectId 可选（缺省自动发现/创建） */
export interface VikunjaOptions {
    baseUrl: string;
    token: string;
    inboxProjectId?: number;
    /** Inbox 项目 id 首次确定时回调（调用方持久化到 notes-config 加速下次装载） */
    onInboxResolved?: (projectId: number) => void;
}
export declare class VikunjaNoteStore implements NoteStore {
    private readonly api;
    private readonly token;
    private inboxId;
    private readonly onInboxResolved;
    constructor(opts: VikunjaOptions);
    /** 统一请求出口：JSON in/out，非 2xx 抛带服务端 message 的中文错误 */
    private request;
    /** Inbox 项目 id：配置持久化的直用；否则按标题发现，缺失即建（幂等）。
     *  实证（2026-11-14 dev 实例实验）：Vikunja 会为每个首次密码登录的用户自动配发
     *  一套私人 "Inbox" 项目 + "My Open Tasks" 筛选器，与共享池同名并存（先共享也拦不住）。
     *  多个同名时取 id 最小者——共享池由管理员最先创建故 id 最小，各机器才能一致命中
     *  同一个池，而不是各自漂到私人副本上。 */
    private ensureInbox;
    /** 钉死的 Inbox 失效自愈：持久化的 id 可能指向已删除/进回收站的项目
     *  （实证：配置钉住私人 Inbox 后该 Inbox 被清理，列表一直报 3018）。
     *  命中 404/3018 时丢弃旧 id 重新解析（ensureInbox 会确定性取回共享池）并重试一次。 */
    private withInbox;
    /** Inbox 全量任务（分页拉全；本地量级一两页） */
    private listInboxTasks;
    testConnection(): Promise<string>;
    quickAdd(text: string): Promise<Note>;
    listNotes(): Promise<Note[]>;
    promote(noteId: number, machine: string): Promise<Note>;
    claimTasks(machine: string): Promise<Note[]>;
    /** Vikunja 的任务更新接口会用请求体整体覆盖 assignees（不带=清空）。
     * 更新前取现有分配、更新后逐个补写回来，避免开工/完成把分配者抹掉。
     * 实证：POST /tasks/{id} {start_date} 后 assignees 由 ["mac-mini"] 变 null。 */
    private updateKeepingAssignees;
    startTask(taskId: number): Promise<Note>;
    completeTask(taskId: number, summary?: string): Promise<Note>;
    deleteNote(noteId: number): Promise<void>;
}
