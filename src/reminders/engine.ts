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
export function localDateKey(at: number): string {
  const d = new Date(at);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 旧通配 pattern（`*` 分段）转正则源串：段按字面转义、中间 `*` → `[\s\S]*`；
 *  首/尾 `*` 直接省略（无锚=任意前后）；无 `*` 为全等匹配（^…$）。'*' → ''（匹配一切） */
function wildcardToRegexSrc(pattern: string): string {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!pattern.includes('*')) return `^${esc(pattern)}$`;
  const lead = pattern.startsWith('*');
  const trail = pattern.endsWith('*');
  let segs = pattern.split('*').map(esc);
  if (lead) segs = segs.slice(1);
  if (trail && segs.length > 0) segs = segs.slice(0, -1);
  const src = segs.join('[\\s\\S]*');
  return (lead ? '' : '^') + src + (trail ? '' : '$');
}

/** 旧匹配字段迁移（通配/exclude 时代 → 正则-only），在 validateRule 之前跑：
 *  - 带 patternMode/excludeModelPattern 旧键：pattern 不是合法正则（如 '*glm*'）→ 按通配
 *    语义转换，是合法正则则原样保留；exclude 合成为串首负向断言（与旧排除门
 *    "子串命中即拒绝"语义一致）：'*' + exclude '*glm*' → `^(?!.*glm)`
 *  - 不带旧键的新格式：合法正则原样返回；含 '*' 且编译失败的（pre-模式时代的
 *    通配数据，如裸 '*glm*'）同样按通配转换；不含 '*' 的编译失败原样保留，
 *    交给 validateRule 带字段名报错（新格式的正则笔误要 fail-loud，不能静默转义） */
export function migrateRuleInput(raw: Record<string, unknown>): Record<string, unknown> {
  const next = { ...raw };
  const exclude = typeof next.excludeModelPattern === 'string' && next.excludeModelPattern.trim() !== ''
    ? next.excludeModelPattern
    : undefined;
  const hadLegacy = next.patternMode !== undefined || exclude !== undefined;
  delete next.patternMode;
  delete next.excludeModelPattern;
  const pattern = typeof next.modelPattern === 'string' ? next.modelPattern : '';
  const compiles = (v: string): boolean => {
    try {
      new RegExp(v, 'i');
      return true;
    } catch {
      return false;
  }
  };
  if (!hadLegacy) {
    if (compiles(pattern) || !pattern.includes('*')) return next;
    next.modelPattern = wildcardToRegexSrc(pattern);
    return next;
  }
  let src = compiles(pattern) ? pattern : wildcardToRegexSrc(pattern);
  if (exclude !== undefined) {
    const exc = compiles(exclude) ? exclude : wildcardToRegexSrc(exclude);
    const body = src.startsWith('^') ? src.slice(1) : src;
    src = `^(?![\\s\\S]*${exc})${body}`;
  }
  next.modelPattern = src;
  return next;
}

/** 消息模板渲染：{model}/{provider} 占位替换 */
export function renderMessage(template: string, use: ModelUse | null): string {
  // 函数替换器：替换值里的 $&/$' 等模式串不被当作替换模式解释
  // （模板可含这些字符，值来自 provider/model 自由文本）
  return template
    .replaceAll('{model}', () => use?.model ?? '')
    .replaceAll('{provider}', () => use?.provider ?? '');
}

/**
 * 规范化规则：填充默认值、推断触发源。
 * 输入形状由 validateRule 先验（错误类型在那边报错），此处只做语义默认，不做完整校验。
 */
export function normalizeRule(raw: Record<string, unknown>): RuleDef {
  // 缺 trigger 默认 model-call：v1 配置（只有时段+pattern 字段）无需迁移
  const hasSchedule = typeof raw.schedule === 'string' && raw.schedule.trim() !== '';
  const trigger: Trigger = raw.trigger === 'cron' || (raw.trigger === undefined && hasSchedule) ? 'cron' : 'model-call';
  return {
    id: String(raw.id ?? ''),
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : undefined,
    message: String(raw.message ?? ''),
    trigger,
    schedule: trigger === 'cron' ? String(raw.schedule ?? '') : undefined,
    modelPattern: typeof raw.modelPattern === 'string' && raw.modelPattern !== ''
      ? raw.modelPattern
      : '',
    startHour: typeof raw.startHour === 'number' ? raw.startHour : 0,
    endHour: typeof raw.endHour === 'number' ? raw.endHour : 24,
    maxPerDay: typeof raw.maxPerDay === 'number' ? raw.maxPerDay : 2,
    cooldownMinutes: typeof raw.cooldownMinutes === 'number' ? raw.cooldownMinutes : 120,
    locked: raw.locked === true ? true : undefined,
    when: typeof raw.when === 'string' && raw.when.trim() !== '' ? raw.when : undefined,
    daysOfWeek: Array.isArray(raw.daysOfWeek) && raw.daysOfWeek.length > 0
      ? raw.daysOfWeek.map((d) => Number(d))
      : undefined,
  };
}

