/**
 * 5 字段 cron 解析与匹配（分 时 日 月 周），纯函数、无依赖。
 *
 * 为何手写：通知场景只需要 POSIX 5 字段语义的子集（列表/范围/步长），
 * 引入完整 cron 库不值得；解析在装载期执行、错误当场抛出（fail-loud）。
 *
 * 语义约定（与标准 cron 一致）：
 * - 日(day-of-month) 与 周(day-of-week) 同时受限时按 OR 匹配，仅一方受限时按 AND；
 * - 匹配精度为分钟，调用方（调度器）负责去重同一分钟内的重复触发。
 */
/** 解析单个字段表达式："*"、"a"、"a-b"、带步长（"星号/n" 或 "a-b/n"）、逗号组合 */
function parseField(expr, min, max, name) {
    if (expr === '') {
        throw new Error(`cron 字段 ${name} 为空`);
    }
    // `*` 快路径：不受限
    if (expr === '*')
        return { any: true, values: new Set() };
    const values = new Set();
    for (const part of expr.split(',')) {
        if (part === '') {
            throw new Error(`cron 字段 ${name} 含空列表项: "${expr}"`);
        }
        // 拆出步长 step（无步长视为 1）
        const stepMatch = part.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/);
        const body = stepMatch ? stepMatch[1] : part;
        const step = stepMatch ? Number(stepMatch[2]) : 1;
        if (!stepMatch && part.includes('/')) {
            throw new Error(`cron 字段 ${name} 步长格式错误: "${part}"`);
        }
        if (step < 1) {
            throw new Error(`cron 字段 ${name} 步长必须 ≥1: "${part}"`);
        }
        let lo;
        let hi;
        if (body === '*') {
            lo = min;
            hi = max; // `*/n` 覆盖全字段范围
        }
        else if (/^\d+$/.test(body)) {
            // 单值 = 自身；带步长的单值（如分字段 5/15）按 Vixie 惯例展开为
            // "从 N 到字段上限、每 step"（5,20,35,50）——与 crontab/croniter 迁移直觉一致
            lo = Number(body);
            hi = stepMatch ? max : Number(body);
        }
        else {
            const rangeMatch = body.match(/^(\d+)-(\d+)$/);
            if (!rangeMatch) {
                throw new Error(`cron 字段 ${name} 无法解析: "${part}"`);
            }
            lo = Number(rangeMatch[1]);
            hi = Number(rangeMatch[2]);
            if (lo > hi) {
                throw new Error(`cron 字段 ${name} 范围起点大于终点: "${part}"`);
            }
        }
        // lo > max 单独拦：'70/5' 时 lo=70、hi=max=59，区间与步长检查都不覆盖它，
        // 字段会被静默接受为空集（永不着火）而非装载报错
        if (lo < min || lo > max || hi > max) {
            throw new Error(`cron 字段 ${name} 数值越界（${min}-${max}）: "${part}"`);
        }
        for (let v = lo; v <= hi; v += step)
            values.add(v);
    }
    // 覆盖全字段范围的表达式（*/1、0-59 等）在效果上不受限：置 any 让
    // POSIX 日/周 OR 分支按"是否实质受限"判断——`0 9 */1 * 1` 里 */1 不再
    // 把"仅周一"放大成天天触发（*/2 只覆盖偶数值，仍是受限字段）
    if (values.size === max - min + 1)
        return { any: true, values: new Set() };
    return { any: false, values };
}
/** 解析完整 5 字段表达式，任何字段非法直接 throw（装载期校验用） */
export function parseCron(expr) {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) {
        throw new Error(`cron 表达式必须为 5 个字段（分 时 日 月 周）: "${expr}"`);
    }
    // 周字段按 cron 惯例允许 0-7（7 与 0 都表周日），解析后统一折叠到 0-6
    const dow = parseField(fields[4].toLowerCase(), 0, 7, '周');
    return {
        minute: parseField(fields[0], 0, 59, '分'),
        hour: parseField(fields[1], 0, 23, '时'),
        dom: parseField(fields[2], 1, 31, '日'),
        month: parseField(fields[3], 1, 12, '月'),
        dow: dow.any
            ? dow
            : { any: false, values: new Set([...dow.values].map(v => (v === 7 ? 0 : v))) },
    };
}
/** 判断给定时刻是否命中（秒/毫秒截断到分钟后比较） */
export function matchesCron(spec, at) {
    const minute = at.getMinutes();
    const hour = at.getHours();
    const dom = at.getDate();
    const month = at.getMonth() + 1; // JS 月份 0 起步，cron 1 起步
    const dow = at.getDay();
    if (!spec.minute.any && !spec.minute.values.has(minute))
        return false;
    if (!spec.hour.any && !spec.hour.values.has(hour))
        return false;
    if (!spec.month.any && !spec.month.values.has(month))
        return false;
    // POSIX：日与周同时受限取 OR，否则各自参与 AND
    if (spec.dom.any && spec.dow.any)
        return true;
    if (spec.dom.any)
        return spec.dow.values.has(dow);
    if (spec.dow.any)
        return spec.dom.values.has(dom);
    return spec.dom.values.has(dom) || spec.dow.values.has(dow);
}
/**
 * 从 from（截断到分钟）起向前找下一次命中时刻；maxMinutes 内未命中返回 null。
 * 上限默认 7 天（10080 分钟）：覆盖周/月级循环；更稀疏的表达式（如 2 月 29 日）
 * 在不含命中的窗口内返回 null——预览端把 null 呈现为"7 天内不会触发"。
 */
export function nextCronMatch(spec, from, maxMinutes = 10_080) {
    // 起点对齐到下一整分钟（当前正在经历的分钟不算"下次"）
    const cursor = new Date(from.getTime());
    cursor.setSeconds(0, 0);
    cursor.setMinutes(cursor.getMinutes() + 1);
    for (let i = 0; i < maxMinutes; i++) {
        if (matchesCron(spec, cursor))
            return new Date(cursor.getTime());
        cursor.setMinutes(cursor.getMinutes() + 1);
    }
    return null;
}
