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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { validateRule } from './validate.js';
/** 空 store（装载与测试用） */
export function emptyStore() {
    return { rules: [], deletedIds: [] };
}
/**
 * 解析 profile 数据目录：<pluginDir>/../../../data/dsh-maze（node_modules/dsh-maze 上走两级即 profile 根）。
 * sanity check：profile 根必有 package.json；不满足（源码目录直接运行等场景）退化到系统临时目录，
 * 保证插件总能装载（宁可持久化位置退化也不阻断宿主）。
 */
export function resolveDataDir(pluginDir) {
    // 安装布局有两种，向上找第一个含 package.json 的目录都能命中 profile 根：
    // - 拷贝布局（dsh plugin add file:）：node_modules/dsh-maze 上走两级即 profile 根
    // - pnpm 软链布局（市场安装）：realpath 落在 node_modules/.pnpm/<hash>/node_modules/
    //   dsh-maze，固定两级只到 .pnpm 内层（无 package.json），数据会错落临时目录
    let dir = pluginDir;
    for (let i = 0; i < 8 && dirname(dir) !== dir; i++) {
        dir = dirname(dir);
        if (existsSync(join(dir, 'package.json')))
            return join(dir, 'data', 'dsh-maze');
    }
    // 回落用进程私有临时目录（mkdtemp 保证属主当前用户且与他人不共享）：固定路径的
    // 回落目录在多用户主机上可被其他本地用户预置，配合 when 编译等同代码执行入口
    return mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'dsh-maze-'));
}
/**
 * 同步读取 store（apply 阶段调用，避免异步竞态；文件小阻塞可忽略）。
 * 文件不存在返回空集；结构损坏 throw（由调用方决定降级策略）。
 */
export function loadStoreSync(dataDir) {
    const file = join(dataDir, 'rules.json');
    if (!existsSync(file))
        return emptyStore();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw.version !== 1 || !Array.isArray(raw.rules) || !Array.isArray(raw.deletedIds)) {
        throw new Error(`dsh-maze store 结构不合法: ${file}`);
    }
    // 墓碑元素必须是字符串：数字/对象进 Set 后与字符串 id 永不匹配，墓碑语义错乱
    if (!raw.deletedIds.every(id => typeof id === 'string')) {
        throw new Error(`dsh-maze store deletedIds 含非字符串条目: ${file}`);
    }
    return {
        // store 条目同样过完整校验：store 是持久化文件（可能被手改），损坏即整体
        // throw，由调用方降级到纯 config 规则集（宁丢运行时编辑不炸装载）。
        // when/locked 在此放行：store 与 config 同为用户自己的本地文件（同信任级）
        rules: raw.rules.map(r => validateRule(r, { allowWhen: true, allowLocked: true })),
        deletedIds: [...raw.deletedIds],
    };
}
/** 原子写入（tmp + rename），避免半写文件在下次装载被当损坏 */
export function saveStoreSync(dataDir, rules, deletedIds) {
    const file = join(dataDir, 'rules.json');
    const tmp = `${file}.tmp`;
    const payload = { version: 1, rules: [...rules], deletedIds: [...deletedIds] };
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
}
/**
 * 合并 config 与 store 为有效规则集。
 * locked config 规则恒胜出；墓碑 id 的 config 规则被跳过；其余同 id store 覆盖 config。
 */
export function mergeRules(configRules, storeRules, deletedIds) {
    const lockedIds = new Set(configRules.filter(r => r.locked === true).map(r => r.id));
    const tombstones = new Set(deletedIds);
    const merged = new Map();
    for (const r of configRules) {
        // locked 规则不受墓碑影响（UI 本就无法删除它们）；普通 config 规则被墓碑即视为已删除
        if (r.locked !== true && tombstones.has(r.id))
            continue;
        merged.set(r.id, r);
    }
    for (const r of storeRules) {
        // locked 规则的运行时覆盖一律忽略（含 UI 尝试篡改 locked 本身的写入）
        if (lockedIds.has(r.id))
            continue;
        merged.set(r.id, r);
    }
    return [...merged.values()];
}
/** 插件根目录（本文件编译后位于 lib/reminders/，向上两级解析 package.json 所在目录即根） */
export function pluginRoot() {
    const req = createRequire(import.meta.url);
    return dirname(req.resolve('../../package.json'));
}
