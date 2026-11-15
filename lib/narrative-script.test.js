/**
 * 启程消息合成测试：紧凑规格（当前会话拆解 + 预计算数字 + 无概念教学）。
 * @module dsh-maze/narrative-script.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_TEMPLATES } from './narratives.js';
import { agentOptsLiteral, buildScriptSkeleton, composeNarrativeMessage } from './narrative-script.js';
const tpl = (id) => {
    const t = BUILTIN_TEMPLATES.find(x => x.id === id);
    if (t === undefined)
        throw new Error(`missing builtin ${id}`);
    return t;
};
/** 接待员名查询：hosts 名册的宿主替身。 */
const hostOf = (hostId) => ({ dolores: 'Dolores', teddy: 'Teddy', maeve: 'Maeve', bernard: 'Bernard', william: 'William' }[hostId] ?? hostId);
test('composeNarrativeMessage：紧凑规格（标题/当前会话第一步/预计算上限/确认门/骨架）', () => {
    const msg = composeNarrativeMessage(tpl('feature-line'), hostOf, '给设置页加导出按钮');
    assert.ok(msg.includes('【功能开发线】目标：给设置页加导出按钮')); // 标题 + 目标一行
    assert.ok(msg.includes('第一步（当前会话，先停下等确认）')); // 基石+拆解在当前会话
    assert.ok(msg.includes('明确任务：目标 / 范围 / 验收')); // 任务说明结构
    assert.ok(msg.includes('不超过 2 个可并行的子任务')); // 拆解上限预计算（实现环 Teddy 并行 2）
    assert.ok(msg.includes('"goal": "...", "files": [...], "accept": "..."')); // 子任务输出 schema
    assert.ok(msg.includes('实现（Teddy，最多 2 路并行）')); // 执行环节列表 + 预计算并行
    assert.ok(msg.includes('质检（Maeve，最多 1 路并行）'));
    assert.ok(!msg.includes('收束')); // v0.0.6：质检收尾（无独立收束环）
    assert.ok(msg.includes('workflow')); // 编排工具指令
    assert.ok(msg.includes('```js')); // 骨架代码块
    assert.ok(!msg.includes('卡')); // 不教「卡」概念
    assert.ok(!msg.includes('并行总容量')); // 不留算术指令
});
test('composeNarrativeMessage：goal 为空 = 纯会话总结（仍有确认门）', () => {
    const msg = composeNarrativeMessage(tpl('feature-line'), hostOf, '');
    assert.ok(msg.includes('未给目标：从当前对话提炼'));
    assert.ok(msg.includes('先停下等确认'));
});
test('composeNarrativeMessage：三种故事线各含自身环名；评审线多接待员轮转', () => {
    for (const id of ['feature-line', 'review-panel', 'fix-line']) {
        const t = tpl(id);
        const msg = composeNarrativeMessage(t, hostOf, 'x');
        for (const layer of t.layers) {
            // 首环（当前会话）的名字不进消息：只校验执行环节名
            if (t.layers.indexOf(layer) > 0)
                assert.ok(msg.includes(layer.name), `${id} 缺环 ${layer.name}`);
        }
    }
    // 评审线：panel 环三位接待员（各并行 1）→ 上限 3、名单全列
    const msg = composeNarrativeMessage(tpl('review-panel'), hostOf, 'x');
    assert.ok(msg.includes('评审（Teddy / Maeve / Bernard，最多 3 路并行）'));
    assert.ok(msg.includes('不拆分子任务')); // 评审线不拆分
    assert.ok(!msg.includes('不超过')); // 不拆分=无上限话术
    assert.ok(!msg.includes('"goal": "..."')); // 不拆分=无子任务 schema
});
test('composeNarrativeMessage：回溯按环配置（退回目标环名 + 轮数 + verdicts + ocr skill）', () => {
    const msg = composeNarrativeMessage(tpl('fix-line'), hostOf, 'x');
    assert.ok(msg.includes('退回「修复」重做（≤2 轮）'));
    assert.ok(msg.includes('verdicts'));
    assert.ok(msg.includes('open-code-review-delegate')); // 质检 skill 指令
});
test('composeNarrativeMessage：单环故事线不启编排（清单即交付）', () => {
    const msg = composeNarrativeMessage({
        id: 'solo', name: '单环线', goalHint: 'h',
        layers: [{ id: 'only', name: '拆解', prompt: '拆成子任务', hosts: [] }],
    }, hostOf, 'x');
    assert.ok(msg.includes('无需编排'));
    assert.ok(!msg.includes('```js'));
    assert.ok(!msg.includes('workflow'));
});
test('agentOptsLiteral：空配置省略覆盖（继承环境默认；JSON 转义防引号破坏字面量）', () => {
    assert.equal(agentOptsLiteral({ label: 'Teddy' }), '{ label: "Teddy" }');
    assert.equal(agentOptsLiteral({ label: 'Maeve', provider: 'codex' }), '{ label: "Maeve", provider: "codex" }');
    assert.equal(agentOptsLiteral({ label: 'Teddy', model: 'glm-5.3' }), '{ label: "Teddy", model: "glm-5.3" }');
    assert.equal(agentOptsLiteral({ label: 'William', provider: 'codex', model: 'o4-mini' }), '{ label: "William", provider: "codex", model: "o4-mini" }');
    // 含单引号的值不再产出坏 JS（JSON.stringify 双引号包裹，内部单引号原样安全）
    assert.equal(agentOptsLiteral({ label: "O'Brien" }), '{ label: "O\'Brien" }');
});
test('buildScriptSkeleton：执行环展开（brief 常量/pipeline/质检回溯循环/收束）', () => {
    const skeleton = buildScriptSkeleton(tpl('feature-line'), hostOf);
    assert.ok(skeleton.includes("const brief = '<任务说明：目标/范围/验收>'")); // 任务说明常量
    assert.ok(skeleton.includes('let out = [ /* 确认后的子任务 */ ]')); // 子任务占位
    assert.ok(skeleton.includes('《功能开发线》· 实现')); // phase 标记
    assert.ok(skeleton.includes('《功能开发线》· 质检'));
    assert.ok(!skeleton.includes('《功能开发线》· 收束')); // 无收束环；质检为末环仍附加 summary
    assert.ok(skeleton.includes('await pipeline(out')); // 工作环 pipeline
    assert.ok(skeleton.includes('while (failed(review_review).length > 0 && rounds_review < 2)')); // 回溯循环（变量按环 id 后缀）
    assert.ok(skeleton.includes('let rounds_review = 0')); // 回溯计数器声明（防照抄 ReferenceError）
    assert.ok(skeleton.includes('redo("实现"')); // 退回目标环名（jsStr 双引号形态）
    assert.ok(skeleton.includes('const summary_review')); // 末环收束（同环后缀，跨环不撞名）
    assert.ok(!skeleton.includes('《功能开发线》· 拆解')); // 首环 phase 不进骨架（当前会话执行）
});
test('buildScriptSkeleton + compose：不拆分模板（评审线）单任务全员处理', () => {
    const t = tpl('review-panel');
    const sk = buildScriptSkeleton(t, hostOf);
    assert.ok(sk.includes("let out = [ { goal: '<整个任务：目标/范围/验收>' } ]")); // 单任务占位
    assert.ok(sk.includes('out.length === 1 ? await Promise.all(o1.map(o => agent(review(out[0]), o)))')); // 全员各审一遍
    assert.ok(sk.includes('《多视角评审线》· 裁决')); // 末环裁决
});
test('buildScriptSkeleton：单环返回空串（不启编排）', () => {
    const skeleton = buildScriptSkeleton({
        id: 'solo', name: '单环线', goalHint: 'h',
        layers: [{ id: 'only', name: '拆解', prompt: 'p', hosts: [] }],
    }, hostOf);
    assert.equal(skeleton, '');
});
test('buildScriptSkeleton：双质检环骨架合法（变量按环后缀，无重复声明）', () => {
    const skeleton = buildScriptSkeleton({
        id: 'double-q', name: '双质检线', goalHint: 'h',
        layers: [
            { id: 'design', name: '拆解', prompt: 'p', hosts: [] },
            { id: 'work', name: '实现', prompt: 'p', hosts: [{ hostId: 'teddy', agent: '', model: '', parallel: 2 }] },
            { id: 'check1', name: '质检', prompt: 'p', hosts: [{ hostId: 'maeve', agent: '', model: '', parallel: 1 }], retry: { toLayerId: 'work', maxRounds: 2 } },
            { id: 'check2', name: '复审', prompt: 'p', hosts: [{ hostId: 'bernard', agent: '', model: '', parallel: 1 }], retry: { toLayerId: 'check1', maxRounds: 1 } },
        ],
    }, hostOf);
    // 两条质检环各自声明独立变量：不后缀会生成两处 const review（骨架照抄即 SyntaxError）
    assert.ok(skeleton.includes('const review_check1 ='));
    assert.ok(skeleton.includes('const review_check2 ='));
    assert.ok(skeleton.includes('let rounds_check1 = 0'));
    assert.ok(skeleton.includes('let rounds_check2 = 0'));
    // 骨架整体是合法 JS 声明形态：同名 const/let 各只出现一次
    const names = [...skeleton.matchAll(/(?:const|let) (review_\w+|rounds_\w+|summary_\w+)/g)].map((m) => m[1]);
    assert.equal(new Set(names).size, names.length, `重复声明: ${names.join(',')}`);
});
test('buildScriptSkeleton：多接待员质检环轮转（check/wrap 不再硬编码第一位）', () => {
    const skeleton = buildScriptSkeleton({
        id: 'multi-q', name: '多质检线', goalHint: 'h',
        layers: [
            { id: 'design', name: '拆解', prompt: 'p', hosts: [] },
            { id: 'work', name: '实现', prompt: 'p', hosts: [{ hostId: 'teddy', agent: '', model: '', parallel: 1 }] },
            { id: 'audit', name: '质检', prompt: 'p', hosts: [
                    { hostId: 'maeve', agent: '', model: '', parallel: 1 },
                    { hostId: 'bernard', agent: '', model: '', parallel: 1 },
                ], retry: { toLayerId: 'work', maxRounds: 1 } },
        ],
    }, hostOf);
    // 声明了接待员数组就必须消费：check 用 o2[0]、末环 wrap 用 o2[1]（轮转），不再丢弃第二位
    // （audit 是第 2 执行环，数组变量名为 o2）
    assert.ok(skeleton.includes('const o2 = ['));
    assert.ok(skeleton.includes('const review_audit = await agent(check(out), o2[0])'));
    assert.ok(skeleton.includes('const summary_audit = await agent(wrap(out, review_audit), o2[1])'));
});
