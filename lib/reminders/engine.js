/**
 * 规则引擎 v2：触发源（model-call / cron）× 条件（L1 结构化 + L2 表达式）× 频控。
 *
 * 设计要点：
 * - 纯函数、无 IO；持久化（store）与调度（30s tick）在插件主体（index.ts）。
 * - trigger 缺省时按形状推断：有 schedule 即 cron，否则 model-call。
 * - L2 表达式（when）与 L1 条件是 AND 关系；when 仅允许配置文件作者使用（与 cordis !!js 同信任级），
 *   装载期编译并校验语法，求值异常视为不触发（宁可漏报不可刷屏）。
 */
/** 本地日期键（跨日重置频控用），格式 'YYYY-MM-DD' */
export function localDateKey(at) {
    const d = new Date(at);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
}
/** 通配匹配：'*' 分段，段间子串匹配（大小写不敏感），如 '*glm*' 匹配 'zai/glm-5.3' */
export function wildcardMatch(pattern, value) {
    const p = pattern.toLowerCase();
    const v = value.toLowerCase();
    // 无 '*'：整体相等才匹配（避免裸字符串被当子串误配）
    if (!p.includes('*'))
        return p === v;
    const parts = p.split('*');
    let idx = 0;
    for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        if (seg === '')
            continue;
        if (i === 0) {
            // 首段必须前缀对齐
            if (!v.startsWith(seg, idx))
                return false;
            idx = seg.length;
        }
        else if (i === parts.length - 1) {
            // 末段必须后缀对齐，且不得与已匹配段重叠（'ab*b' 不应匹配 'ab'）
            if (idx > v.length - seg.length || !v.endsWith(seg))
                return false;
            idx = v.length;
        }
        else {
            const found = v.indexOf(seg, idx);
            if (found === -1)
                return false;
            idx = found + seg.length;
        }
    }
    return true;
}
/** 消息模板渲染：{model}/{provider} 占位替换 */
export function renderMessage(template, use) {
    // 函数替换器：替换值里的 $&/$' 等模式串不被当作替换模式解释
    // （模板可含这些字符，值来自 provider/model 自由文本）
    return template
        .replaceAll('{model}', () => use?.model ?? '')
        .replaceAll('{provider}', () => use?.provider ?? '');
}
/**
 * 规范化规则：填充默认值、推断触发源。
 * 输入形状由 validateRule 先验（错误类型在那边报错），此处只做语义默认，不做完整校验。
 */
export function normalizeRule(raw) {
    // 缺 trigger 默认 model-call：v1 配置（只有时段+pattern 字段）无需迁移
    const hasSchedule = typeof raw.schedule === 'string' && raw.schedule.trim() !== '';
    const trigger = raw.trigger === 'cron' || (raw.trigger === undefined && hasSchedule) ? 'cron' : 'model-call';
    return {
        id: String(raw.id ?? ''),
        name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : undefined,
        message: String(raw.message ?? ''),
        trigger,
        schedule: trigger === 'cron' ? String(raw.schedule ?? '') : undefined,
        modelPattern: typeof raw.modelPattern === 'string' && raw.modelPattern !== '' ? raw.modelPattern : '*',
        startHour: typeof raw.startHour === 'number' ? raw.startHour : 0,
        endHour: typeof raw.endHour === 'number' ? raw.endHour : 24,
        maxPerDay: typeof raw.maxPerDay === 'number' ? raw.maxPerDay : 2,
        cooldownMinutes: typeof raw.cooldownMinutes === 'number' ? raw.cooldownMinutes : 120,
        locked: raw.locked === true ? true : undefined,
        when: typeof raw.when === 'string' && raw.when.trim() !== '' ? raw.when : undefined,
        daysOfWeek: Array.isArray(raw.daysOfWeek) && raw.daysOfWeek.length > 0
            ? raw.daysOfWeek.map((d) => Number(d))
            : undefined,
    };
}
/**
 * 编译 L2 表达式。表达式求值为真值才允许触发。
 * 为何用 new Function：when 仅来自用户自己的配置文件（与 cordis !!js 同信任级），不值得引入表达式库。
 * @param when 表达式文本，如 "use && use.model.includes('glm') && hour >= 14"
 * @returns 求值函数；when 为空返回 null（无条件门）
 * @throws 语法错误直接抛出（装载期 fail-loud）
 */
