/**
 * 小记连接配置持久化：<dataDir>/notes-config.json。
 *
 * 为何不入 cordis 配置：baseUrl/token/machineName 是每台机器各异的运行时数据
 * （token 属于机器凭据，不应进可能被分享/提交的 yml），与 reminders store 同级
 * 放 profile 数据目录，由设置页「小记」Tab 编辑。
 * token 以明文落盘：与 rules.json/appearance.json 同信任级（用户自己的本地文件），
 * 生产收紧方案是接入 DSH credentials 管理 token（留待后续）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** 空配置（未配置态） */
export function emptyNotesConfig() {
    return { baseUrl: '', token: '', machineName: '', machines: [] };
}
/** 归一与校验：类型收敛 + 必要字段非空（空 baseUrl/token 视为未配置，由调用方分支） */
export function validateNotesConfig(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        throw new Error('小记配置必须是对象');
    const r = raw;
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const machines = Array.isArray(r.machines)
        ? r.machines.filter((m) => typeof m === 'string' && m.trim() !== '').map(m => m.trim())
        : [];
    const cfg = {
        // 尾斜杠统一剥除：落盘即规范形（store 侧仍带归一逻辑作防御，二者幂等）
        baseUrl: str(r.baseUrl).replace(/\/+$/, ''),
        token: str(r.token),
        machineName: str(r.machineName),
        ...(typeof r.inboxProjectId === 'number' ? { inboxProjectId: r.inboxProjectId } : {}),
        machines: [...new Set(machines)],
    };
    return cfg;
}
/** 同步读；文件缺失=空配置，结构损坏 throw（调用方降级为未配置并告警） */
export function loadNotesConfigSync(dataDir) {
    const file = join(dataDir, 'notes-config.json');
    if (!existsSync(file))
        return emptyNotesConfig();
    return validateNotesConfig(JSON.parse(readFileSync(file, 'utf8')));
}
/** 原子写（tmp + rename），与 rules.json 同策略 */
export function saveNotesConfigSync(dataDir, cfg) {
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, 'notes-config.json');
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
}
