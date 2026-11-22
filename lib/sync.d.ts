/**
 * 配置云端同步（WebDAV）：把提醒规则 store、外观配置、故事线模板打包成
 * 单个 JSON 文档上传/下载。跨机器迁移配置用，替代手工拷数据文件。
 *
 * 首版为手动同步（设置页按钮）：上传=本机三份文件 → 云端一份；下载=云端
 * 一份 → 校验后经运行时同款出口应用（热生效）。冲突策略 last-write-wins：
 * 下载前 UI 先 peek 云端摘要，由用户确认覆盖。
 *
 * 连接信息（含 WebDAV 应用密码）以 0600 权限明文存放在插件数据目录的
 * sync.json——与 .env/多数 CLI 同一威胁模型；密码用坚果云「应用密码」等
 * 可单独吊销的凭据，不用主账号密码。
 */
/** WebDAV 连接配置（server+remotePath 唯一确定远端文档地址） */
export interface SyncConnection {
    server: string;
    username: string;
    password: string;
    remotePath: string;
}
/**
 * 同步包：一份完整配置快照。section 为 null 表示上传机器上没有该项
 * （如从未编辑过故事线），下载时跳过该项不覆盖本地。
 */
export interface SyncBundle {
    kind: 'dsh-maze-config';
    version: 1;
    /** 上传时刻（epoch ms），peek 摘要与 last-write-wins 判断的依据 */
    uploadedAt: number;
    /** 上传机器标识（hostname），仅用于摘要展示"这是哪台机器传的" */
    machine: string;
    /** 提醒规则 store 形状：{version:1, rules:[], deletedIds:[]} */
    rules: unknown | null;
    /** 外观配置 AppearanceConfig */
    appearance: unknown | null;
    /** 故事线 store 形状：{templates:[], deletedIds:[], selectedTemplateId:''} */
    narratives: unknown | null;
}
/** peek 返回的用户可读摘要（不含提示词等大字段） */
export interface SyncSummary {
    uploadedAt: number;
    machine: string;
    rules: {
        id: string;
        name: string;
        trigger: string;
    }[];
    ruleDeletedCount: number;
    appearance: {
        hasBackground: boolean;
        backgroundEnabled: boolean;
        hostCount: number;
    } | null;
    narratives: {
        templates: {
            id: string;
            name: string;
        }[];
        selectedTemplateId: string;
    } | null;
}
/**
 * 校验并归一连接配置：server 必须是 http(s) URL、账号密码非空、
 * remotePath 以 / 开头。全部字段 trim（密码 trim 掉手滑的首尾空格）。
 */
export declare function validateSyncConnection(raw: unknown): SyncConnection;
/** 读取连接配置；未配置返回 null；文件损坏向上抛（由路由转 500 提示重填） */
export declare function loadSyncConnection(dataDir: string): SyncConnection | null;
/** 保存连接配置：原子写（tmp+rename）+ 0600（含应用密码，只限当前用户可读） */
export declare function saveSyncConnection(dataDir: string, conn: SyncConnection): void;
/** 校验同步包形状（只做外壳门禁；各 section 的内容校验在应用前做） */
export declare function validateSyncBundle(raw: unknown): SyncBundle;
/**
 * 从同步包提取用户可读摘要（peek 用）：规则名列表/外观要点/故事线名列表，
 * 不带提示词与大字段，UI 确认覆盖前看这个。
 */
export declare function summarizeBundle(bundle: SyncBundle): SyncSummary;
/** 远端文档完整 URL（server 已去尾斜杠、remotePath 已保头斜杠，直接拼接） */
export declare function davUrl(conn: SyncConnection): string;
/**
 * 单次 WebDAV 请求（GET/PUT）。网络层错误（DNS/超时/TLS）向上抛带原因的
 * Error；HTTP 状态由调用方解释（404=云端为空，2xx=成功，其余=远端拒绝）。
 */
export declare function davRequest(conn: SyncConnection, method: 'GET' | 'PUT', body?: string): Promise<{
    status: number;
    text: string;
}>;
