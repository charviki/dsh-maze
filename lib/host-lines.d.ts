/**
 * 各接待员的出厂台词库（逐字取自《西部世界》S1-S4，Wikiquote 校对）。
 * 三组：daily（日常五神态共用大池）/ done（收束）/ failed（失灵）。
 * 由 live 配置烘焙生成：修改台词请走设置 UI 或数据文件，不要手改本文件。
 */
export declare const DEFAULT_HOST_ORDER: readonly ["dolores", "maeve", "bernard", "teddy", "william"];
export declare const DEFAULT_HOST_NAMES: Record<string, string>;
export type HostLines = {
    daily: string[];
    done: string[];
    failed: string[];
};
export declare const DEFAULT_HOST_LINES: Record<string, HostLines>;
