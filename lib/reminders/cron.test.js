import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesCron, nextCronMatch, parseCron } from './cron.js';
const at = (y, mo, d, h, mi, dowExpected) => {
    const date = new Date(y, mo - 1, d, h, mi, 0);
    if (dowExpected !== undefined)
        assert.equal(date.getDay(), dowExpected, '测试夹具星期校准');
    return date;
};
test('parseCron：基本字段解析', () => {
    const spec = parseCron('30 18 * * *');
    assert.equal(matchesCron(spec, at(2026, 11, 6, 18, 30)), true);
    assert.equal(matchesCron(spec, at(2026, 11, 6, 18, 31)), false);
    assert.equal(matchesCron(spec, at(2026, 11, 6, 19, 30)), false);
});
test('parseCron：列表 / 范围 / 步长', () => {
    const spec = parseCron('0,30 9-18 */2 * *');
    // 标准 cron 语义：dom 的 */2 从最小值 1 起步，命中 1,3,5,…（奇数日）
    assert.equal(matchesCron(spec, at(2026, 11, 5, 10, 0)), true); // 5 日命中 */2，10 点在 9-18
    assert.equal(matchesCron(spec, at(2026, 11, 5, 10, 30)), true);
    assert.equal(matchesCron(spec, at(2026, 11, 5, 10, 15)), false); // 分钟不命中
    assert.equal(matchesCron(spec, at(2026, 11, 5, 20, 0)), false); // 20 超出 9-18
    assert.equal(matchesCron(spec, at(2026, 11, 6, 10, 0)), false); // 6 日（偶数）不命中 */2
});
test('parseCron：周字段（0=周日，7 折叠为 0）', () => {
    // 2026-11-08 是周日
    const spec = parseCron('0 9 * * 0');
    assert.equal(matchesCron(spec, at(2026, 11, 8, 9, 0, 0)), true);
    assert.equal(matchesCron(spec, at(2026, 11, 9, 9, 0)), false);
    const spec7 = parseCron('0 9 * * 7');
    assert.equal(matchesCron(spec7, at(2026, 11, 8, 9, 0, 0)), true);
});
test('parseCron：日与周同时受限取 OR（POSIX 语义）', () => {
    // 每月 1 号 或 每周一，9:00
    const spec = parseCron('0 9 1 * 1');
    // 2026-11-01 周日：命中日字段（1 号）
    assert.equal(matchesCron(spec, at(2026, 11, 1, 9, 0, 0)), true);
    // 2026-11-09 周一：命中周字段
    assert.equal(matchesCron(spec, at(2026, 11, 9, 9, 0, 1)), true);
    // 2026-11-10 周二非 1 号：都不命中
    assert.equal(matchesCron(spec, at(2026, 11, 10, 9, 0)), false);
});
test('parseCron：仅周受限时日不参与', () => {
    const spec = parseCron('0 9 * * 1-5'); // 工作日
    assert.equal(matchesCron(spec, at(2026, 11, 6, 9, 0, 5)), true); // 周五
    assert.equal(matchesCron(spec, at(2026, 11, 8, 9, 0, 0)), false); // 周日
});
test('parseCron：非法表达式抛出（fail-loud）', () => {
    assert.throws(() => parseCron('* * * *'), /5 个字段/);
    assert.throws(() => parseCron('60 * * * *'), /越界/);
    assert.throws(() => parseCron('* 24 * * *'), /越界/);
    assert.throws(() => parseCron('a * * * *'), /无法解析/);
    assert.throws(() => parseCron('*/0 * * * *'), /步长/);
    assert.throws(() => parseCron('5-1 * * * *'), /起点大于终点/);
    assert.throws(() => parseCron('1,,2 * * * *'), /空列表项/);
    assert.throws(() => parseCron('1/2/3 * * * *'), /步长格式/);
});
test('nextCronMatch：从下一整分钟起找下次命中；稀疏表达式上限内未命中返回 null', () => {
    const daily = parseCron('0 9 * * *');
    // 2026-11-07 08:59:30 → 下次命中 09:00:00（同一天的下一整分钟）
    assert.equal(nextCronMatch(daily, new Date(2026, 10, 7, 8, 59, 30))?.getTime(), new Date(2026, 10, 7, 9, 0, 0).getTime());
    // 正好 09:00 整 → 该分钟正在经历，"下次"是明天 09:00
    assert.equal(nextCronMatch(daily, new Date(2026, 10, 7, 9, 0, 0))?.getTime(), new Date(2026, 10, 8, 9, 0, 0).getTime());
    // 极稀疏表达式（分=99 不合法，这里用只在每小时第 59 分命中+月=2+日=29 的组合在 7 天内不可能命中）
    const sparse = parseCron('59 23 29 2 *');
    assert.equal(nextCronMatch(sparse, new Date(2026, 10, 7, 12, 0, 0)), null);
});
test('parseField：单值+步长按 Vixie 展开（分字段 5/15 = 5,20,35,50）', () => {
    const spec = parseCron('5/15 * * * *');
    // 2026-11-07 12:05:00 命中
    assert.equal(matchesCron(spec, new Date(2026, 10, 7, 12, 5, 0)), true);
    // 12:20 / 12:35 / 12:50 命中
    assert.equal(matchesCron(spec, new Date(2026, 10, 7, 12, 20, 0)), true);
    assert.equal(matchesCron(spec, new Date(2026, 10, 7, 12, 35, 0)), true);
    assert.equal(matchesCron(spec, new Date(2026, 10, 7, 12, 50, 0)), true);
    // 12:10 / 13:00 不命中（展开集合到 59 为止）
    assert.equal(matchesCron(spec, new Date(2026, 10, 7, 12, 10, 0)), false);
    assert.equal(matchesCron(spec, new Date(2026, 10, 7, 13, 0, 0)), false);
    // 无步长的单值仍是自身
    assert.equal(matchesCron(parseCron('30 * * * *'), new Date(2026, 10, 7, 12, 30, 0)), true);
    assert.equal(matchesCron(parseCron('30 * * * *'), new Date(2026, 10, 7, 12, 31, 0)), false);
});
test('parseCron：单值+步长的 base 越界（如分字段 70/5）装载即报错', () => {
    // 70/15 展开为 lo=70 hi=59 的空区间：必须报错而非静默接受永不着火的字段
    assert.throws(() => parseCron('70/15 * * * *'), /越界/);
    assert.throws(() => parseCron('* * * * 8/2'), /越界/);
});
test('parseCron：覆盖全字段范围的表达式视为不受限（M6，*/1 不放大日/周 OR）', () => {
    const spec = parseCron('0 9 */1 * 1'); // dom */1 覆盖全范围=不受限 → 只由周=1 决定
    const monday = new Date(2026, 10, 9, 9, 0); // 2026-11-09 周一
    const tuesday = new Date(2026, 10, 10, 9, 0);
    assert.equal(matchesCron(spec, monday), true);
    assert.equal(matchesCron(spec, tuesday), false);
    const odd = parseCron('0 9 */2 * *'); // */2 从字段最小值起步=奇数日（1,3,5…），仍是受限字段
    assert.equal(matchesCron(odd, new Date(2026, 10, 11, 9, 0)), true); // 11 日奇数
    assert.equal(matchesCron(odd, new Date(2026, 10, 10, 9, 0)), false);
});
