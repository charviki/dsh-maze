import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_APPEARANCE, DEFAULT_HOST_ID, DEFAULT_LINES, LINE_GROUPS, loadAppearanceSync, resolveDefaultAppearance, saveAppearanceSync, validateAppearance } from './appearance.js';

test('validateAppearance：默认形状由缺省字段补全（空对象=全默认名册）', () => {
  assert.deepEqual(validateAppearance({}), DEFAULT_APPEARANCE);
  const cfg = validateAppearance({});
  assert.equal(cfg.host.rotate, false);
  assert.equal(cfg.host.pinned, true); // 用户偏好烘焙的出厂默认
  assert.equal(cfg.host.manualHostId, 'dolores');
  assert.equal(cfg.hosts.length, 5); // 五位出厂接待员（emoji 回落形象）
  assert.equal(cfg.hosts[0].name, 'Dolores');
  assert.deepEqual(cfg.hosts.map((h) => h.name), ['Dolores', 'Maeve', 'Bernard', 'Teddy', 'William']);
});

test('validateAppearance：合法自定义值往返无损（多接待员名册+全局设置）', () => {
  const cfg = validateAppearance({
    background: { enabled: true, image: 'data:image/png;base64,AAAA', opacity: 0.6, chatOpacity: 0.4 },
    host: { size: 56, pinned: true, hidden: false, rotate: true, manualHostId: '' },
    hosts: [
      { id: 'dolores', name: 'Dolores', avatar: 'data:image/png;base64,BBBB', lines: { daily: ['I choose to see the beauty.'], failed: [] }, enabled: true },
      { id: 'maeve', name: 'Maeve', avatar: '🐼', lines: { daily: ['Wake up.'] }, enabled: false },
    ],
  });
  assert.equal(cfg.background.opacity, 0.6);
  assert.equal(cfg.background.chatOpacity, 0.4);
  assert.equal(cfg.host.size, 56);
  assert.equal(cfg.host.pinned, true);
  assert.equal(cfg.host.rotate, true);
  assert.equal(cfg.hosts.length, 2);
  assert.equal(cfg.hosts[0].avatar, 'data:image/png;base64,BBBB');
  assert.deepEqual(cfg.hosts[0].lines.daily, ['I choose to see the beauty.']);
  assert.deepEqual(cfg.hosts[0].lines.failed, []); // 显式空组=该组沉默
  assert.deepEqual(cfg.hosts[0].lines.done, DEFAULT_LINES.done); // 未提供的组回默认
  assert.equal(cfg.hosts[1].name, 'Maeve');
  assert.equal(cfg.hosts[1].enabled, false); // 停用=下台不删档
  assert.deepEqual(cfg.hosts[1].lines.daily, ['Wake up.']);
});

test('validateAppearance：接待员名册逐项校验（重复 id/空 id/空名/超长名/坏头像/坏台词/超量/坏 enabled）', () => {
  assert.throws(() => validateAppearance({ hosts: 'x' }), /hosts 必须是接待员数组/);
  assert.throws(() => validateAppearance({ hosts: [{ id: 'a', name: 'A', avatar: '🧚' }, { id: 'a', name: 'B', avatar: '🧚' }] }), /id 重复/);
  assert.throws(() => validateAppearance({ hosts: [{ id: '  ', name: 'A', avatar: '🧚' }] }), /id 不能为空/);
  assert.throws(() => validateAppearance({ hosts: [{ id: 'a', name: '', avatar: '🧚' }] }), /name 不能为空/);
  assert.throws(() => validateAppearance({ hosts: [{ id: 'a', name: 'x'.repeat(25), avatar: '🧚' }] }), /name 不能超过/);
  assert.throws(() => validateAppearance({ hosts: [{ id: 'a', name: 'A', avatar: '普通文本头像' }] }), /只能是 ≤4 个字符的短文本/);
  assert.throws(() => validateAppearance({ hosts: [{ id: 'a', name: 'A', avatar: '🧚', lines: { unknown: ['x'] } }] }), /未知台词分组/);
  assert.throws(() => validateAppearance({ hosts: [{ id: 'a', name: 'A', avatar: '🧚', lines: { daily: [''] } }] }), /hosts\[0\]\.lines\.daily/);
  assert.throws(() => validateAppearance({ hosts: [{ id: 'a', name: 'A', avatar: '🧚', enabled: 'yes' }] }), /enabled 必须为布尔值/);
  const tooMany = Array.from({ length: 9 }, (_, i) => ({ id: `h${i}`, name: `H${i}`, avatar: '🧚' }));
  assert.throws(() => validateAppearance({ hosts: tooMany }), /名册最多 8 位/);
  // enabled 缺省=启用
  assert.equal(validateAppearance({ hosts: [{ id: 'a', name: 'A', avatar: '🧚' }] }).hosts[0].enabled, true);
});

