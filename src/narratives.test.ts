/**
 * 故事线模板（统一环模型）校验与合并语义测试。
 * @module dsh-maze/narratives.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_TEMPLATE_IDS, BUILTIN_TEMPLATES, NARRATIVES_MAX, assembleNarrativeTemplates, migrateLegacyTemplate, mergeNarratives, storylinesVersion, validateNarrativeTemplate } from './narratives.js';

test('validateNarrativeTemplate：首环（当前会话执行）actors 可为空，非首环必须非空', () => {
  const base = {
    id: 'ring0-empty', name: '首环空', goalHint: '',
    layers: [
      { id: 'split', name: '拆解', prompt: '拆', hosts: [] },
      { id: 'work', name: '实现', prompt: '做', hosts: [{ hostId: 'teddy', agent: '', model: '', parallel: 1 }] },
    ],
  };
  validateNarrativeTemplate(base);                                     // 首环空 = 合法
  const bad = structuredClone(base);
  bad.layers[1]!.hosts = [];
  assert.throws(() => validateNarrativeTemplate(bad), /非空数组/);      // 执行环空 = 拒绝
});

test('内置提示词不含「卡」概念（模型侧只认识子任务）', () => {
  assert.ok(!JSON.stringify(BUILTIN_TEMPLATES).includes('卡'));
});
import { loadNarrativesSync, narrativesPathOf, saveNarrativesSync } from './narrative-store.js';

/** 最小合法模板工厂（单环直通，逐项用例在其上覆写坏值）。 */
function baseTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'custom-line',
    name: '自定义线',
    goalHint: '提示',
    layers: [
      { id: 'act1', name: '执行', prompt: '做事', hosts: [{ hostId: 'dolores', agent: '', model: '', parallel: 1 }] },
    ],
    ...overrides,
  };
}

test('validateNarrativeTemplate：最小形状通过并 trim 名字', () => {
  const tpl = validateNarrativeTemplate(baseTemplate({ name: '  自定义线  ' }));
  assert.equal(tpl.name, '自定义线');
  assert.equal(tpl.layers.length, 1);
  assert.deepEqual(tpl.layers[0].hosts, []); // 首环固定当前会话执行：配了接待员也归一丢弃
  assert.equal(tpl.builtin, undefined);
});

test('validateNarrativeTemplate：旧 kind 字段被自然剥离（不报错不保留）', () => {
  const tpl = validateNarrativeTemplate(baseTemplate({ layers: [
    { id: 'act1', name: '执行', kind: 'work', prompt: '做事', hosts: [{ hostId: 'dolores', agent: '', model: '', parallel: 1 }] },
  ] }));
  assert.equal('kind' in tpl.layers[0], false);
});

test('validateNarrativeTemplate：内置三条出厂可用（环序完整）', () => {
  for (const tpl of BUILTIN_TEMPLATES) {
    assert.deepEqual(validateNarrativeTemplate({ ...tpl }), tpl);
    assert.ok(tpl.layers.length >= 2, `${tpl.id} 环数`);
  }
  const feature = BUILTIN_TEMPLATES.find(t => t.id === 'feature-line');
  assert.ok(feature !== undefined);
  const featureNow = BUILTIN_TEMPLATES.find(t => t.id === 'feature-line')!;
  assert.deepEqual(featureNow.layers.map(l => l.id), ['design', 'build', 'review']); // v0.0.6：去收束环、实现并行 2
  assert.equal(featureNow.layers[0].hosts.length, 0); // 拆解环=当前会话
  assert.equal(featureNow.layers[1].hosts[0].parallel, 2);
  const panel = BUILTIN_TEMPLATES.find(t => t.id === 'review-panel')!;
  assert.equal(panel.decompose, false); // 评审线不拆分
  assert.deepEqual(panel.layers.map(l => l.id), ['scope', 'panel', 'verdict']);
  assert.equal(panel.layers[1].hosts.length, 3); // 三位评审各自一遍
  const check = feature.layers[2];
  assert.ok(check.retry !== undefined && check.retry.toLayerId === 'build');
});