/**
 * 编译 L2 表达式。表达式求值为真值才允许触发。
 * 为何用 new Function：when 仅来自用户自己的配置文件（与 cordis !!js 同信任级），不值得引入表达式库。
 * @param when 表达式文本，如 "use && use.model.includes('glm') && hour >= 14"
 * @returns 求值函数；when 为空返回 null（无条件门）
 * @throws 语法错误直接抛出（装载期 fail-loud）
 */
export function compileWhen(when: string | undefined): WhenFn | null {
  if (when === undefined || when.trim() === '') return null;
  // 包一层 return 使"表达式"（而非语句体）书写自然；构造期即完成语法校验（fail-loud）。
  // 不做空跑：合法表达式通常会解引用 use，而编译期 use 恒为 null；求值期异常由包装器兜底。
  const fn = new Function('use', 'hour', 'minute', 'dow', `"use strict"; return (${when});`);
  return (use, hour, minute, dow) => {
    try {
      return Boolean(fn(use, hour, minute, dow));
    } catch {
      // 求值异常按不触发处理：表达式 bug 不应刷屏打扰
      return false;
    }
  };
}

/** 取或建状态，并做跨日重置（firedToday/mutedDay/lastCronMinute 过期即清） */
function ensureFreshState(ruleId: string, states: Map<string, RuleState>, now: number): RuleState {
  const today = localDateKey(now);
  const prev = states.get(ruleId);
  if (!prev) {
    const fresh: RuleState = { enabled: true, firedToday: [] };
    states.set(ruleId, fresh);
    return fresh;
  }
  // 只保留今日数据；跨日残留（昨日计数/过期免打扰/过期分钟键）整体重建
  const todaysFires = prev.firedToday.filter(t => localDateKey(t) === today);
  const mutedDay = prev.mutedDay === today ? today : undefined;
  const cronKeyFresh = prev.lastCronMinute !== undefined && prev.lastCronMinute.startsWith(today);
  if (todaysFires.length !== prev.firedToday.length || mutedDay !== prev.mutedDay || cronKeyFresh !== (prev.lastCronMinute !== undefined)) {
    const fresh: RuleState = {
      enabled: prev.enabled,
      firedToday: todaysFires,
      mutedDay,
      lastCronMinute: cronKeyFresh ? prev.lastCronMinute : undefined,
      // 冷却基准跨日保留（见字段注释），不随日界清理
      lastFireAt: prev.lastFireAt,
    };
    states.set(ruleId, fresh);
    return fresh;
  }
  return prev;
}

/** 正则模式编译缓存（pattern 文本 → RegExp）。装载路径已由 validateRule 保证语法合法，
 *  这里缓存只为热路径（每次 llm/stream × 每条规则）免重复编译；容量上限防长期编辑膨胀 */
const regexCache = new Map<string, RegExp | null>();
function cachedRegex(pattern: string): RegExp | null {
  let re = regexCache.get(pattern);
  if (re === undefined) {
    if (regexCache.size > 64) regexCache.clear();
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      // 语法非法（理论不可达：validateRule 装载即验）：按不匹配处理，不炸观察链
      re = null;
    }
    regexCache.set(pattern, re);
  }
  return re;
}

/** 模型匹配：正则测试（i 标志，空串=匹配一切）；非法正则不匹配 */
function matchPattern(rule: Pick<RuleDef, 'modelPattern'>, value: string): boolean {
  const re = cachedRegex(rule.modelPattern ?? '');
  return re !== null && re.test(value);
}

