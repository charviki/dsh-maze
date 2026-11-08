/**
 * 规则持久化：运行时（UI）编辑结果落盘到 profile 数据文件。
 *
 * 合并语义（config = cordis.patch.yml 规则，store = UI 编辑落盘）：
 * - config 是基底：同 id 的 store 规则覆盖它；
 * - locked:true 的 config 规则恒胜出（store 无法覆盖/删除/编辑它）；
 * - store.deletedIds 是墓碑：UI 删除的非锁定 config 规则 id 记入，合并时跳过；
 *   对墓碑 id 的重新 PUT（重建同名规则）会解除墓碑。
 *
 * 为何不用 dsh settings 能力：插件自持数据文件最简单、零依赖，且随 profile 迁移。
 */
import type { RuleDef } from './engine.js';
/** 空 store（装载与测试用） */
export declare function emptyStore(): {
    rules: RuleDef[];
    deletedIds: string[];
};
/**
 * 解析 profile 数据目录：<pluginDir>/../../../data/dsh-maze（node_modules/dsh-maze 上走两级即 profile 根）。
 * sanity check：profile 根必有 package.json；不满足（源码目录直接运行等场景）退化到系统临时目录，
 * 保证插件总能装载（宁可持久化位置退化也不阻断宿主）。
 */
export declare function resolveDataDir(pluginDir: string): string;
/**
 * 同步读取 store（apply 阶段调用，避免异步竞态；文件小阻塞可忽略）。
 * 文件不存在返回空集；结构损坏 throw（由调用方决定降级策略）。
 */
export declare function loadStoreSync(dataDir: string): {
    rules: RuleDef[];
    deletedIds: string[];
};
/** 原子写入（tmp + rename），避免半写文件在下次装载被当损坏 */
export declare function saveStoreSync(dataDir: string, rules: readonly RuleDef[], deletedIds: readonly string[]): void;
/**
 * 合并 config 与 store 为有效规则集。
 * locked config 规则恒胜出；墓碑 id 的 config 规则被跳过；其余同 id store 覆盖 config。
 */
export declare function mergeRules(configRules: readonly RuleDef[], storeRules: readonly RuleDef[], deletedIds: readonly string[]): RuleDef[];
/** 插件根目录（本文件编译后位于 lib/reminders/，向上两级解析 package.json 所在目录即根） */
export declare function pluginRoot(): string;