test('validateNarrativeTemplate：回溯放宽——任何非首环可配（含末环终审）', () => {
  const tpl = validateNarrativeTemplate(baseTemplate({ layers: [
    { id: 'a1', name: '拆解', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }] },
    { id: 'a2', name: '处理', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }] },
    { id: 'a3', name: '终审', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }], retry: { toLayerId: 'a2', maxRounds: 1 } },
  ] }));
  assert.equal(tpl.layers[2].retry?.toLayerId, 'a2');
});

test('validateNarrativeTemplate：逐项非法拒绝', () => {
  const bad: Record<string, unknown>[] = [
    baseTemplate({ id: 'Custom' }),           // id 大写
    baseTemplate({ name: '' }),               // 名字空
    baseTemplate({ name: 'x'.repeat(25) }),   // 名字超长
    baseTemplate({ name: '《书名号》' }),       // 名字禁书名号（防污染场次解析）
    baseTemplate({ goalHint: 'x'.repeat(161) }),
    baseTemplate({ layers: [] }),             // 空环序
    baseTemplate({ layers: 'x' }),            // 环序非数组
    baseTemplate({ layers: [{ id: 'a1', name: '执行', prompt: '', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }] }] }), // 提示词空
    baseTemplate({ layers: [
      { id: 'a1', name: '拆解', prompt: 'x', hosts: [] },
      { id: 'a2', name: '执行', prompt: 'x', hosts: [] },
    ] }),   // 接待员表空（执行环）
    baseTemplate({ layers: [{ id: 'a1', name: '执行', prompt: 'x', hosts: [{ hostId: '', agent: '', model: '', parallel: 1 }] }] }), // hostId 空
    baseTemplate({ layers: [{ id: 'a1', name: '执行', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 0 }] }] }), // 并行 0
    baseTemplate({ layers: [{ id: 'a1', name: '执行', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 9 }] }] }),  // 并行 9
    baseTemplate({ layers: [{ id: 'a1', name: '执行', prompt: 'x', hosts: [{ hostId: 'd', agent: 'a\nb', model: '', parallel: 1 }] }] }), // agent 换行
    // 首环不可回溯（没有更早目标）
    baseTemplate({ layers: [
      { id: 'a1', name: '拆解', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }], retry: { toLayerId: 'a1', maxRounds: 1 } },
    ] }),
    // 回溯目标必须更早（指向自身/更晚）
    baseTemplate({ layers: [
      { id: 'a1', name: '拆解', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }] },
      { id: 'a2', name: '质检', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }], retry: { toLayerId: 'a2', maxRounds: 1 } },
    ] }),
    // 回溯目标不存在
    baseTemplate({ layers: [
      { id: 'a1', name: '拆解', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }] },
      { id: 'a2', name: '质检', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }], retry: { toLayerId: 'zz', maxRounds: 1 } },
    ] }),
    // 回溯轮数越界
    baseTemplate({ layers: [
      { id: 'a1', name: '拆解', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }] },
      { id: 'a2', name: '质检', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }], retry: { toLayerId: 'a1', maxRounds: 4 } },
    ] }),
    baseTemplate({ layers: [
      { id: 'a1', name: '拆解', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }] },
      { id: 'a2', name: '质检', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }], retry: { toLayerId: 'a1', maxRounds: 0 } },
    ] }),
    // 环 id 重复
    baseTemplate({ layers: [
      { id: 'a1', name: '拆解', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }] },
      { id: 'a1', name: '收束', prompt: 'x', hosts: [{ hostId: 'd', agent: '', model: '', parallel: 1 }] },
    ] }),
  ];
  for (const b of bad) assert.throws(() => validateNarrativeTemplate(b));
});

test('旧名 actors 字段读侧兼容（改名前落盘的 store 仍可装载）', () => {
  // 字段已改名 hosts：输入认两个键（hosts 优先），输出统一 hosts——旧 store 无需手改
  const t = validateNarrativeTemplate({ id: 'legacy', name: '旧档', layers: [
    { id: 'a', name: '拆解', prompt: '拆', actors: [] },
    { id: 'b', name: '实现', prompt: '做', actors: [{ hostId: 'teddy', agent: '', model: '', parallel: 2 }] },
  ] });
  assert.deepEqual(t.layers[1]!.hosts, [{ hostId: 'teddy', agent: '', model: '', parallel: 2 }]);
});

