/**
 * 规则引擎 v2：触发源（model-call / cron）× 条件（L1 结构化 + L2 表达式）× 频控。
 *
 * 设计要点：
 * - 纯函数、无 IO；持久化（store）与调度（30s tick）在插件主体（index.ts）。
 * - trigger 缺省时按形状推断：有 schedule 即 cron，否则 model-call。
 * - L2 表达式（when）与 L1 条件是 AND 关系；when 仅允许配置文件作者使用（与 cordis !!js 同信任级），
 *   装载期编译并校验语法，求值异常视为不触发（宁可漏报不可刷屏）。
 */
/** 触发源类型：模型调用时评估 / 定时调度（cron） */
export type Trigger = 'model-call' | 'cron';
/** 规则定义（规范化后）。条件字段按触发源取用，另一组忽略 */
export interface RuleDef {
    readonly id: string;
    /** 展示名，缺省用 id */
    readonly name?: string;
    readonly message: string;
    readonly trigger: Trigger;
    /** cron 触发源必填：5 字段表达式（分 时 日 月 周） */
    readonly schedule?: string;
    /** model-call 条件：生效时段 [startHour, endHour)，默认全天 */
    readonly startHour?: number;
    readonly endHour?: number;
    /** 频控：每日最多触发次数，默认 2 */
    readonly maxPerDay?: number;
    /** 频控：冷却分钟数，默认 120 */
    readonly cooldownMinutes?: number;
    /** config 声明：UI 只读不可编辑/删除（运行时 store 恒可覆盖 enabled 开关除外） */
    readonly locked?: boolean;
    /** L2 表达式：'(use, hour, minute, dow) => boolean' 形式的 JS 表达式，仅配置文件 */
    readonly when?: string;
    /** model-call 条件：限定星期（0=周日..6=周六，JS getDay 语义；缺省=每天） */
    readonly daysOfWeek?: readonly number[];
    /** model-call 条件：模型匹配正则源串（对 `provider/model` 复合串测试，i 标志大小写
     *  不敏感）。缺省/空串 = 匹配一切。排除用负向断言：`^(?!.*glm)` = 非智谱才提醒 */
    readonly modelPattern?: string;
}
/** 运行时状态。字段一律追加到末尾（遵循"追末尾"约定） */
export interface RuleState {
    enabled: boolean;
    /** 今日已触发的时间戳（epoch ms），用于每日上限与冷却判断 */
    firedToday: number[];
    /** 今日免打扰（localDateKey），存在即当日不触发 */
    mutedDay?: string;
    /** cron 去重：最近一次触发的分钟标识（'YYYY-MM-DDTHH:mm'），防止 30s tick 同分钟双发 */
    lastCronMinute?: string;
    /** 最近一次触发的时间戳（跨日保留）：冷却判断用——firedToday 按日清理会把
     *  昨晚的记录清掉，冷却若跟着丢就会在午夜后立刻重复触发 */
    lastFireAt?: number;
}
export interface Reminder {
    /** `${ruleId}:${firedAt}` */
    readonly id: string;
    readonly ruleId: string;
    readonly message: string;
    readonly firedAt: number;
}
/** 模型使用观察样本（llm/stream 事件抽样） */
export interface ModelUse {
    readonly provider: string;
    readonly model: string;
    readonly at: number;
}
export type AckAction = 'dismiss' | 'muteToday';
export interface HistoryEntry {
    readonly reminderId: string;
    readonly ruleId: string;
    readonly message: string;
    readonly firedAt: number;
    readonly ackedAt: number;
    readonly action: AckAction;
}
/** L2 表达式求值函数：参数为观察上下文 */
export type WhenFn = (use: ModelUse | null, hour: number, minute: number, dow: number) => boolean;
/** 本地日期键（跨日重置频控用），格式 'YYYY-MM-DD' */
export declare function localDateKey(at: number): string;
/** 旧匹配字段迁移（通配/exclude 时代 → 正则-only），在 validateRule 之前跑：
 *  - 带 patternMode/excludeModelPattern 旧键：pattern 不是合法正则（如 '*glm*'）→ 按通配
 *    语义转换，是合法正则则原样保留；exclude 合成为串首负向断言（与旧排除门
 *    "子串命中即拒绝"语义一致）：'*' + exclude '*glm*' → `^(?!.*glm)`
 *  - 不带旧键的新格式：合法正则原样返回；含 '*' 且编译失败的（pre-模式时代的
 *    通配数据，如裸 '*glm*'）同样按通配转换；不含 '*' 的编译失败原样保留，
 *    交给 validateRule 带字段名报错（新格式的正则笔误要 fail-loud，不能静默转义） */
export declare function migrateRuleInput(raw: Record<string, unknown>): Record<string, unknown>;
/** 消息模板渲染：{model}/{provider} 占位替换 */
export declare function renderMessage(template: string, use: ModelUse | null): string;
/**
 * 规范化规则：填充默认值、推断触发源。
 * 输入形状由 validateRule 先验（错误类型在那边报错），此处只做语义默认，不做完整校验。
 */
export declare function normalizeRule(raw: Record<string, unknown>): RuleDef;
/**
 * 编译 L2 表达式。表达式求值为真值才允许触发。
 * 为何用 new Function：when 仅来自用户自己的配置文件（与 cordis !!js 同信任级），不值得引入表达式库。
 * @param when 表达式文本，如 "use && use.model.includes('glm') && hour >= 14"
 * @returns 求值函数；when 为空返回 null（无条件门）
 * @throws 语法错误直接抛出（装载期 fail-loud）
 */
export declare function compileWhen(when: string | undefined): WhenFn | null;
/** model-call 条件评估（L1 结构化 + L2 when AND） */
export declare function evaluateModelCall(rule: RuleDef, state: RuleState, use: ModelUse, when: WhenFn | null): boolean;
/** 共享频控门：每日上限（按日计数）+ 冷却（跨日，基准 lastFireAt）通过才生成 Reminder 并记账 */
export declare function fireReminder(rule: RuleDef, state: RuleState, at: number, rendered: string): Reminder | null;
/**
 * 模型调用观察入口：对 trigger='model-call' 的规则逐条评估并触发。
 * @param compiled 预编译的 when 函数表（ruleId → WhenFn|null），由装载方构建避免每次调用重编译
 */
export declare function observe(rules: readonly RuleDef[], states: Map<string, RuleState>, use: ModelUse, compiled: Map<string, WhenFn | null>): Reminder[];
/**
 * 定时调度观察入口：对 trigger='cron' 且 schedule 命中当前分钟的规则触发（每分钟至多一次）。
 * @param specMatcher 已解析的 cron 匹配器表（ruleId → (at)=>boolean）
 */
export declare function observeTick(rules: readonly RuleDef[], states: Map<string, RuleState>, now: number, specMatcher: Map<string, (at: Date) => boolean>, compiled: Map<string, WhenFn | null>): Reminder[];
/** 今日免打扰：将规则 mutedDay 置为当前本地日 */
export declare function muteRuleForToday(ruleId: string, states: Map<string, RuleState>, now: number): void;
/** 启停规则（规则存在性由调用方先行检查，此处只改状态） */
export declare function setRuleEnabled(ruleId: string, enabled: boolean, states: Map<string, RuleState>, now: number): void;
