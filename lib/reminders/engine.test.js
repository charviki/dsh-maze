import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileWhen, evaluateModelCall, fireReminder, localDateKey, muteRuleForToday, normalizeRule, observe, observeTick, renderMessage, setRuleEnabled, wildcardMatch, } from './engine.js';
import { matchesCron, parseCron } from './cron.js';
/** 构造 model-call 规则（缺省字段补默认） */
function mcRule(over) {
    return normalizeRule({ message: 'm', modelPattern: '*', startHour: 0, endHour: 24, maxPerDay: 2, cooldownMinutes: 120, ...over });
}
function useAt(hour, extra = {}) {
    const d = new Date(2026, 10, 6, hour, 0, 0);
    return { provider: 'zai', model: 'glm-5.3', at: d.getTime(), ...extra };
}
function stateOf(rules) {
    const m = new Map();
    for (const r of rules)
        m.set(r.id, { enabled: true, firedToday: [] });
    return m;
}
/** 空编译表（无 when 表达式的规则用它） */
const noWhen = new Map();
test('wildcardMatch：段对齐语义', () => {
    assert.equal(wildcardMatch('*glm*', 'zai/glm-5.3'), true);
    assert.equal(wildcardMatch('zai*', 'zai/glm-5.3'), true);
    assert.equal(wildcardMatch('*flash', 'zai/glm-5.3-flash'), true);
    // 无 '*' 时必须整体相等，裸串不当子串
    assert.equal(wildcardMatch('glm', 'zai/glm-5.3'), false);
    assert.equal(wildcardMatch('zai/glm-5.3', 'zai/glm-5.3'), true);
    assert.equal(wildcardMatch('*GLM*', 'zai/GLM-5.3'), true);
});
test('normalizeRule：v1 配置缺 trigger 默认 model-call', () => {
    const r = normalizeRule({ id: 'a', message: 'x' });
    assert.equal(r.trigger, 'model-call');
    assert.equal(r.modelPattern, '*');
    assert.equal(r.maxPerDay, 2);
    const c = normalizeRule({ id: 'b', message: 'x', trigger: 'cron', schedule: '0 18 * * *' });
    assert.equal(c.trigger, 'cron');
    // 缺 trigger 但有 schedule → 推断为 cron
    const inferred = normalizeRule({ id: 'c', message: 'x', schedule: '0 18 * * *' });
    assert.equal(inferred.trigger, 'cron');
});
test('evaluateModelCall：时段边界为 [start, end)', () => {
    const rule = mcRule({ id: 'r', startHour: 14, endHour: 18 });
    const states = stateOf([rule]);
    const st = states.get('r');
    assert.equal(evaluateModelCall(rule, st, useAt(13), null), false);
    assert.equal(evaluateModelCall(rule, st, useAt(14), null), true);
    assert.equal(evaluateModelCall(rule, st, useAt(17), null), true);
    assert.equal(evaluateModelCall(rule, st, useAt(18), null), false);
});
test('observe：模型匹配 + 每日上限 + 冷却', () => {
    const rule = mcRule({ id: 'r', modelPattern: '*glm*', maxPerDay: 2, cooldownMinutes: 120 });
    const states = stateOf([rule]);
    // 不匹配的模型不触发
    assert.equal(observe([rule], states, useAt(10, { provider: 'deepseek', model: 'deepseek-flash' }), noWhen).length, 0);
    assert.equal(observe([rule], states, useAt(10), noWhen).length, 1);
    // 冷却期内（120min）再触发被拦
    assert.equal(observe([rule], states, useAt(11), noWhen).length, 0);
    // 冷却过后第二次触发成功
    assert.equal(observe([rule], states, useAt(13), noWhen).length, 1);
    // 随后达每日上限
    assert.equal(observe([rule], states, useAt(16), noWhen).length, 0);
});
test('observe：跨日重置计数与免打扰', () => {
    const rule = mcRule({ id: 'r', maxPerDay: 1 });
    const states = new Map();
    // 第一天触发并达上限
    assert.equal(observe([rule], states, useAt(10), noWhen).length, 1);
    assert.equal(observe([rule], states, useAt(12), noWhen).length, 0);
    // 第二天同小时重触发（firedToday 被重置）
    const day2 = useAt(10);
    const withDay2 = { ...day2, at: day2.at + 24 * 3600_000 };
    assert.equal(observe([rule], states, withDay2, noWhen).length, 1);
});
test('evaluateModelCall：daysOfWeek 星期限定（0=周日）', () => {
    const weekday = mcRule({ id: 'dow', daysOfWeek: [1, 2, 3, 4, 5] });
    const state = stateOf([weekday]).get('dow');
    // 2026-11-09 周一 / 2026-11-07 周六 / 2026-11-08 周日（均 15:00）
    const use = (day) => ({ provider: 'zai', model: 'glm-5.3', at: new Date(2026, 10, day, 15).getTime() });
    assert.equal(evaluateModelCall(weekday, state, use(9), null), true);
    assert.equal(evaluateModelCall(weekday, state, use(7), null), false);
    assert.equal(evaluateModelCall(weekday, state, use(8), null), false);
    // 周日 0 是边界：显式含 0 的规则在周日放行；缺省=每天
    const sundayOnly = mcRule({ id: 'sun0', daysOfWeek: [0] });
    assert.equal(evaluateModelCall(sundayOnly, stateOf([sundayOnly]).get('sun0'), use(8), null), true);
    const anyDay = mcRule({ id: 'any' });
    assert.equal(evaluateModelCall(anyDay, stateOf([anyDay]).get('any'), use(7), null), true);
});
test('observe：L2 when 表达式参与 AND', () => {
    const rule = mcRule({ id: 'r', when: "use && use.model.includes('flash')" });
    const compiled = new Map([['r', compileWhen(rule.when)]]);
    const states = stateOf([rule]);
    assert.equal(observe([rule], states, useAt(10, { model: 'glm-5.3-flash' }), compiled).length, 1);
    assert.equal(observe([rule], states, useAt(10, { model: 'glm-5.3' }), compiled).length, 0);
});
test('compileWhen：语法错误抛出，求值异常按不触发', () => {
    assert.throws(() => compileWhen('use.model.'));
    const fn = compileWhen('use.provider');
    assert.ok(fn, 'compileWhen 非空输入应返回函数');
    // use=null 时访问属性抛错 → 按不触发兜底
    assert.equal(fn(null, 0, 0, 0), false);
    assert.equal(fn({ provider: 'zai', model: 'm', at: 0 }, 0, 0, 0), true);
});
test('muteRuleForToday / setRuleEnabled', () => {
    const rule = mcRule({ id: 'r' });
    const states = stateOf([rule]);
    const now = useAt(10).at;
    muteRuleForToday('r', states, now);
    assert.equal(evaluateModelCall(rule, states.get('r'), useAt(11), null), false);
    setRuleEnabled('r', false, states, now);
    assert.equal(states.get('r').enabled, false);
});
test('observeTick：cron 命中分钟触发且同分钟去重、频控生效', () => {
    const rule = normalizeRule({ id: 'c', message: 'hi', trigger: 'cron', schedule: '* * * * *', maxPerDay: 1, cooldownMinutes: 0 });
    const states = stateOf([rule]);
    const matchers = new Map([['c', (at) => matchesCron(parseCron('* * * * *'), at)]]);
    const t0 = new Date(2026, 10, 6, 10, 5, 0).getTime();
    assert.equal(observeTick([rule], states, t0, matchers, noWhen).length, 1);
    // 同一分钟第二次 tick 去重（lastCronMinute）
    assert.equal(observeTick([rule], states, t0 + 30_000, matchers, noWhen).length, 0);
    // 下一分钟：每日上限 1 已达 → 不触发
    assert.equal(observeTick([rule], states, t0 + 60_000, matchers, noWhen).length, 0);
});
test('renderMessage：占位替换', () => {
    assert.equal(renderMessage('{model}@{provider}', { provider: 'zai', model: 'glm', at: 0 }), 'glm@zai');
    assert.equal(renderMessage('纯文本', null), '纯文本');
});
test('fireReminder：Reminder id 形如 ruleId:firedAt', () => {
    const rule = mcRule({ id: 'r', maxPerDay: 1, cooldownMinutes: 0 });
    const st = { enabled: true, firedToday: [] };
    const rem = fireReminder(rule, st, 12345, 'msg');
    assert.equal(rem.id, 'r:12345');
    assert.equal(st.firedToday.length, 1);
});
test('localDateKey：本地日', () => {
    assert.equal(localDateKey(new Date(2026, 0, 2, 0, 0).getTime()), '2026-01-02');
});
test('fireReminder：冷却跨日不丢（23:59 触发后 00:01 仍在冷却期内）', () => {
    // 本地今晚 24:00 边界前后各一分钟
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    const t1 = midnight.getTime() - 60_000; // 23:59
    const t2 = midnight.getTime() + 60_000; // 次日 00:01
    const rule = mcRule({ id: 'x', maxPerDay: 5, cooldownMinutes: 120 });
    const states = new Map();
    const noWhen = new Map();
    const use1 = { provider: 'p', model: 'm', at: t1 };
    const use2 = { provider: 'p', model: 'm', at: t2 };
    assert.equal(observe([rule], states, use1, noWhen).length, 1);
    // 跨日后 firedToday 已清零（每日上限不拦），但冷却基准 lastFireAt 跨日保留 → 拦下
    assert.equal(observe([rule], states, use2, noWhen).length, 0);
    // 冷却只有 1 分钟时次日 00:01 应放行（两触发相隔 2 分钟）
    const rule2 = mcRule({ id: 'y', maxPerDay: 5, cooldownMinutes: 1 });
    const states2 = new Map();
    assert.equal(observe([rule2], states2, use1, noWhen).length, 1);
    assert.equal(observe([rule2], states2, use2, noWhen).length, 1);
});
test('wildcardMatch：末段不得与已匹配段重叠', () => {
    // 'ab*b' 不应匹配 'ab'：前缀 ab 已消费全长，末段 b 无处安放
    assert.equal(wildcardMatch('ab*b', 'ab'), false);
    // 正常形态不受影响
    assert.equal(wildcardMatch('a*b', 'ab'), true);
    assert.equal(wildcardMatch('ab*b', 'abxb'), true);
});
test('observeTick：被频控抑制的分钟也标记 lastCronMinute（M3，不重复求值）', () => {
    const rule = { id: 'c1', message: 'm', trigger: 'cron', schedule: '* * * * *', modelPattern: '*', startHour: 0, endHour: 24, maxPerDay: 1, cooldownMinutes: 0 };
    const states = new Map();
    const spec = parseCron('* * * * *');
    const matcher = new Map([['c1', (at) => matchesCron(spec, at)]]);
    const compiled = new Map([['c1', null]]);
    const t0 = new Date(2026, 10, 8, 10, 0).getTime();
    assert.equal(observeTick([rule], states, t0, matcher, compiled).length, 1); // 首发
    const t1 = new Date(2026, 10, 8, 10, 1).getTime(); // 下一分钟：maxPerDay 已耗尽
    assert.equal(observeTick([rule], states, t1, matcher, compiled).length, 0);
    const st = states.get('c1');
    assert.ok(st); // 抑制分钟仍写入标记（后续 tick 同分钟短路）
    const d = new Date(t1);
    const key = `${localDateKey(t1)}T10:01`;
    assert.equal(st.lastCronMinute, key);
});