test('validateAppearance：rotate/manualHostId 校验与归一', () => {
  assert.throws(() => validateAppearance({ host: { rotate: 'yes' } }), /host\.rotate/);
  assert.throws(() => validateAppearance({ host: { manualHostId: 42 } }), /host\.manualHostId/);
  // 悬空引用不 throw：名册编辑会临时产生，客户端回落首位启用者
  const cfg = validateAppearance({ host: { manualHostId: 'ghost' } });
  assert.equal(cfg.host.manualHostId, 'ghost');
  assert.equal(validateAppearance({ host: { manualHostId: '' } }).host.manualHostId, '');
});

test('validateAppearance：chatOpacity 缺省=1（老配置兼容）；非法拒绝', () => {
  const legacy = validateAppearance({ background: { enabled: true, image: 'data:image/png;base64,AAAA' } });
  assert.equal(legacy.background.chatOpacity, 1); // 老外观文件缺字段 → 原样不透明
  // 0 现在合法（滑杆 100% 全透）；负数/超 1 拒绝
  assert.equal(validateAppearance({ background: { chatOpacity: 0 } }).background.chatOpacity, 0);
  assert.throws(() => validateAppearance({ background: { chatOpacity: -0.1 } }), /background\.chatOpacity/);
  assert.throws(() => validateAppearance({ background: { chatOpacity: 1.2 } }), /background\.chatOpacity/);
});

test('validateAppearance：非法值逐项拒绝（带字段名）', () => {
  assert.throws(() => validateAppearance('x'), /必须是对象/);
  assert.throws(() => validateAppearance({ background: { image: 'https://a/b.png' } }), /background\.image/);
  assert.throws(() => validateAppearance({ background: { opacity: 0 } }), /background\.opacity/);
  assert.throws(() => validateAppearance({ background: { opacity: 1.5 } }), /background\.opacity/);
  assert.throws(() => validateAppearance({ host: { size: 20 } }), /host\.size/);
  assert.throws(() => validateAppearance({ host: { size: 99 } }), /host\.size/);
  assert.throws(() => validateAppearance({ host: { pinned: 'yes' } }), /host\.pinned/);
  assert.throws(() => validateAppearance({ host: { hidden: 1 } }), /host\.hidden/);
});

test('validateAppearance：台词逐项校验（未知分组/非数组/空串/超长/超量）落在接待员条目上', () => {
  assert.throws(() => validateAppearance({ hosts: [{ id: 'a', name: 'A', avatar: '🧚', lines: { daily: 'not-array' } }] }), /lines\.daily/);
  assert.throws(() => validateAppearance({ hosts: [{ id: 'a', name: 'A', avatar: '🧚', lines: { daily: ['  '] } }] }), /lines\.daily/);
  assert.throws(() => validateAppearance({ hosts: [{ id: 'a', name: 'A', avatar: '🧚', lines: { daily: ['a'.repeat(201)] } }] }), /lines\.daily/);
  assert.throws(() => validateAppearance({ hosts: [{ id: 'a', name: 'A', avatar: '🧚', lines: { daily: Array.from({ length: 25 }, () => 'x') } }] }), /lines\.daily/);
  // 上边界合法：24 条、恰好 200 字、首尾空白会归一
  const ok = validateAppearance({ hosts: [{ id: 'a', name: 'A', avatar: '🧚', lines: { daily: Array.from({ length: 24 }, (_, i) => (i === 0 ? `  ${'a'.repeat(200)}  ` : 'x')) } }] });
  assert.equal(ok.hosts[0].lines.daily.length, 24);
  assert.equal(ok.hosts[0].lines.daily[0], 'a'.repeat(200));
});

