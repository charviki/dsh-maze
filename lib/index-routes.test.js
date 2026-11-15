/**
 * index 层路由测试：PUT/DELETE 模板的落盘/失败语义（在临时插件副本上跑 apply，
 * pluginRoot 解析到临时目录，数据文件不碰仓库）。
 * @module dsh-maze/index-routes.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fakeReq = (method, url, body) => {
    const listeners = new Map();
    return {
        method, url, headers: { host: 'localhost' },
        on: (ev, cb) => { (listeners.get(ev) ?? listeners.set(ev, []).get(ev)).push(cb); },
        destroy: () => { },
        __fire: () => {
            const raw = body === undefined ? '' : JSON.stringify(body);
            for (const cb of listeners.get('data') ?? [])
                cb(Buffer.from(raw));
            for (const cb of listeners.get('end') ?? [])
                cb();
        },
    };
};
const fakeRes = () => {
    const r = { status: 0, body: '', writeHead: (s) => { r.status = s; }, end: (b) => { r.body = b ?? ''; } };
    return r;
};
/** 组装插件副本 + mock ctx，捕获全部 HTTP 路由。 */
const mount = async (config = {}) => {
    // 复刻安装布局 profileRoot/node_modules/dsh-maze：resolveDataDir 从插件目录向上
    // 找 profile 根的 package.json，扁平副本会让数据错落临时回退目录
    const root = mkdtempSync(join(tmpdir(), 'maze-routes-'));
    const tmp = join(root, 'node_modules', 'dsh-maze');
    cpSync(require.resolve('./index.js').replace(/lib\/index\.js$/, 'lib'), join(tmp, 'lib'), { recursive: true });
    cpSync(require.resolve('./index.js').replace(/lib\/index\.js$/, 'package.json'), join(tmp, 'package.json'));
    writeFileSync(join(root, 'package.json'), '{"name":"maze-route-test-profile","private":true}\n');
    // 依赖解析：插件运行时依赖（schemastery）经仓库 node_modules 符号链接进插件目录
    // （root/node_modules 已被安装布局本身占用，链接挂在 dsh-maze 内一样命中解析链）
    symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(tmp, 'node_modules'), 'dir');
    const mod = await import(join(tmp, 'lib', 'index.js'));
    const handlers = new Map();
    const disposers = [];
    // cordis effect 约定：回调返回清理函数；这里统一收窄进 disposers 供卸载
    const track = (fn) => { const d = fn(); if (typeof d === 'function')
        disposers.push(d); };
    const ctx = {
        on: () => () => { },
        effect: (fn) => track(fn),
        inject: (deps, cb) => {
            if (deps.includes('webServer')) {
                cb({
                    webServer: { register: (def) => {
                            handlers.set(def.path, def.handler);
                            return () => handlers.delete(def.path);
                        } },
                    effect: (fn) => track(fn),
                });
            }
            else if (deps.includes('commands')) {
                cb({ commands: { register: () => () => { } }, effect: (fn) => track(fn) });
            }
        },
        get: () => undefined,
        logger: { warn: () => { }, info: () => { } },
    };
    mod.apply(ctx, config);
    const dataDir = join(root, 'data', 'dsh-maze');
    return {
        dataDir,
        call: async (method, path, body) => {
            const handler = handlers.get(path);
            assert.ok(handler !== undefined, `路由未注册: ${path}`);
            const req = fakeReq(method, path, body);
            const res = fakeRes();
            const ret = handler(req, res);
            req.__fire();
            if (ret instanceof Promise)
                await ret;
            return { status: res.status, json: JSON.parse(res.body === '' ? '{}' : res.body) };
        },
        dispose: () => { for (const d of disposers)
            d(); rmSync(root, { recursive: true, force: true }); },
    };
};
const tplBody = (id, name) => ({
    id, name,
    layers: [
        { id: 'd1', name: '拆解', prompt: '拆', hosts: [] },
        { id: 'w1', name: '执行', prompt: '做', hosts: [{ hostId: 'teddy', agent: '', model: '', parallel: 1 }] },
    ],
});
test('PUT/DELETE 模板：合法落盘、非法 400、未知删除 404、失败不改内存', async () => {
    const h = await mount();
    try {
        // 合法 PUT：200 + 落盘 narratives.json
        let out = await h.call('PUT', '/maze/narratives/template', { template: tplBody('t1', '测试线') });
        assert.equal(out.status, 200);
        assert.ok(existsSync(join(h.dataDir, 'narratives.json')));
        // 非法 PUT：400 带错误说明，且不落盘（内容不变）
        out = await h.call('PUT', '/maze/narratives/template', { template: { id: 'bad', name: '', layers: [] } });
        assert.equal(out.status, 400);
        assert.ok(String(out.json.error).includes('name'));
        // 未知删除：404
        out = await h.call('DELETE', '/maze/narratives/template', { templateId: 'nope' });
        assert.equal(out.status, 404);
        // 落盘失败（数据目录只读）：PUT 回 500，且内存态不变——GET 里 t1 仍在、坏模板未混入。
        // chmod 恢复放 finally：断言中途抛错时只读目录会让 rmSync 失败，泄漏临时目录并掩盖真因
        chmodSync(h.dataDir, 0o500);
        try {
            out = await h.call('PUT', '/maze/narratives/template', { template: tplBody('t2', '失败线') });
            assert.equal(out.status, 500);
            out = await h.call('GET', '/maze/narratives/state');
            const ids = (out.json.templates ?? []).map((t) => t.id);
            assert.ok(ids.includes('t1'));
            assert.ok(!ids.includes('t2'));
        }
        finally {
            chmodSync(h.dataDir, 0o700);
        }
    }
    finally {
        h.dispose();
    }
});
test('容量与撞名：超上限 400、名字撞已有 id 400、正常补充 200', async () => {
    const h = await mount();
    try {
        // 内置 3 条占额，NARRATIVES_MAX=12：再灌 9 条到顶
        for (let i = 0; i < 9; i++) {
            const out = await h.call('PUT', '/maze/narratives/template', { template: tplBody(`c${i}`, `容量线${i}`) });
            assert.equal(out.status, 200, `第 ${i} 条应成功`);
        }
        // 第 10 条：400 超上限
        let out = await h.call('PUT', '/maze/narratives/template', { template: tplBody('c9', '超限线') });
        assert.equal(out.status, 400);
        assert.ok(String(out.json.error).includes('上限'));
        // 释放一个额度（删一条自定义），让后续用例能越过容量门、打到目标检查
        out = await h.call('DELETE', '/maze/narratives/template', { templateId: 'c0' });
        assert.equal(out.status, 200);
        // 名字撞已有模板 id：400（防 merge 层名-id 交叉冲突变成 500）
        out = await h.call('PUT', '/maze/narratives/template', { template: tplBody('fresh', 'feature-line') });
        assert.equal(out.status, 400);
        assert.ok(String(out.json.error).includes('冲突'));
        // 空出的额度可以补新条目
        out = await h.call('PUT', '/maze/narratives/template', { template: tplBody('c9', '超限线') });
        assert.equal(out.status, 200);
        // 落盘核验：c0 是 store 来源，删除=从 store 移除（无墓碑——墓碑只防 config/内置复活）；
        // c9 在盘上
        const disk = JSON.parse(readFileSync(join(h.dataDir, 'narratives.json'), 'utf8'));
        assert.equal(disk.deletedIds.includes('c0'), false);
        assert.equal(disk.templates.some((t) => t.id === 'c0'), false);
        assert.ok(disk.templates.some((t) => t.id === 'c9'));
    }
    finally {
        h.dispose();
    }
});
test('内置模板删除=墓碑；同 id PUT 复活', async () => {
    const h = await mount();
    try {
        let out = await h.call('DELETE', '/maze/narratives/template', { templateId: 'fix-line' });
        assert.equal(out.status, 200);
        out = await h.call('GET', '/maze/narratives/state');
        const ids = (out.json.templates ?? []).map((t) => t.id);
        assert.ok(!ids.includes('fix-line'), '墓碑后内置不可见');
        // 同 id PUT：墓碑解除，自定义形态顶上
        out = await h.call('PUT', '/maze/narratives/template', { template: tplBody('fix-line', '自定义修复线') });
        assert.equal(out.status, 200);
        const disk = JSON.parse(readFileSync(join(h.dataDir, 'narratives.json'), 'utf8'));
        assert.equal(disk.deletedIds.includes('fix-line'), false, '复活清墓碑');
    }
    finally {
        h.dispose();
    }
});
