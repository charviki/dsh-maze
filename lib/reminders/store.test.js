import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { loadStoreSync, mergeRules, resolveDataDir, saveStoreSync } from './store.js';
import { normalizeRule } from './engine.js';
const rule = (id, over = {}) => normalizeRule({ id, message: `msg-${id}`, ...over });
test('mergeRules：store 覆盖 config 同 id，locked config 恒胜出，墓碑跳过 config 规则', () => {
    const config = [
        rule('a'),
        rule('b', { locked: true }),
        rule('c'),
    ];
    const store = [
        rule('a', { message: 'edited' }), // 覆盖非锁定 config 规则
        rule('b', { message: 'hack' }), // 试图覆盖锁定规则 → 忽略
        rule('d'), // UI 新增
    ];
    const merged = mergeRules(config, store, ['c']); // c 被 UI 删除（墓碑）
    const byId = new Map(merged.map(r => [r.id, r]));
    assert.equal(byId.get('a').message, 'edited');
    assert.equal(byId.get('b').message, 'msg-b'); // config 锁定版胜出
    assert.equal(byId.has('c'), false); // 墓碑生效
    assert.equal(byId.has('d'), true);
});
test('mergeRules：locked 规则不受墓碑影响', () => {
    const config = [rule('x', { locked: true })];
    const merged = mergeRules(config, [], ['x']);
    assert.equal(merged.length, 1); // UI 无法删除锁定规则，墓碑被无视
});
test('loadStoreSync / saveStoreSync：往返持久化', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-maze-store-'));
    try {
        assert.equal(loadStoreSync(dir).rules.length, 0); // 不存在 → 空集
        saveStoreSync(dir, [rule('a'), rule('b')], ['c']);
        const loaded = loadStoreSync(dir);
        assert.deepEqual(loaded.rules.map(r => r.id), ['a', 'b']);
        assert.deepEqual(loaded.deletedIds, ['c']);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('loadStoreSync：损坏文件抛出', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-maze-store-'));
    try {
        writeFileSync(join(dir, 'rules.json'), '{"version":9}', 'utf8');
        assert.throws(() => loadStoreSync(dir), /结构不合法/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('resolveDataDir：profile 根含 package.json 时落 profile data，否则回落 tmp', () => {
    const fakeProfile = mkdtempSync(join(tmpdir(), 'dsh-maze-profile-'));
    try {
        // 真实布局：profile/node_modules/dsh-maze/lib/reminders/store.js；生产代码传入
        // pluginRoot()=包根，上走两级恰好到 profile 根（walk 量与 lib 深度解耦）
        mkdirSync(join(fakeProfile, 'node_modules', 'dsh-maze', 'lib', 'reminders'), { recursive: true });
        writeFileSync(join(fakeProfile, 'package.json'), '{}', 'utf8');
        assert.equal(resolveDataDir(join(fakeProfile, 'node_modules', 'dsh-maze')), join(fakeProfile, 'data', 'dsh-maze'));
        // pnpm 软链布局（市场安装）：realpath 落在 .pnpm/<hash>/node_modules/dsh-maze，
        // 固定两级只到 .pnpm 内层（无 package.json）；逐级上找须穿过 .pnpm 命中 profile 根
        const pnpmStore = join(fakeProfile, 'node_modules', '.pnpm', 'dsh-maze@0.18.2', 'node_modules', 'dsh-maze');
        mkdirSync(pnpmStore, { recursive: true });
        assert.equal(resolveDataDir(pnpmStore), join(fakeProfile, 'data', 'dsh-maze'));
        // 无 package.json 的目录树 → 回落进程私有 mkdtemp 目录（前缀 dsh-maze-，
        // 属主必为当前用户：固定路径回落目录在多用户主机上可被他人预置）
        const orphan = mkdtempSync(join(tmpdir(), 'dsh-maze-orphan-'));
        try {
            const fallback = resolveDataDir(orphan);
            assert.ok(basename(fallback).startsWith('dsh-maze-'), `回落应为 mkdtemp 私有目录: ${fallback}`);
            assert.ok(existsSync(fallback));
            rmSync(fallback, { recursive: true, force: true });
        }
        finally {
            rmSync(orphan, { recursive: true, force: true });
        }
    }
    finally {
        rmSync(fakeProfile, { recursive: true, force: true });
    }
});
test('loadStoreSync：store 条目过完整校验（坏 cron 整体 throw，由调用方降级）', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-maze-store-'));
    try {
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'rules.json'), JSON.stringify({
            version: 1,
            // normalizeRule 不校验 cron 表达式；validateRule 保证装载期暴露
            rules: [{ id: 'bad', message: 'x', trigger: 'cron', schedule: '99 * * * *' }],
            deletedIds: [],
        }), 'utf8');
        assert.throws(() => loadStoreSync(root), /越界/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