test('DEFAULT_LINES：覆盖全部三组且每条非空（Dolores 原剧英文句）', () => {
  assert.deepEqual(LINE_GROUPS.slice().sort(), Object.keys(DEFAULT_LINES).sort());
  for (const key of LINE_GROUPS) {
    assert.ok(DEFAULT_LINES[key].length > 0, `${key} 默认台词不应为空`);
    for (const line of DEFAULT_LINES[key]) assert.ok(line.trim() !== '');
  }
});

test('validateAppearance：旧七神态台词分组自动迁移为三组（五组并入 daily，一句不丢）', () => {
  const cfg = validateAppearance({
    hosts: [{
      id: 'a', name: 'A', avatar: '🧚', enabled: true,
      lines: { idle: ['i1', 'i2'], waiting: ['w1'], thinking: ['t1'], tool: ['to1'], review: ['r1'], done: ['d1'], failed: ['f1'] },
    }],
  });
  assert.deepEqual(cfg.hosts[0].lines.daily, ['i1', 'i2', 'w1', 't1', 'to1', 'r1']);
  assert.deepEqual(cfg.hosts[0].lines.done, ['d1']);
  assert.deepEqual(cfg.hosts[0].lines.failed, ['f1']);
  // 已是新格式（含 daily）时不迁移，未知分组照常报错
  assert.throws(() => validateAppearance({ hosts: [{ id: 'b', name: 'B', avatar: '🧚', lines: { walking: ['x'] } }] }), /未知台词分组/);
});

test('validateAppearance：返回的台词数组与 DEFAULT_LINES 不共享引用（防默认库被污染）', () => {
  const cfg = validateAppearance({});
  cfg.hosts[0].lines.daily.push('MUTANT');
  assert.equal(DEFAULT_LINES.daily.includes('MUTANT'), false);
});

test('loadAppearanceSync / saveAppearanceSync：不存在=默认；损坏抛出；往返持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maze-appearance-'));
  try {
    assert.deepEqual(loadAppearanceSync(dir), DEFAULT_APPEARANCE); // 文件不存在
    writeFileSync(join(dir, 'appearance.json'), 'not-json', 'utf8');
    assert.throws(() => loadAppearanceSync(dir), /必须是对象|Unexpected/); // 损坏由调用方降级
    const cfg = validateAppearance({ host: { size: 52, pinned: true }, hosts: [{ id: 'a', name: 'A', avatar: '🧚', lines: { daily: ['Burn it clean.'] } }] });
    saveAppearanceSync(dir, cfg);
    assert.deepEqual(loadAppearanceSync(dir), cfg);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('resolveDefaultAppearance：assets 齐备=背景/头像出厂默认（data URL+烘焙滑杆值）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maze-assets-'));
  try {
    // 最小 webp 头（RIFF....WEBP）——内容不必是合法图片，只验证读文件+base64 装配
    writeFileSync(join(dir, 'default-background.webp'), Buffer.from('RIFF0000WEBP'));
    writeFileSync(join(dir, 'host-dolores.webp'), Buffer.from('RIFF1111WEBP'));
    for (const id of ['maeve', 'bernard', 'teddy', 'william']) {
      writeFileSync(join(dir, `host-${id}.webp`), Buffer.from(`RIFF-${id}-WEBP`));
    }
    const cfg = resolveDefaultAppearance(dir);
    assert.equal(cfg.background.enabled, true);
    assert.ok(cfg.background.image.startsWith('data:image/webp;base64,'));
    assert.equal(cfg.background.opacity, 0.8);
    assert.equal(cfg.background.chatOpacity, 0.35);
    // 五位名册全部装配资产头像；台词库不受资产影响
    assert.equal(cfg.hosts.length, 5);
    assert.deepEqual(cfg.hosts.map((h) => h.name), ['Dolores', 'Maeve', 'Bernard', 'Teddy', 'William']);
    for (const host of cfg.hosts) assert.ok(host.avatar.startsWith('data:image/webp;base64,'));
    assert.deepEqual(cfg.hosts[0].lines, DEFAULT_LINES);
    assert.ok(cfg.hosts[1].lines.daily.length > 0); // Maeve 有自己的出厂台词库
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDefaultAppearance：资产缺失=降级到内置默认（不 throw）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maze-assets-'));
  try {
    const cfg = resolveDefaultAppearance(dir); // 空目录
    assert.deepEqual(cfg, DEFAULT_APPEARANCE);
    assert.equal(cfg.hosts.every((h) => !h.avatar.startsWith('data:image/')), true); // 全 emoji 回落
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAppearanceSync：文件缺失时用传入的资产版默认；文件存在则文件胜出', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-maze-appearance-'));
  const assetsDir = mkdtempSync(join(tmpdir(), 'dsh-maze-assets-'));
  try {
    writeFileSync(join(assetsDir, 'host-dolores.webp'), Buffer.from('RIFF1111WEBP'));
    const assetDefault = resolveDefaultAppearance(assetsDir);
    assert.deepEqual(loadAppearanceSync(dataDir, assetDefault), assetDefault); // 无文件=出厂默认
    saveAppearanceSync(dataDir, validateAppearance({ hosts: [{ id: 'panda', name: 'Panda', avatar: '🐼' }] }));
    const fromFile = loadAppearanceSync(dataDir, assetDefault);
    assert.equal(fromFile.hosts[0].avatar, '🐼'); // 用户文件覆盖出厂默认
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  }
});

