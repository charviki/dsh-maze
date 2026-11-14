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
/** 速记切分：首行为标题（超长截断到 200 字符，Vikunja 标题上限友好），
 * 其余行为描述；纯文本无首行时整段作标题 */
export function splitQuickNote(text) {
    const trimmed = text.trim();
    const nl = trimmed.indexOf('\n');
    const firstLine = nl === -1 ? trimmed : trimmed.slice(0, nl);
    const rest = nl === -1 ? '' : trimmed.slice(nl + 1).trim();
    // 标题截断到 200：标题在小记列表是主展示位，超长部分并入描述不丢内容
    const title = firstLine.slice(0, 200);
    const overflow = firstLine.slice(200);
    const description = overflow === '' ? rest : [overflow, rest].filter(s => s !== '').join('\n');
    return { title, description };
}
/** 存储侧任务 JSON → 领域 Note（防御式读取：字段缺失/类型漂移不炸，落到空值） */
export function noteFromTask(task) {
    const assigneesRaw = Array.isArray(task.assignees) ? task.assignees : [];
    const assignees = assigneesRaw
        .map(a => (typeof a === 'object' && a !== null ? a.username : undefined))
        .filter((u) => typeof u === 'string');
    const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
    // Vikunja 未设的时间字段以 Go 零值 "0001-01-01T00:00:00Z" 返回而非 null：
    // 真日期必在 Unix 纪元之后（t > 0），零值/垃圾串都判未开工
    const startMs = str(task.start_date) === null ? NaN : Date.parse(str(task.start_date));
    return {
        id: typeof task.id === 'number' ? task.id : -1,
        title: typeof task.title === 'string' ? task.title : '',
        description: typeof task.description === 'string' ? task.description : '',
        createdAt: str(task.created),
        updatedAt: str(task.updated),
        done: task.done === true,
        assignees,
        started: Number.isNaN(startMs) === false && startMs > 0,
    };
}
/** 小记判定：未完成且无人认领 */
export function isUnassignedNote(note) {
    return !note.done && note.assignees.length === 0;
}
/** 任务认领判定：未完成且 assignees 含该机器 */
export function isClaimedBy(note, machine) {
    return !note.done && note.assignees.includes(machine);
}
/** 列表排序：updated 新到旧（速记场景最新最重要；updated 缺失记 0，降序自然沉底） */
export function byUpdatedDesc(a, b) {
    const ta = a.updatedAt === null ? 0 : Date.parse(a.updatedAt);
    const tb = b.updatedAt === null ? 0 : Date.parse(b.updatedAt);
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
}