test('validateNarrativeTemplate：接待员 trim + agent/model 缺省形状', () => {
  // 双环：接待员放第二环断言（首环固定当前会话执行，其接待员被归一丢弃，见上一用例）
  const tpl = validateNarrativeTemplate(baseTemplate({ layers: [
    { id: 'a0', name: '拆解', prompt: '拆', hosts: [] },
    { id: 'a1', name: ' 执行 ', prompt: ' x ', hosts: [{ hostId: ' d ', agent: ' codex ', model: ' glm-5.3 ', parallel: 3 }] },
  ] }));
  assert.equal(tpl.layers[1].name, '执行');
  assert.equal(tpl.layers[1].prompt, 'x');
  assert.deepEqual(tpl.layers[1].hosts[0], { hostId: 'd', agent: 'codex', model: 'glm-5.3', parallel: 3 });
});

test('migrateLegacyTemplate：旧版 roles 形状迁到环序（feature 全链）', () => {
  const legacy = {
    id: 'old-line', name: '旧线', kind: 'feature', goalHint: 'h',
    params: { reviewRounds: 2, batchSize: 3 },
    roles: [
      { slot: 'director', label: '导演', hostId: 'dolores' },
      { slot: 'builder', label: '实施', hostId: 'teddy' },
      { slot: 'reviewer', label: '审阅', hostId: 'maeve' },
      { slot: 'integrator', label: '整合', hostId: 'william' },
    ],
  };
  const tpl = migrateLegacyTemplate(legacy);
  assert.deepEqual(tpl.layers.map(l => l.id), ['design', 'build', 'review']);   // v0.0.6 迁移同款三环（无收束）
  assert.equal(tpl.layers[1].hosts[0].hostId, 'teddy');
  assert.ok(tpl.layers[2].retry !== undefined && tpl.layers[2].retry.toLayerId === 'build');
  // 不可识别形状 throw（调用方丢弃降级）
  assert.throws(() => migrateLegacyTemplate({ id: 'x', roles: [] }));
  assert.throws(() => migrateLegacyTemplate({ id: 'x', kind: 'weird', roles: [{ slot: 'a', label: 'b', hostId: 'c' }] }));
});

test('mergeNarratives：store 覆盖内置同 id，墓碑跳过，超限 fail-loud', () => {
  const overridden = validateNarrativeTemplate(baseTemplate({ id: 'feature-line', name: '改名线' }));
  const extra = validateNarrativeTemplate(baseTemplate());
  const merged = mergeNarratives([], [overridden, extra], new Set(['review-panel']));
  const byId = new Map(merged.map(t => [t.id, t]));
  assert.equal(byId.get('feature-line')?.name, '改名线');   // store 胜出
  assert.equal(byId.has('review-panel'), false);            // 墓碑移除
  assert.equal(byId.has('custom-line'), true);              // store 附加
  // 容量：合并后超过 NARRATIVES_MAX 直接 throw
  const many = Array.from({ length: NARRATIVES_MAX + 5 }, (_, i) =>
    validateNarrativeTemplate(baseTemplate({ id: `line-${i}`, name: `容量线${i}` })));
  assert.throws(() => mergeNarratives([], many, new Set()), /超过上限/);
  // 恰好上限：合法（合并以内置 3 条为基底，自建补到 12）
  assert.equal(mergeNarratives([], many.slice(0, NARRATIVES_MAX - BUILTIN_TEMPLATES.length), new Set()).length, NARRATIVES_MAX);
});

