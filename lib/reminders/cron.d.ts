/**
 * 5 字段 cron 解析与匹配（分 时 日 月 周），纯函数、无依赖。
 *
 * 为何手写：通知场景只需要 POSIX 5 字段语义的子集（列表/范围/步长），
 * 引入完整 cron 库不值得；解析在装载期执行、错误当场抛出（fail-loud）。
 *
 * 语义约定（与标准 cron 一致）：
 * - 日(day-of-month) 与 周(day-of-week) 同时受限时按 OR 匹配，仅一方受限时按 AND；
 * - 匹配精度为分钟，调用方（调度器）负责去重同一分钟内的重复触发。
 */
/** 单个字段的解析结果：any=true 表示 `*`（不受限），否则 values 为允许值集合 */
export interface CronField {
    readonly any: boolean;
    readonly values: ReadonlySet<number>;
}
/** 完整 5 字段解析结果，domRestricted/dowRestricted 为 OR 语义所需 */
export interface CronSpec {
    readonly minute: CronField;
    readonly hour: CronField;
    readonly dom: CronField;
    readonly month: CronField;
    readonly dow: CronField;
}
/** 解析完整 5 字段表达式，任何字段非法直接 throw（装载期校验用） */
export declare function parseCron(expr: string): CronSpec;
/** 判断给定时刻是否命中（秒/毫秒截断到分钟后比较） */
export declare function matchesCron(spec: CronSpec, at: Date): boolean;
/**
 * 从 from（截断到分钟）起向前找下一次命中时刻；maxMinutes 内未命中返回 null。
 * 上限默认 7 天（10080 分钟）：覆盖周/月级循环；更稀疏的表达式（如 2 月 29 日）
 * 在不含命中的窗口内返回 null——预览端把 null 呈现为"7 天内不会触发"。
 */
export declare function nextCronMatch(spec: CronSpec, from: Date, maxMinutes?: number): Date | null;
