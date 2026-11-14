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
import { byUpdatedDesc, isClaimedBy, isUnassignedNote, noteFromTask, splitQuickNote, } from './store.js';
/** Vikunja HTTP 错误：status/code 供调用方区分"项目进回收站(3018)/不存在(404)"等可自愈情形 */
export class VikunjaError extends Error {
    status;
    code;
    constructor(message, status, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
/** 单页任务拉取上限（Vikunja max_items_per_page = 50，本地量级一页基本够用） */
const PAGE_SIZE = 50;
export class VikunjaNoteStore {
    api;
    token;
    inboxId;
    onInboxResolved;
    constructor(opts) {
        // baseUrl 统一到不带尾斜杠的前缀，后续路径都从这里拼（容错用户填 host 或带 /api/v1）
        const base = opts.baseUrl.trim().replace(/\/+$/, '');
        this.api = base.endsWith('/api/v1') ? base : `${base}/api/v1`;
        this.token = opts.token.trim();
        this.inboxId = opts.inboxProjectId;
        this.onInboxResolved = opts.onInboxResolved;
    }
    /** 统一请求出口：JSON in/out，非 2xx 抛带服务端 message 的中文错误 */
    async request(method, path, body) {
        let res;
        try {
            res = await fetch(`${this.api}${path}`, {
                method,
                headers: {
                    authorization: `Bearer ${this.token}`,
                    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        }
        catch (err) {
            // 网络层失败（连不上/DNS/断流）：与 HTTP 错误区分开，提示面向部署排查
            throw new Error(`无法连接 Vikunja（${this.api}）：${err instanceof Error ? err.message : String(err)}`);
        }
        if (!res.ok) {
            let detail = '';
            let code;
            try {
                const payload = await res.json();
                if (typeof payload.message === 'string')
                    detail = payload.message;
                if (typeof payload.code === 'number')
                    code = payload.code;
            }
            catch {
                // 非 JSON 错误体（如反代 502 的 HTML）：留空，状态码已足够排查
            }
            const hint = res.status === 401 ? '（token 无效或已过期）' : '';
            throw new VikunjaError(`Vikunja HTTP ${res.status}${hint}: ${detail}`, res.status, code);
        }
        return await res.json();
    }
    /** Inbox 项目 id：配置持久化的直用；否则按标题发现，缺失即建（幂等）。
     *  实证（2026-11-14 dev 实例实验）：Vikunja 会为每个首次密码登录的用户自动配发
     *  一套私人 "Inbox" 项目 + "My Open Tasks" 筛选器，与共享池同名并存（先共享也拦不住）。
     *  多个同名时取 id 最小者——共享池由管理员最先创建故 id 最小，各机器才能一致命中
     *  同一个池，而不是各自漂到私人副本上。 */
    async ensureInbox() {
        if (this.inboxId !== undefined)
            return this.inboxId;
        const projects = await this.request('GET', '/projects');
        const candidates = (Array.isArray(projects) ? projects : [])
            .filter(p => typeof p === 'object' && p !== null && p.title === 'Inbox')
            .map(p => p.id)
            .filter((id) => typeof id === 'number')
            .sort((a, b) => a - b);
        const id = candidates.length > 0
            ? candidates[0]
            : (await this.request('PUT', '/projects', { title: 'Inbox' })).id;
        if (typeof id !== 'number')
            throw new Error('Vikunja 返回的 Inbox 项目缺少数字 id');
        this.inboxId = id;
        this.onInboxResolved?.(id);
        return id;
    }
    /** 钉死的 Inbox 失效自愈：持久化的 id 可能指向已删除/进回收站的项目
     *  （实证：配置钉住私人 Inbox 后该 Inbox 被清理，列表一直报 3018）。
     *  命中 404/3018 时丢弃旧 id 重新解析（ensureInbox 会确定性取回共享池）并重试一次。 */
    async withInbox(fn) {
        const inbox = await this.ensureInbox();
        try {
            return await fn(inbox);
        }
        catch (err) {
            if (err instanceof VikunjaError && (err.status === 404 || err.code === 3018)) {
                this.inboxId = undefined;
                const fresh = await this.ensureInbox();
                return await fn(fresh);
            }
            throw err;
        }
    }
    /** Inbox 全量任务（分页拉全；本地量级一两页） */
    async listInboxTasks() {
        return await this.withInbox(async (inbox) => {
            const all = [];
            for (let page = 1; page <= 20; page++) {
                // 全量拉取后领域侧过滤：小记/任务的区分是领域谓词，不在存储侧重复一套过滤语法
                const batch = await this.request('GET', `/projects/${String(inbox)}/tasks?page=${String(page)}&per_page=${String(PAGE_SIZE)}`);
                const tasks = Array.isArray(batch) ? batch : [];
                all.push(...tasks);
                if (tasks.length < PAGE_SIZE)
                    break;
            }
            return all;
        });
    }
    async testConnection() {
        const user = await this.request('GET', '/user');
        if (typeof user.username !== 'string')
            throw new Error('Vikunja /user 响应缺少 username');
        return user.username;
    }
    async quickAdd(text) {
        const { title, description } = splitQuickNote(text);
        if (title === '')
            throw new Error('速记内容为空');
        const task = await this.withInbox(inbox => this.request('PUT', `/projects/${String(inbox)}/tasks`, { title, description }));
        return noteFromTask(task);
    }
    async listNotes() {
        const notes = (await this.listInboxTasks()).map(noteFromTask).filter(isUnassignedNote);
        return notes.sort(byUpdatedDesc);
    }
    async promote(noteId, machine) {
        if (machine.trim() === '')
            throw new Error('机器名不能为空');
        // 机器名（=用户名）→ user_id：Inbox 的可访问用户表里查（token 无需全局 users 权限）
        const users = await this.withInbox(inbox => this.request('GET', `/projects/${String(inbox)}/projectusers`));
        const hit = (Array.isArray(users) ? users : []).find(u => typeof u === 'object' && u !== null && u.username === machine.trim());
        const userId = hit !== undefined ? hit.id : undefined;
        if (typeof userId !== 'number')
            throw new Error(`机器 "${machine.trim()}" 不在 Inbox 可访问用户中（需先在 Vikunja 建用户并共享项目）`);
        await this.request('PUT', `/tasks/${String(noteId)}/assignees`, { user_id: userId });
        const task = await this.request('GET', `/tasks/${String(noteId)}`);
        return noteFromTask(task);
    }
    async claimTasks(machine) {
        const tasks = (await this.listInboxTasks()).map(noteFromTask).filter(n => isClaimedBy(n, machine));
        return tasks.sort(byUpdatedDesc);
    }
    /** Vikunja 的任务更新接口会用请求体整体覆盖 assignees（不带=清空）。
     * 更新前取现有分配、更新后逐个补写回来，避免开工/完成把分配者抹掉。
     * 实证：POST /tasks/{id} {start_date} 后 assignees 由 ["mac-mini"] 变 null。 */
    async updateKeepingAssignees(taskId, body) {
        const before = await this.request('GET', `/tasks/${String(taskId)}`);
        const beforeAssignees = Array.isArray(before.assignees) ? before.assignees : [];
        const task = await this.request('POST', `/tasks/${String(taskId)}`, body);
        for (const a of beforeAssignees) {
            const uid = typeof a === 'object' && a !== null ? a.id : undefined;
            if (typeof uid === 'number') {
                await this.request('PUT', `/tasks/${String(taskId)}/assignees`, { user_id: uid });
            }
        }
        // 更新响应里的 assignees 是被清空的旧值；补写后重查，返回值才能如实反映归属
        return noteFromTask(beforeAssignees.length > 0
            ? await this.request('GET', `/tasks/${String(taskId)}`)
            : task);
    }
    async startTask(taskId) {
        return this.updateKeepingAssignees(taskId, { start_date: new Date().toISOString() });
    }
    async completeTask(taskId, summary) {
        const note = await this.updateKeepingAssignees(taskId, { done: true });
        // 摘要回写走评论：done 之后 Vikunja 会把任务移出默认视图，评论是持久上下文的正位
        if (summary !== undefined && summary.trim() !== '') {
            await this.request('PUT', `/tasks/${String(taskId)}/comments`, { comment: summary.trim() });
        }
        return note;
    }
    async deleteNote(noteId) {
        // Vikunja 的任务删除是软删除进回收站（实证：删后 GET 返 4040 "in the trash"），
        // 恢复走网页回收站视图（POST /api/v2/tasks/{id}/restore）；响应体 {"message":...} 正常 JSON
        await this.request('DELETE', `/tasks/${String(noteId)}`);
    }
}