/** model-call 条件评估（L1 结构化 + L2 when AND） */
export function evaluateModelCall(rule: RuleDef, state: RuleState, use: ModelUse, when: WhenFn | null): boolean {
  if (!state.enabled) return false;
  if (state.mutedDay !== undefined) return false;
  const at = new Date(use.at);
  const hour = at.getHours();
  // 时段门：start <= end 为常规窗口 [start, end)；start > end 为跨午夜环绕
  // （18→14 表示 18:00–23:59 与 00:00–13:59，覆盖"晚高峰到次日下午"这类窗口）
  const start = rule.startHour ?? 0;
  const end = rule.endHour ?? 24;
  const inWindow = start <= end ? hour >= start && hour < end : hour >= start || hour < end;
  if (!inWindow) return false;
  // 星期限定（0=周日..6=周六）：工作日规则如 glm 高峰提醒周末不触发
  if (rule.daysOfWeek !== undefined && !rule.daysOfWeek.includes(at.getDay())) return false;
  if (!matchPattern(rule, `${use.provider}/${use.model}`)) return false;
  if (when !== null && !when(use, hour, new Date(use.at).getMinutes(), new Date(use.at).getDay())) return false;
  return true;
}

/** 共享频控门：每日上限（按日计数）+ 冷却（跨日，基准 lastFireAt）通过才生成 Reminder 并记账 */
export function fireReminder(rule: RuleDef, state: RuleState, at: number, rendered: string): Reminder | null {
  const maxPerDay = rule.maxPerDay ?? 2;
  const cooldownMs = (rule.cooldownMinutes ?? 120) * 60_000;
  const todaysFires = state.firedToday.filter(t => localDateKey(t) === localDateKey(at));
  if (todaysFires.length >= maxPerDay) return null;
  // 冷却看全局最近一次触发（不按日过滤）：23:59 触发后 00:01 仍在冷却期内
  if (state.lastFireAt !== undefined && at - state.lastFireAt < cooldownMs) return null;
  const reminder: Reminder = { id: `${rule.id}:${at}`, ruleId: rule.id, message: rendered, firedAt: at };
  state.firedToday = [...todaysFires, at];
  state.lastFireAt = at;
  return reminder;
}

/**
 * 模型调用观察入口：对 trigger='model-call' 的规则逐条评估并触发。
 * @param compiled 预编译的 when 函数表（ruleId → WhenFn|null），由装载方构建避免每次调用重编译
 */
export function observe(rules: readonly RuleDef[], states: Map<string, RuleState>, use: ModelUse, compiled: Map<string, WhenFn | null>): Reminder[] {
  const out: Reminder[] = [];
  for (const rule of rules) {
    if (rule.trigger !== 'model-call') continue;
    const state = ensureFreshState(rule.id, states, use.at);
    if (!evaluateModelCall(rule, state, use, compiled.get(rule.id) ?? null)) continue;
    const reminder = fireReminder(rule, state, use.at, renderMessage(rule.message, use));
    if (reminder) out.push(reminder);
  }
  return out;
}

/**
 * 定时调度观察入口：对 trigger='cron' 且 schedule 命中当前分钟的规则触发（每分钟至多一次）。
 * @param specMatcher 已解析的 cron 匹配器表（ruleId → (at)=>boolean）
 */
export function observeTick(rules: readonly RuleDef[], states: Map<string, RuleState>, now: number, specMatcher: Map<string, (at: Date) => boolean>, compiled: Map<string, WhenFn | null>): Reminder[] {
  const out: Reminder[] = [];
  const d = new Date(now);
  // 分钟标识用于去重：30s tick 同一分钟内第二次评估直接跳过
  const minuteKey = `${localDateKey(now)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  for (const rule of rules) {
    if (rule.trigger !== 'cron') continue;
    const matcher = specMatcher.get(rule.id);
    if (!matcher || !matcher(d)) continue;
    const state = ensureFreshState(rule.id, states, now);
    if (!state.enabled || state.mutedDay !== undefined) continue;
    if (state.lastCronMinute === minuteKey) continue;
    // 匹配分钟即标记：被 when/频控抑制的分钟不再重复求值（when 是任意 JS，
    // 每 30s tick 重跑同一表达式纯属浪费）
    state.lastCronMinute = minuteKey;
    const when = compiled.get(rule.id) ?? null;
    if (when !== null && !when(null, d.getHours(), d.getMinutes(), d.getDay())) continue;
    const reminder = fireReminder(rule, state, now, renderMessage(rule.message, null));
    if (reminder) out.push(reminder);
  }
  return out;
}

/** 今日免打扰：将规则 mutedDay 置为当前本地日 */
export function muteRuleForToday(ruleId: string, states: Map<string, RuleState>, now: number): void {
  const state = ensureFreshState(ruleId, states, now);
  state.mutedDay = localDateKey(now);
}

/** 启停规则（规则存在性由调用方先行检查，此处只改状态） */
export function setRuleEnabled(ruleId: string, enabled: boolean, states: Map<string, RuleState>, now: number): void {
  const state = ensureFreshState(ruleId, states, now);
  state.enabled = enabled;
}
