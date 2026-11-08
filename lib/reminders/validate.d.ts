/**
 * 规则校验（装载 config 与 PUT 路由与 store 装载三方共用）：
 * 先验原始形状再 normalizeRule 补默认值，违反即 throw，错误信息带字段名。
 * 独立成文件原因：index.ts（插件主体）与 store.ts（装载路径）都要用，
 * 放回 engine.ts 会把 cron 解析拖进纯引擎。
 */
import { type RuleDef } from './engine.js';
/** 校验选项：when/locked 是文件级信任（用户自己的 config/store），HTTP 来源一律拒绝 */
export interface ValidateRuleOptions {
    /** 允许 when 表达式（config/store 文件装载路径设 true；HTTP PUT/preview 不设） */
    allowWhen?: boolean;
    /** 允许 locked 标记（config/store 文件装载路径设 true；HTTP PUT 不设，防注入删不掉的规则） */
    allowLocked?: boolean;
}
/** 校验单条规则（输入为任意 JSON 反序列化形状），返回规范化后的定义 */
export declare function validateRule(raw: unknown, opts?: ValidateRuleOptions): RuleDef;
