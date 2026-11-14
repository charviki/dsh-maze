/**
 * 小记/任务领域模型与防腐层接口。
 *
 * 设计：
 * dsh-maze 的 UI、agent 工具、编排全部面向这里的概念（note/task/machine），
 * 不出现 Vikunja 特有概念（project/bucket/index）；Vikunja 是 NoteStore 的
 * 第一个实现，未来自研服务实现同一接口即可整体替换。
 *
 * 映射约定（v1，单 Inbox 项目）：
 * - 小记 = Inbox 项目里未完成且无 assignee 的任务
 * - 任务 = 已 assignee（机器名 = Vikunja 用户名）且未完成的任务
 * - 进行中 = start_date 非空（Vikunja 原生字段，无额外状态机）
 * - 完成 = done=true，可选摘要以评论回写
 */
/** 领域小记/任务条目（两个视图共用一个形状，assignees 区分阶段） */
export interface Note {
    /** Vikunja task id（数字，直接透传；对领域层是不透明 id） */
    id: number;
    title: string;
    description: string;
    createdAt: string | null;
    updatedAt: string | null;
    done: boolean;
    /** 已分配的机器名（Vikunja 用户名）列表 */
    assignees: string[];
    /** 进行中标记：start_date 非空即视为已开工 */
    started: boolean;
}
/**
 * 小记/任务存储防腐层。实现必须自行处理认证与错误包装：
 * 网络失败/认证失败抛 Error（message 面向用户），由路由层转 4xx/5xx。
 */
export interface NoteStore {
    /** 验证连接与凭据，返回 token 对应的用户名（设置页"测试连接"用） */
    testConnection(): Promise<string>;
    /** 速记：一段文本落为小记（首行作标题，其余作描述） */
    quickAdd(text: string): Promise<Note>;
    /** 小记列表（未完成且未分配），新到旧 */
    listNotes(): Promise<Note[]>;
    /** 小记 → 任务：分配给指定机器（机器名 = 存储侧用户名） */
    promote(noteId: number, machine: string): Promise<Note>;
    /** 某机器名下的待办任务（未完成且 assignees 含 machine），新到旧 */
    claimTasks(machine: string): Promise<Note[]>;
    /** 开工：标记进行中（幂等） */
    startTask(taskId: number): Promise<Note>;
    /** 完成任务；summary 非空时作为完成摘要回写（v1：评论形式） */
    completeTask(taskId: number, summary?: string): Promise<Note>;
    /** 删除：移入 Vikunja 任务回收站（误删可在 Vikunja 网页回收站页恢复） */
    deleteNote(noteId: number): Promise<void>;
}
/** 速记切分：首行为标题（超长截断到 200 字符，Vikunja 标题上限友好），
 * 其余行为描述；纯文本无首行时整段作标题 */
export declare function splitQuickNote(text: string): {
    title: string;
    description: string;
};
/** 存储侧任务 JSON → 领域 Note（防御式读取：字段缺失/类型漂移不炸，落到空值） */
export declare function noteFromTask(task: Record<string, unknown>): Note;
/** 小记判定：未完成且无人认领 */
export declare function isUnassignedNote(note: Note): boolean;
/** 任务认领判定：未完成且 assignees 含该机器 */
export declare function isClaimedBy(note: Note, machine: string): boolean;
/** 列表排序：updated 新到旧（速记场景最新最重要；updated 缺失记 0，降序自然沉底） */
export declare function byUpdatedDesc(a: Note, b: Note): number;
