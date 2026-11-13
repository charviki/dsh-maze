/**
 * 规则校验（装载 config 与 PUT 路由与 store 装载三方共用）：
 * 先验原始形状再 normalizeRule 补默认值，违反即 throw，错误信息带字段名。
 * 独立成文件原因：index.ts（插件主体）与 store.ts（装载路径）都要用，
 * 放回 engine.ts 会把 cron 解析拖进纯引擎。
 */

import { parseCron } from './cron.js';
import { compileWhen, migrateRuleInput, normalizeRule, type RuleDef } from './engine.js';

/** 校验选项：when/locked 是文件级信任（用户自己的 config/store），HTTP 来源一律拒绝 */
export interface ValidateRuleOptions {
  /** 允许 when 表达式（config/store 文件装载路径设 true；HTTP PUT/preview 不设） */
  allowWhen?: boolean;
  /** 允许 locked 标记（config/store 文件装载路径设 true；HTTP PUT 不设，防注入删不掉的规则） */
  allowLocked?: boolean;
}

/** 校验单条规则（输入为任意 JSON 反序列化形状），返回规范化后的定义 */
export function validateRule(raw: unknown, opts: ValidateRuleOptions = {}): RuleDef {
  // PUT 路由的 body / 手改的 store 文件都来自 JSON 反序列化，这里做一次形状收敛；
  // 旧匹配字段（patternMode/excludeModelPattern）先迁移成正则-only 形态再校验
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('规则必须是对象');
  const r = migrateRuleInput(raw as Record<string, unknown>);

  // 触发源先验原始值：拼错的 trigger（如 'corn'）不得被 normalize 静默归为 model-call
  if (r.trigger !== undefined && r.trigger !== 'model-call' && r.trigger !== 'cron') {
    throw new Error('规则 trigger 必须是 "model-call" 或 "cron"');
  }

  // 字符串字段先验原始类型：错误类型应报错而非被 String() 静默强转
  const stringFields: Array<[string, unknown]> = [
    ['id', r.id],
    ['message', r.message],
    ['name', r.name],
    ['schedule', r.schedule],
    ['modelPattern', r.modelPattern],
  ];
  for (const [field, value] of stringFields) {
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`规则 ${typeof r.id === 'string' ? r.id : '?'} 的 ${field} 必须是字符串`);
    }
  }

  // 数值字段先验原始类型与整数性：错误类型（如 startHour:"9"、maxPerDay:1.5）
  // 应报错而非被默认值静默替换（cooldown 允许任意有限数，其余须为整数）
  const numericFields: Array<[string, unknown, boolean]> = [
    ['startHour', r.startHour, true],
    ['endHour', r.endHour, true],
    ['maxPerDay', r.maxPerDay, true],
    ['cooldownMinutes', r.cooldownMinutes, false],
  ];
  for (const [field, value, needInteger] of numericFields) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || (needInteger && !Number.isInteger(value))) {
      throw new Error(`规则 ${typeof r.id === 'string' ? r.id : '?'} 的 ${field} 必须为${needInteger ? '整数' : '有限数'}`);
    }
  }

  // 类型先行：when:true / locked:"true" 这类形状错误要报错，不能等
  // normalizeRule 的 typeof 守卫静默吞掉（fail-loud 优先于信任边界判断）
  if (r.when !== undefined && typeof r.when !== 'string') {
    throw new Error('规则的 when 必须是表达式字符串');
  }
  if (r.locked !== undefined && typeof r.locked !== 'boolean') {
    throw new Error('规则的 locked 必须为布尔值');
  }
  // 信任边界：when 表达式经 new Function 在宿主进程执行，只信任用户自己的文件
  // （config / store），HTTP 来源（PUT / preview）携带 when 一律拒绝
  if (r.when !== undefined && r.when !== '' && !opts.allowWhen) {
    throw new Error('when 表达式仅允许在配置文件 / store 数据文件中使用');
  }
  // locked 是 config 作者特权：HTTP 注入 locked:true 会造出删不掉的规则
  if (r.locked === true && !opts.allowLocked) {
    throw new Error('locked 标记仅允许在配置文件中使用');
  }

  // 匹配正则装载即编译：语法错误当场暴露（i 标志；空串=匹配一切，合法）
  if (typeof r.modelPattern === 'string' && r.modelPattern !== '') {
    try {
      new RegExp(r.modelPattern, 'i');
    } catch (err) {
      throw new Error(`规则 ${typeof r.id === 'string' ? r.id : '?'} 的 modelPattern 不是合法正则：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const rule = normalizeRule(r);
  if (rule.id === '') throw new Error('规则缺少 id');
  if (rule.message === '') throw new Error(`规则 ${rule.id} 缺少 message`);
  const hourFields: Array<[string, number | undefined, number, number]> = [['startHour', rule.startHour, 0, 24], ['endHour', rule.endHour, 0, 24]];
  for (const [field, value, lo, hi] of hourFields) {
    if (value === undefined || !Number.isInteger(value) || value < lo || value > hi) {
      throw new Error(`规则 ${rule.id} ${field} 必须为 ${lo}-${hi} 的整数`);
    }
  }
  // normalizeRule 语义上必填默认值，但类型仍可选（RuleDef 服务于部分形状的配置）——比较处用 ?? 收敛。
  // startHour > endHour 是合法的跨午夜窗口（18→14 = 18:00 到次日 13:59）；相等则窗口为空，按配置错误拒绝
  if ((rule.startHour ?? 0) === (rule.endHour ?? 24)) {
    throw new Error(`规则 ${rule.id} startHour 与 endHour 不能相等（全天生效请用 0–24）`);
  }
  if (rule.trigger === 'cron') {
    // cron 规则装载即解析，表达式错误当场暴露
    parseCron(rule.schedule ?? '');
  }
  if ((rule.maxPerDay ?? 2) < 1) throw new Error(`规则 ${rule.id} maxPerDay 必须 ≥1`);
  if ((rule.cooldownMinutes ?? 120) < 0) throw new Error(`规则 ${rule.id} cooldownMinutes 必须 ≥0`);
  // 星期限定（原始值检查，normalizeRule 之后只见收敛过的数组）：
  // 元素须为 0-6 整数（0=周日，JS getDay 语义）；空数组=永不触发，按配置错误拒绝
  if (r.daysOfWeek !== undefined) {
    if (!Array.isArray(r.daysOfWeek)) throw new Error(`规则 ${rule.id} daysOfWeek 必须是数字数组`);
    if (r.daysOfWeek.length === 0) throw new Error(`规则 ${rule.id} daysOfWeek 不能为空数组（不限请省略该字段）`);
    for (const d of r.daysOfWeek) {
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) {
        throw new Error(`规则 ${rule.id} daysOfWeek 元素必须是 0-6 整数（0=周日）`);
      }
    }
  }
  if (rule.when !== undefined) {
    // L2 表达式装载即编译：语法错误 fail-loud
    compileWhen(rule.when);
  }
  return rule;
}