export function compileWhen(when) {
    if (when === undefined || when.trim() === '')
        return null;
    // 包一层 return 使"表达式"（而非语句体）书写自然；构造期即完成语法校验（fail-loud）。
    // 不做空跑：合法表达式通常会解引用 use，而编译期 use 恒为 null；求值期异常由包装器兜底。
    const fn = new Function('use', 'hour', 'minute', 'dow', `"use strict"; return (${when});`);
    return (use, hour, minute, dow) => {
        try {
            return Boolean(fn(use, hour, minute, dow));
        }
        catch {
            // 求值异常按不触发处理：表达式 bug 不应刷屏打扰
            return false;
        }
    };
}
/** 取或建状态，并做跨日重置（firedToday/mutedDay/lastCronMinute 过期即清） */
function ensureFreshState(ruleId, states, now) {
    const today = localDateKey(now);
    const prev = states.get(ruleId);
    if (!prev) {
        const fresh = { enabled: true, firedToday: [] };
        states.set(ruleId, fresh);
        return fresh;
    }
    // 只保留今日数据；跨日残留（昨日计数/过期免打扰/过期分钟键）整体重建
    const todaysFires = prev.firedToday.filter(t => localDateKey(t) === today);
    const mutedDay = prev.mutedDay === today ? today : undefined;
    const cronKeyFresh = prev.lastCronMinute !== undefined && prev.lastCronMinute.startsWith(today);
    if (todaysFires.length !== prev.firedToday.length || mutedDay !== prev.mutedDay || cronKeyFresh !== (prev.lastCronMinute !== undefined)) {
        const fresh = {
            enabled: prev.enabled,
            firedToday: todaysFires,
            mutedDay,
            lastCronMinute: cronKeyFresh ? prev.lastCronMinute : undefined,
            // 冷却基准跨日保留（见字段注释），不随日界清理
            lastFireAt: prev.lastFireAt,
        };
        states.set(ruleId, fresh);
        return fresh;
    }
    return prev;
}
/** model-call 条件评估（L1 结构化 + L2 when AND） */
export function evaluateModelCall(rule, state, use, when) {
    if (!state.enabled)
        return false;
    if (state.mutedDay !== undefined)
        return false;
    const at = new Date(use.at);
    const hour = at.getHours();
    if (hour < (rule.startHour ?? 0) || hour >= (rule.endHour ?? 24))
        return false;
    // 星期限定（0=周日..6=周六）：工作日规则如 glm 高峰提醒周末不触发
    if (rule.daysOfWeek !== undefined && !rule.daysOfWeek.includes(at.getDay()))
        return false;
    if (!wildcardMatch(rule.modelPattern ?? '*', `${use.provider}/${use.model}`))
        return false;
    if (when !== null && !when(use, hour, new Date(use.at).getMinutes(), new Date(use.at).getDay()))
        return false;
    return true;
}
/** 共享频控门：每日上限（按日计数）+ 冷却（跨日，基准 lastFireAt）通过才生成 Reminder 并记账 */
export function fireReminder(rule, state, at, rendered) {
    const maxPerDay = rule.maxPerDay ?? 2;
    const cooldownMs = (rule.cooldownMinutes ?? 120) * 60_000;
    const todaysFires = state.firedToday.filter(t => localDateKey(t) === localDateKey(at));
    if (todaysFires.length >= maxPerDay)
        return null;
    // 冷却看全局最近一次触发（不按日过滤）：23:59 触发后 00:01 仍在冷却期内
    if (state.lastFireAt !== undefined && at - state.lastFireAt < cooldownMs)
        return null;
    const reminder = { id: `${rule.id}:${at}`, ruleId: rule.id, message: rendered, firedAt: at };
    state.firedToday = [...todaysFires, at];
    state.lastFireAt = at;
    return reminder;
}
/**
 * 模型调用观察入口：对 trigger='model-call' 的规则逐条评估并触发。
 * @param compiled 预编译的 when 函数表（ruleId → WhenFn|null），由装载方构建避免每次调用重编译
 */
export function observe(rules, states, use, compiled) {
    const out = [];
    for (const rule of rules) {
        if (rule.trigger !== 'model-call')
            continue;
        const state = ensureFreshState(rule.id, states, use.at);
        if (!evaluateModelCall(rule, state, use, compiled.get(rule.id) ?? null))
            continue;
        const reminder = fireReminder(rule, state, use.at, renderMessage(rule.message, use));
        if (reminder)
            out.push(reminder);
    }
    return out;
}
/**
 * 定时调度观察入口：对 trigger='cron' 且 schedule 命中当前分钟的规则触发（每分钟至多一次）。
 * @param specMatcher 已解析的 cron 匹配器表（ruleId → (at)=>boolean）
 */
export function observeTick(rules, states, now, specMatcher, compiled) {
    const out = [];
    const d = new Date(now);
    // 分钟标识用于去重：30s tick 同一分钟内第二次评估直接跳过
    const minuteKey = `${localDateKey(now)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    for (const rule of rules) {
        if (rule.trigger !== 'cron')
            continue;
        const matcher = specMatcher.get(rule.id);
        if (!matcher || !matcher(d))
            continue;
        const state = ensureFreshState(rule.id, states, now);
        if (!state.enabled || state.mutedDay !== undefined)
            continue;
        if (state.lastCronMinute === minuteKey)
            continue;
        // 匹配分钟即标记：被 when/频控抑制的分钟不再重复求值（when 是任意 JS，
        // 每 30s tick 重跑同一表达式纯属浪费）
        state.lastCronMinute = minuteKey;
        const when = compiled.get(rule.id) ?? null;
        if (when !== null && !when(null, d.getHours(), d.getMinutes(), d.getDay()))
            continue;
        const reminder = fireReminder(rule, state, now, renderMessage(rule.message, null));
        if (reminder)
            out.push(reminder);
    }
    return out;
}
/** 今日免打扰：将规则 mutedDay 置为当前本地日 */
export function muteRuleForToday(ruleId, states, now) {
    const state = ensureFreshState(ruleId, states, now);
    state.mutedDay = localDateKey(now);
}
/** 启停规则（规则存在性由调用方先行检查，此处只改状态） */
export function setRuleEnabled(ruleId, enabled, states, now) {
    const state = ensureFreshState(ruleId, states, now);
    state.enabled = enabled;
}