test('validateAppearance：background.enabled/image 类型错误拒绝（不静默强转）', () => {
  assert.throws(() => validateAppearance({ background: { enabled: 'false' } }), /enabled/);
  assert.throws(() => validateAppearance({ background: { image: 123 } }), /image/);
  // 缺省（undefined）仍走默认值，不受影响
  assert.equal(validateAppearance({}).background.enabled, false);
});

// 头像存档池：缺省=空池、往返、逐项校验走 avatar 同一规则
test('appearance avatars pool defaults and round-trip', () => {
  const def = validateAppearance({});
  assert.equal(def.avatars.length, 0);
  const url = 'data:image/webp;base64,' + 'A'.repeat(64);
  const cfg = validateAppearance({ avatars: [url, '🦋'] });
  assert.deepEqual(cfg.avatars, [url, '🦋']);
});

test('appearance avatars pool rejects bad entries', () => {
  const url = 'data:image/webp;base64,' + 'A'.repeat(64);
  assert.throws(() => validateAppearance({ avatars: 'no' }), /avatars 必须是数组/);
  assert.throws(() => validateAppearance({ avatars: Array.from({ length: 13 }, () => url) }), /头像存档最多 12 张/);
  assert.throws(() => validateAppearance({ avatars: ['data:text/html;base64,eA=='] }), /avatars\[0\]/);
});

test('validateAppearance：形状错误拒绝（M4/M7——不再静默清空成默认）', () => {
  assert.throws(() => validateAppearance([]), /外观配置必须是对象/);
  assert.throws(() => validateAppearance('x'), /外观配置必须是对象/);
  assert.throws(() => validateAppearance({ background: 'x' }), /background 必须是对象/);
  assert.throws(() => validateAppearance({ background: [] }), /background 必须是对象/);
  assert.throws(() => validateAppearance({ host: 3 }), /host 必须是对象/);
});

test('checkAvatar MIME 白名单：svg 数据 URL 拒绝（L5）', () => {
  const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
  assert.throws(() => validateAppearance({ background: { image: svg } }), /png\/jpeg\/webp\/gif/);
  assert.throws(() => validateAppearance({ hosts: [{ id: 'a', name: 'A', avatar: svg }] }), /png\/jpeg\/webp\/gif/);
});

test('图片聚合上限：背景+名册+池总字符超 7.5M 拒绝（M5）', () => {
  const img = `data:image/webp;base64,${'A'.repeat(4_000_000)}`;
  assert.throws(
    () => validateAppearance({ background: { image: img }, hosts: [{ id: 'a', name: 'A', avatar: img }, { id: 'b', name: 'B', avatar: img }] }),
    /图片总量超过/,
  );
});

test('loadAppearanceSync：文件存在时不求值 fallback 工厂（L13）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mz-lazy-'));
  saveAppearanceSync(dir, validateAppearance({}));
  let called = 0;
  const cfg = loadAppearanceSync(dir, () => { called += 1; return DEFAULT_APPEARANCE; });
  assert.equal(called, 0);
  assert.deepEqual(cfg.hosts.map((h) => h.name), DEFAULT_APPEARANCE.hosts.map((h) => h.name));
});