test('narratives store：选中态（selectedTemplateId）随文件往返', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maze-narr-'));
  try {
    const path = narrativesPathOf(dir);
    // 缺文件 = 未选择
    const first = loadNarrativesSync(path);
    assert.equal(first.selectedTemplateId, '');
    // 写入选中态 + 模板，往返读回
    const tpl = validateNarrativeTemplate(baseTemplate());
    saveNarrativesSync(path, [tpl], [], 'custom-line');
    const next = loadNarrativesSync(path);
    assert.equal(next.selectedTemplateId, 'custom-line');
    assert.equal(next.templates[0].id, 'custom-line');
    // 非 string 的选中值按 '' 软容忍
    writeFileSync(path, JSON.stringify({ version: 1, templates: [tpl], deletedIds: [], selectedTemplateId: 42 }), 'utf8');
    assert.equal(loadNarrativesSync(path).selectedTemplateId, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assembleNarrativeTemplates：store 编辑内置的同 id 副本不误丢（覆盖语义）', () => {
  const warns: string[] = [];
  // 用户在编辑器改过内置线：store 里落了一份同 id 同名的完整副本
  const edited = validateNarrativeTemplate({ ...BUILTIN_TEMPLATES[0], layers: BUILTIN_TEMPLATES[0].layers.map(l => ({ ...l, prompt: l.prompt + ' 用户版' })) });
  const out = assembleNarrativeTemplates(BUILTIN_TEMPLATES, [], [edited], { max: NARRATIVES_MAX, warn: m => warns.push(m) });
  assert.equal(out.store.length, 1, 'store 编辑内置产生的同名副本必须保留（否则编辑成果被静默丢弃）');
  assert.deepEqual(warns, []);
  const merged = mergeNarratives([...out.config], [...out.store], new Set());
  assert.equal(merged.filter(t => t.id === edited.id).length, 1, '内置 id 只剩一份（store 胜出）');
  assert.ok(merged.find(t => t.id === edited.id)!.layers.some(l => l.prompt.endsWith('用户版')), '合并后是用户编辑版');
});

test('assembleNarrativeTemplates：超量按 config 声明顺序丢弃并 warn', () => {
  const warns: string[] = [];
  const extra = Array.from({ length: NARRATIVES_MAX }, (_, i) => validateNarrativeTemplate({ id: `line-${i}`, name: `容量线${i}`, goalHint: 'x', layers: [{ id: 'l1', name: '处理', prompt: '做事', hosts: [{ hostId: 'dolores', agent: '', model: '', parallel: 1 }] }] }));
  const out = assembleNarrativeTemplates(BUILTIN_TEMPLATES, extra, [], { max: NARRATIVES_MAX, warn: m => warns.push(m) });
  // 内置 3 条 + (NARRATIVES_MAX-3) 条自定义 = 恰好满员；多出的按声明顺序丢
  assert.equal(out.config.length, NARRATIVES_MAX - BUILTIN_TEMPLATE_IDS.length);
  assert.equal(out.config[out.config.length - 1].id, `line-${out.config.length - 1}`, '靠前的声明保留');
  assert.equal(warns.filter(m => m.includes('上限')).length, extra.length - out.config.length);
});

test('assembleNarrativeTemplates：config 撞未覆盖内置名字软丢，内置保留', () => {
  const warns: string[] = [];
  const clash = validateNarrativeTemplate({ id: 'my-feature', name: BUILTIN_TEMPLATES[0].name, goalHint: 'x', layers: [{ id: 'l1', name: '处理', prompt: '做事', hosts: [{ hostId: 'dolores', agent: '', model: '', parallel: 1 }] }] });
  const fresh = validateNarrativeTemplate({ id: 'fresh-line', name: '全新故事线', goalHint: 'x', layers: [{ id: 'l1', name: '处理', prompt: '做事', hosts: [{ hostId: 'dolores', agent: '', model: '', parallel: 1 }] }] });
  const out = assembleNarrativeTemplates(BUILTIN_TEMPLATES, [clash, fresh], [], { max: NARRATIVES_MAX, warn: m => warns.push(m) });
  assert.equal(out.config.length, 1);
  assert.equal(out.config[0].id, 'fresh-line');
  assert.equal(warns.filter(m => m.includes('重名')).length, 1);
  const merged = mergeNarratives([...out.config], [], new Set());
  assert.equal(merged.filter(t => t.id === BUILTIN_TEMPLATES[0].id).length, 1, '内置原样保留');
});

test('storylinesVersion：提示词/选中态变化翻转指纹', () => {
  const a = validateNarrativeTemplate({ id: 'v-line', name: '版本线', goalHint: 'x', layers: [{ id: 'l1', name: '处理', prompt: '旧提示词', hosts: [{ hostId: 'dolores', agent: '', model: '', parallel: 1 }] }] });
  const b = validateNarrativeTemplate({ ...a, layers: [{ ...a.layers[0], prompt: '新提示词' }] });
  const base = storylinesVersion([a], '');
  assert.equal(storylinesVersion([a], ''), base, '同输入同指纹');
  assert.notEqual(storylinesVersion([b], ''), base, '提示词变化必须翻转');
  assert.notEqual(storylinesVersion([a], 'v-line'), base, '选中态变化必须翻转');
});
