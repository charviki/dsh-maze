/**
 * notes 配置纯函数单测：形状校验、machines 去重、文件往返（tmpdir）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { emptyNotesConfig, loadNotesConfigSync, saveNotesConfigSync, validateNotesConfig } from './config.js';

test('validateNotesConfig：完整对象通过并裁剪空白', () => {
  const cfg = validateNotesConfig({
    baseUrl: ' http://localhost:3456/ ', token: ' tk_x ', machineName: ' mac-mini ',
    inboxProjectId: 3, machines: ['mac-mini', 'nas'],
  });
  assert.deepEqual(cfg, {
    baseUrl: 'http://localhost:3456', token: 'tk_x', machineName: 'mac-mini',
    inboxProjectId: 3, machines: ['mac-mini', 'nas'],
  });
});

test('validateNotesConfig：machines 去重、剔空串与非字符串', () => {
  const cfg = validateNotesConfig({ baseUrl: '', token: '', machineName: '', machines: ['a', 'a', ' ', 3, 'b'] });
  assert.deepEqual(cfg.machines, ['a', 'b']);
});

test('validateNotesConfig：非对象输入抛错（损坏文件 fail-loud 由装载方决定降级）', () => {
  assert.throws(() => validateNotesConfig(null), /必须是对象/);
  assert.throws(() => validateNotesConfig([1, 2]), /必须是对象/);
});

test('loadNotesConfigSync：文件缺失=空配置；save→load 往返一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-maze-notes-'));
  try {
    assert.deepEqual(loadNotesConfigSync(dir), emptyNotesConfig());
    const cfg = { baseUrl: 'http://x', token: 'tk', machineName: 'm', machines: ['m'] };
    saveNotesConfigSync(dir, cfg);
    assert.deepEqual(loadNotesConfigSync(dir), cfg);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
