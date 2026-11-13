import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRule } from './validate.js';

test('validateRule：合法最小形状通过且补默认值', () => {
  const rule = validateRule({ id: 'r1', message: 'hi' });
  assert.equal(rule.trigger, 'model-call');
  assert.equal(rule.modelPattern, '');
  assert.equal(rule.maxPerDay, 2);
});

test('validateRule：拼错的 trigger 拒绝（不得静默归为 model-call）', () => {
  assert.throws(() => validateRule({ id: 'r', message: 'm', trigger: 'corn' }), /trigger/);
  assert.throws(() => validateRule({ id: 'r', message: 'm', trigger: 'CRON' }), /trigger/);
});

test('validateRule：错误类型的字段拒绝（不被默认值静默替换）', () => {
  assert.throws(() => validateRule({ id: 'r', message: 'm', startHour: '9' }), /startHour/);
  assert.throws(() => validateRule({ id: 'r', message: 'm', maxPerDay: '5' }), /maxPerDay/);
  assert.throws(() => validateRule({ id: 9, message: 'm' }), /id/);
  assert.throws(() => validateRule({ id: 'r', message: { text: 'm' } }), /message/);
});

test('validateRule：maxPerDay 须为整数、cooldownMinutes 须为有限数', () => {
  assert.throws(() => validateRule({ id: 'r', message: 'm', maxPerDay: 1.5 }), /maxPerDay/);
  assert.throws(() => validateRule({ id: 'r', message: 'm', cooldownMinutes: Number.NaN }), /cooldownMinutes/);
  // 边界合法值
  assert.equal(validateRule({ id: 'r', message: 'm', maxPerDay: 1, cooldownMinutes: 0 }).maxPerDay, 1);
});

test('validateRule：daysOfWeek 星期数组校验', () => {
  const wd = validateRule({ id: 'r', message: 'm', daysOfWeek: [1, 2, 3, 4, 5] });
  assert.deepEqual(wd.daysOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(validateRule({ id: 'r', message: 'm', daysOfWeek: [0] }).daysOfWeek, [0]);
  for (const bad of [[7], [-1], [1.5], ['1'], []]) {
    assert.throws(() => validateRule({ id: 'r', message: 'm', daysOfWeek: bad }), /daysOfWeek/);
  }
  assert.equal(validateRule({ id: 'r', message: 'm' }).daysOfWeek, undefined); // 缺省=每天
});

test('validateRule：when 表达式仅文件路径（allowWhen）放行', () => {
  const raw = { id: 'r', message: 'm', when: "use && use.model.includes('glm')" };
  // HTTP 来源（不传 opts）：拒绝——new Function 在宿主进程执行，不能走请求体
  assert.throws(() => validateRule(raw), /when/);
  // config/store 文件装载：放行且编译通过
  const rule = validateRule(raw, { allowWhen: true });
  assert.equal(rule.when, raw.when);
});

test('validateRule：locked 标记仅文件路径（allowLocked）放行', () => {
  const raw = { id: 'r', message: 'm', locked: true };
  assert.throws(() => validateRule(raw), /locked/);
  assert.equal(validateRule(raw, { allowLocked: true }).locked, true);
  // 显式 false 不是提权，任何来源都接受
  assert.equal(validateRule({ id: 'r', message: 'm', locked: false }).locked, undefined);
});

test('validateRule：when/locked 类型错误先于信任边界报错（M2）', () => {
  assert.throws(() => validateRule({ id: 'r1', message: 'm', when: true }, { allowWhen: true }), /when 必须是表达式字符串/);
  assert.throws(() => validateRule({ id: 'r1', message: 'm', when: true }), /when 必须是表达式字符串/);
  assert.throws(() => validateRule({ id: 'r1', message: 'm', locked: 'true' }, { allowLocked: true }), /locked 必须为布尔值/);
});

test('validateRule：数组载荷直接拒绝（M4 同族）', () => {
  assert.throws(() => validateRule([{ id: 'r1' }]), /规则必须是对象/);
});

test('validateRule：时段窗口——跨午夜合法、相等拒绝', () => {
  // start > end = 跨午夜环绕（18→14），装载合法且原样保留
  const wrap = validateRule({ id: 'r', message: 'm', startHour: 18, endHour: 14 });
  assert.equal(wrap.startHour, 18);
  assert.equal(wrap.endHour, 14);
  // 相等 = 空窗口，拒绝（全天生效用默认 0–24）
  assert.throws(() => validateRule({ id: 'r', message: 'm', startHour: 14, endHour: 14 }), /不能相等/);
});

test('validateRule：modelPattern 为正则（旧通配/exclude 字段自动迁移）', () => {
  // 旧通配形态（含 patternMode/excludeModelPattern）装载即迁移为正则-only
  const r = validateRule({ id: 'r', message: 'm', modelPattern: '*', excludeModelPattern: '*glm*' });
  assert.equal(r.modelPattern, '^(?![\\s\\S]*glm)');
  // 纯正则：语法错误装载即报（带字段名），空串=匹配一切（合法），i 标志断言通过
  assert.throws(() => validateRule({ id: 'r', message: 'm', modelPattern: '(?!' }), /modelPattern.*正则/);
  assert.equal(validateRule({ id: 'r', message: 'm' }).modelPattern, '');
  assert.equal(validateRule({ id: 'r', message: 'm', modelPattern: '^(?!.*glm)' }).modelPattern, '^(?!.*glm)');
  // 类型错误仍拒绝
  assert.throws(() => validateRule({ id: 'r', message: 'm', modelPattern: 9 }), /modelPattern.*字符串/);
});
