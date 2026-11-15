/**
 * 故事线（Narratives）模板模型与校验。
 *
 * 模板是一条由环（layer）组成的路径：每环同构（环名 + 共用提示词 +
 * 接待员表 + 并行数 + 可选回溯），职责由位置决定——首环（当前会话）
 * 拆解子任务、中间环逐子任务处理（带回溯的环即质检环：fail 打回
 * 更早的环重做）、末环
 * 收束、单环直通。存储语义与提醒规则一致：内置模板为基底，store
 * 同 id 覆盖，墓碑记录删除。
 * @module dsh-maze/narratives
 */
/** 名册容量上限（与接待员名册一致，防误建一堆）。 */
export const NARRATIVES_MAX = 12;
/** 每条故事线环数上限。 */
const NARRATIVE_LAYERS_MAX = 12;
/** 每环接待员上限。 */
const HOSTS_PER_LAYER_MAX = 8;
/** 并行数上限。 */
const PARALLEL_MAX = 8;
/** agent/model 字符串上限（原样进故事线消息，防膨胀） */
const AGENT_MODEL_MAX_CHARS = 64;
/** 环共用提示词长度上限。 */
const LAYER_PROMPT_MAX_CHARS = 2000;
/** 接待员工厂：省缺配置全走环境默认（agent/model 空串 + 并行 1）。 */
function narrativeHost(hostId, agent = '', model = '', parallel = 1) {
    return { hostId, agent, model, parallel };
}
/** 内置模板：出厂基底（用户可改接待员与环配置，store 同 id 覆盖）。 */
export const BUILTIN_TEMPLATES = [
    {
        id: 'feature-line',
        name: '功能开发线',
        goalHint: '要做成什么？一句话目标；当前会话先出任务与子任务清单，等你确认后执行。',
        layers: [
            { id: 'design', name: '拆解', prompt: '同一功能点或同一模块的改动合并为一个子任务；互相依赖的工作合并，避免并行时相互等待；每个子任务要能独立完成和独立验证。', hosts: [] },
            { id: 'build', name: '实现', prompt: '按分配的子任务实现：只改与任务相关的代码，范围外的问题记录到产出里，不要顺手修改；完成后自查语法、引用和边界情况；产出包含改动文件清单和验证证据（跑过的命令或测试结果）。', hosts: [narrativeHost('teddy', '', '', 2)] },
            { id: 'review', name: '质检', prompt: '逐个子任务检查实现：代码改动先用 open-code-review-delegate skill 审查（ocr 负责圈定文件和配置规则，diff 由你逐文件阅读）。只读 ocr 圈定的文件与 diff 涉及的改动处，不做全文逐行取证；issue 用 文件:行号 + 一句话，不整段摘抄原文；通过项一句依据即可。全部检查完后附一段整体交付摘要与遗留事项。', hosts: [narrativeHost('maeve')], retry: { toLayerId: 'build', maxRounds: 2 } },
        ],
        builtin: true,
    },
    {
        id: 'review-panel',
        name: '多视角评审线',
        goalHint: '要评审什么？一段代码/一个方案/一份文档；确认对象后多位评审各自独立看一遍。',
        decompose: false,
        layers: [
            { id: 'scope', name: '准备', prompt: '确认评审对象与结论标准；不拆分子任务，整体评审。', hosts: [] },
            { id: 'panel', name: '评审', prompt: '独立评审整个对象，先声明侧重视角（实现边界 / 逻辑契约 / 架构可维护性，各负责一面不重复）；代码对象先用 open-code-review-delegate skill 审查（ocr 圈文件配规则，diff 由你阅读），再结合视角判断；没有发现问题的方面也要明确说明已检查。', hosts: [narrativeHost('teddy'), narrativeHost('maeve'), narrativeHost('bernard')] },
            { id: 'verdict', name: '裁决', prompt: '合并各视角结论：去重归并成统一问题清单（保留最高严重度）；给出裁决（通过 / 有条件通过 / 打回）、理由、通过前必须完成的事项；结论要落到具体下一步动作。', hosts: [narrativeHost('dolores')] },
        ],
        builtin: true,
    },
    {
        id: 'fix-line',
        name: '修复线',
        goalHint: '要修复什么？问题描述 + 期望行为；当前会话先出基石与子任务，等你确认后执行。',
        layers: [
            { id: 'locate', name: '定位', prompt: '定位根因：沿问题路径排查，每个结论给出依据（哪段代码或哪个状态推出）；无法确定根因时明确列出存疑点，不要猜测。', hosts: [] },
            { id: 'repair', name: '修复', prompt: '按定位结论实施修复：只修已确认的根因，过程中发现的其他问题只记录不处理；产出包含改动清单和验证证据（修复前失败、修复后通过的结果）。', hosts: [narrativeHost('teddy', '', '', 3)] },
            { id: 'recheck', name: '复审', prompt: '双重复核修复结果：重新走一遍原问题的复现路径确认已修复；对新改动用 open-code-review-delegate skill 审查（ocr 圈文件配规则，diff 由你阅读）；不合格的退回重修。', hosts: [narrativeHost('maeve')], retry: { toLayerId: 'repair', maxRounds: 2 } },
        ],
        builtin: true,
    },
];
const ID_RE = /^[a-z][a-z0-9-]*$/u;
function validateHost(raw, field) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        throw new Error(`${field} 必须是对象`);
    const a = raw;
    if (typeof a.hostId !== 'string' || a.hostId.trim() === '' || /[\r\n]/.test(a.hostId)) {
        throw new Error(`${field}.hostId 不能为空，且不能含换行`);
    }
    if (a.hostId.length > 64)
        throw new Error(`${field}.hostId 不能超过 64 字`);
    if (typeof a.agent !== 'string' || /[\r\n]/.test(a.agent))
        throw new Error(`${field}.agent 必须是不含换行的字符串`);
    if (typeof a.model !== 'string' || /[\r\n]/.test(a.model))
        throw new Error(`${field}.model 必须是不含换行的字符串`);
    // agent/model 会原样进入生成的故事线消息：同样需要长度上限，防 store 膨胀与消息污染
    if (a.agent.length > AGENT_MODEL_MAX_CHARS || a.model.length > AGENT_MODEL_MAX_CHARS) {
        throw new Error(`${field}.agent/model 不能超过 ${AGENT_MODEL_MAX_CHARS} 字`);
    }
    if (!Number.isInteger(a.parallel) || a.parallel < 1 || a.parallel > PARALLEL_MAX) {
        throw new Error(`${field}.parallel 必须是 1–${PARALLEL_MAX} 的整数`);
    }
    return { hostId: a.hostId.trim(), agent: a.agent.trim(), model: a.model.trim(), parallel: a.parallel };
}
/**
 * 校验一条模板的原始输入（HTTP PUT 或 store 文件），非法即 throw。
 * 结构约束：至少一环；回溯只出现在非首环且目标必须是更早的环。
 * 环职责由位置决定（首环=当前会话拆解 / 末环收束 / 带回溯 = 质检），无类型字段。
 * @param raw - 任意来源的原始对象。
 * @returns 通过校验的模板（缺省字段已补齐；未知字段如旧版 kind 自然剥离）。
 */
export function validateNarrativeTemplate(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('故事线模板必须是对象');
    }
    const r = raw;
    if (typeof r.id !== 'string' || !ID_RE.test(r.id) || r.id.length > 64)
        throw new Error('故事线模板 id 必须是小写字母开头的短横线串，且不超过 64 字');
    if (typeof r.name !== 'string' || r.name.trim() === '' || /[\r\n《》]/.test(r.name))
        throw new Error('故事线模板 name 不能为空，且不能含换行或书名号');
    if (r.name.trim().length > 24)
        throw new Error('故事线模板 name 不能超过 24 字');
    // goalHint 可缺省（提示性字段，不参与生成）；提供时才校验类型与长度
    if (r.goalHint !== undefined && (typeof r.goalHint !== 'string' || r.goalHint.trim().length > 160)) {
        throw new Error('故事线模板 goalHint 必须是不超过 160 字的字符串');
    }
    // decompose 可缺省（默认 true=第一步拆分子任务）；提供时只接受布尔
    if (r.decompose !== undefined && typeof r.decompose !== 'boolean') {
        throw new Error('故事线模板 decompose 必须是布尔值');
    }
    if (!Array.isArray(r.layers) || r.layers.length === 0)
        throw new Error('故事线模板 layers 必须是非空数组');
    if (r.layers.length > NARRATIVE_LAYERS_MAX)
        throw new Error(`故事线模板环数不能超过 ${NARRATIVE_LAYERS_MAX}`);
    const layerIds = new Set();
    const layers = r.layers.map((layer, i) => {
        if (typeof layer !== 'object' || layer === null || Array.isArray(layer))
            throw new Error(`layers[${i}] 必须是对象`);
        const l = layer;
        if (typeof l.id !== 'string' || !ID_RE.test(l.id) || l.id.length > 64)
            throw new Error(`layers[${i}].id 必须是小写字母开头的短横线串，且不超过 64 字`);
        if (layerIds.has(l.id))
            throw new Error(`layers[${i}].id 重复：${l.id}`);
        layerIds.add(l.id);
        if (typeof l.name !== 'string' || l.name.trim() === '' || /[\r\n《》]/.test(l.name))
            throw new Error(`layers[${i}].name 不能为空，且不能含换行或书名号`);
        if (l.name.length > 24)
            throw new Error(`layers[${i}].name 不能超过 24 字`);
        if (typeof l.prompt !== 'string' || l.prompt.trim() === '' || l.prompt.length > LAYER_PROMPT_MAX_CHARS) {
            throw new Error(`layers[${i}].prompt 不能为空，且不能超过 ${LAYER_PROMPT_MAX_CHARS} 字`);
        }
        // 字段读侧兼容旧名 actors（改名前落盘的 store/手写 config）：输入认两个键，输出统一 hosts
        const rawHosts = Array.isArray(l.hosts) ? l.hosts : l.actors;
        if (!Array.isArray(rawHosts))
            throw new Error(`layers[${i}].hosts 必须是数组`);
        // 首环（拆解）固定在当前会话执行，不需要接待员：允许空数组，配了也归一丢弃
        // （执行环=slice(1)，首环接待员永远不会被消费，保留只会成为 API 直写的死数据）
        if (i !== 0 && rawHosts.length === 0)
            throw new Error(`layers[${i}].hosts 必须是非空数组（首环之外每环至少一位接待员）`);
        if (rawHosts.length > HOSTS_PER_LAYER_MAX)
            throw new Error(`layers[${i}].hosts 每环接待员不能超过 ${HOSTS_PER_LAYER_MAX}`);
        const hosts = rawHosts.map((a, j) => validateHost(a, `layers[${i}].hosts[${j}]`));
        let retry;
        if (l.retry !== undefined) {
            // 回溯=质检环的来源：任何非首环都可配（首环没有更早的目标，硬约束）
            if (i === 0)
                throw new Error(`layers[0].retry 首环不能配回溯（没有更早的环可打回）`);
            if (typeof l.retry !== 'object' || l.retry === null)
                throw new Error(`layers[${i}].retry 必须是对象`);
            const rt = l.retry;
            if (typeof rt.toLayerId !== 'string' || !ID_RE.test(rt.toLayerId))
                throw new Error(`layers[${i}].retry.toLayerId 必须是合法环 id`);
            // 回溯只能打回更早的环（目标索引 < 当前索引，构造时校验）
            const layersRaw = r.layers;
            const retryTargetIndex = layersRaw.findIndex(x => x?.id === rt.toLayerId);
            // -1（目标缺失）也要拒绝：findIndex -1 < i 会绕过"更早"检查，生成引用不存在环的故事线
            if (retryTargetIndex === -1 || retryTargetIndex >= i) {
                throw new Error(`layers[${i}].retry.toLayerId 必须指向更早的环`);
            }
            if (!Number.isInteger(rt.maxRounds) || rt.maxRounds < 1 || rt.maxRounds > 3) {
                throw new Error(`layers[${i}].retry.maxRounds 必须是 1–3 的整数`);
            }
            retry = { toLayerId: rt.toLayerId, maxRounds: rt.maxRounds };
        }
        return { id: l.id, name: l.name.trim(), prompt: l.prompt.trim(), hosts: i === 0 ? [] : hosts, ...(retry === undefined ? {} : { retry }) };
    });
    return {
        id: r.id,
        name: r.name.trim(),
        goalHint: typeof r.goalHint === 'string' ? r.goalHint.trim() : '',
        layers,
        ...(r.builtin === true ? { builtin: true } : {}),
        ...(r.decompose === undefined ? {} : { decompose: r.decompose }),
    };
}
/**
 * 旧版（v0.0.5 早期 roles 形状）store 条目 → 统一环模型迁移。
 * 环序按旧 kind 重建，旧角色表（roles）映射到对应环的接待员表；无法识别的形状 throw
 * （由调用方丢弃该条并降级）。另：v0.0.5 中期带 kind 的环序条目无需此
 * 迁移——validate 构造时自然剥离未知字段。
 * @param raw - store 里的旧模板对象。
 */
export function migrateLegacyTemplate(raw) {
    if (typeof raw !== 'object' || raw === null)
        throw new Error('旧模板必须是对象');
    const r = raw;
    if (!Array.isArray(r.roles) || typeof r.kind !== 'string')
        throw new Error('无法识别的旧模板形状');
    const hostOf = (slot) => {
        const hit = r.roles.find(x => x.slot === slot);
        return typeof hit?.hostId === 'string' ? hit.hostId : 'dolores';
    };
    const name = typeof r.name === 'string' ? r.name : r.id;
    const base = { id: r.id, name, goalHint: r.goalHint ?? '', ...(r.kind === 'review' ? { decompose: false } : {}) };
    const builders = {
        feature: () => [
            { id: 'design', name: '拆解', prompt: '相关改动合并、有依赖的合并、每个子任务自包含。', hosts: [] },
            { id: 'build', name: '实现', prompt: '按子任务实现，产出改动清单；不做任务外的改动。', hosts: [{ hostId: hostOf('builder'), agent: '', model: '', parallel: 2 }] },
            { id: 'review', name: '质检', prompt: '逐个子任务检查：通过 / 不通过 + 具体问题（文件:行号 + 一句话，不整段摘抄）；只读 diff 涉及的文件；整体问题单独列出，附交付摘要与遗留事项。', hosts: [{ hostId: hostOf('reviewer'), agent: '', model: '', parallel: 1 }], retry: { toLayerId: 'build', maxRounds: 2 } },
        ],
        review: () => [
            { id: 'scope', name: '准备', prompt: '确认评审对象与结论标准；不拆分子任务，整体评审。', hosts: [] },
            { id: 'panel', name: '评审', prompt: '从自己侧重的视角评审整体：问题清单 + 严重度 + 改进建议。', hosts: ['eye-build', 'eye-user', 'eye-arch'].map(s => ({ hostId: hostOf(s), agent: '', model: '', parallel: 1 })) },
            { id: 'verdict', name: '裁决', prompt: '合并各视角结论，产出裁决：通过/有条件通过/打回，附统一问题清单。', hosts: [{ hostId: hostOf('judge'), agent: '', model: '', parallel: 1 }] },
        ],
        fix: () => [
            { id: 'locate', name: '定位', prompt: '读相关代码与上下文，输出定位结论：根因、涉及文件、修复思路。', hosts: [] },
            { id: 'repair', name: '修复', prompt: '按定位结论实施修复，输出改动与验证方式。', hosts: [{ hostId: hostOf('fixer'), agent: '', model: '', parallel: 3 }] },
            { id: 'recheck', name: '复审', prompt: '只验证退回的子任务是否修复（原问题重走一遍）：通过 / 不通过 + 具体问题（文件:行号 + 一句话）。不做其他文件的扩展检查。', hosts: [{ hostId: hostOf('recheck'), agent: '', model: '', parallel: 1 }], retry: { toLayerId: 'repair', maxRounds: 2 } },
        ],
    };
    // Object.hasOwn 防原型键（__proto__/constructor）解析成 Object 本身
    const build = Object.hasOwn(builders, r.kind) ? builders[r.kind] : undefined;
    if (build === undefined)
        throw new Error(`无法迁移的旧模板 kind：${String(r.kind)}`);
    return validateNarrativeTemplate({ ...base, layers: build() });
}
/**
 * 合并三层来源：config（YAML）为基底，store 覆盖同 id，墓碑跳过。
 * 超出 NARRATIVES_MAX 即 throw（静默截断会让模板不可见也不可管）。
 * @param configRules - 配置文件声明的模板。
 * @param storeRules - store 文件里的运行时编辑。
 * @param deletedIds - 墓碑（内置/config 来源被删时防复活）。
 * @returns 合并视图（store 未覆盖的内置/config 在前，store 附加在后）。
 */
export function mergeNarratives(configRules, storeRules, deletedIds) {
    // 基底（内置 + config）按声明顺序；store 同 id 覆盖原位（编辑胜出），
    // store 独有的追加在后；墓碑（防复活）对两个来源都生效。
    // base 按 id 去重：config 复用内置 id 时覆盖内置（否则同 id 双份让 PUT/DELETE/选中全部歧义）
    const baseById = new Map([...BUILTIN_TEMPLATES, ...configRules.map(c => validateNarrativeTemplate(c))].map(t => [t.id, t]));
    const base = [...baseById.values()].filter(t => !deletedIds.has(t.id));
    const storeById = new Map(storeRules.map(t => [t.id, t]));
    const out = base.map(t => storeById.get(t.id) ?? t);
    const baseIds = new Set(base.map(t => t.id));
    // storeById.values() 去重：手改 store 出现同 id 双条目时不重复进视图
    for (const t of storeById.values()) {
        if (deletedIds.has(t.id) || baseIds.has(t.id))
            continue;
        out.push(t);
    }
    if (out.length > NARRATIVES_MAX)
        throw new Error(`故事线模板超过上限 ${NARRATIVES_MAX}`);
    // 名字是轨迹《标记》归档故事线的唯一依据：重名会让场次挂错故事线，装载即拒绝
    const names = new Set();
    const ids = new Set(out.map(t => t.id));
    for (const t of out) {
        if (names.has(t.name))
            throw new Error(`故事线模板名重复："${t.name}"（轨迹按名归档，必须唯一）`);
        // 命令层把 id 与 name 当等价选取键：名字撞上另一模板的 id 会让显式点名被静默选错
        if (ids.has(t.name) && t.name !== t.id)
            throw new Error(`故事线模板名与另一模板 id 冲突："${t.name}"`);
        names.add(t.name);
    }
    return out;
}
/** 内置故事线 id 集（视图据此标注 内置/已定制 徽标）——由内置清单派生，新增内置条目自动跟进。 */
export const BUILTIN_TEMPLATE_IDS = BUILTIN_TEMPLATES.map(t => t.id);
/** FNV-1a 32 位哈希（版本指纹用；非加密，只为变化检测）。 */
function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
}
/** 故事线集版本指纹：模板全量语义（含提示词）+ 选中态。
 *  SSE 广播帧剥离提示词后靠它让客户端发现「模板变了，该重新拉全文」。 */
export function storylinesVersion(templates, selectedTemplateId) {
    return fnv1a(JSON.stringify({ templates, selectedTemplateId }));
}
/** 装载期三源（内置/config/store）软去重与容量收敛（纯函数，诊断经 warn 回调外泄）。
 *  冲突条目只丢该条并 warn——不让一条重名配置把用户声明的全部模板拖进兜底清空；
 *  容量按合并基底（内置 ∪ config，按 id 去重）计：覆盖内置的条目不占新增额度，
 *  超量按 config 声明顺序保留能装下的（故事线是软功能，超量不炸装载）。 */
export function assembleNarrativeTemplates(builtin, config, store, opts) {
    const builtinIds = builtin.map(t => t.id);
    // 覆盖语义：同 id 是替换（config 覆盖内置、store 覆盖 config/内置都合法），
    // 占位种子要先把「已被覆盖的内置」排除，否则编辑内置（store 同 id 同名副本）会被误丢
    const overriddenByConfig = new Set(config.map(t => t.id));
    const overriddenByStore = new Set(store.map(s => s.id).filter(id => builtinIds.includes(id)));
    const takenNames = new Set();
    const takenIds = new Set();
    for (const b of builtin) {
        if (overriddenByConfig.has(b.id) || overriddenByStore.has(b.id))
            continue;
        takenNames.add(b.name);
        takenIds.add(b.id);
    }
    // config 幸存集（同名/名撞 id 软丢）+ 容量收敛（config 内部重复 id 静默跳过，与装载逐条校验同语义）
    const keptConfig = [];
    const seenConfigIds = new Set();
    let added = 0; // 不覆盖内置的新增条数（config 优先占额，store 用剩余额度）
    for (const t of config) {
        if (seenConfigIds.has(t.id))
            continue;
        seenConfigIds.add(t.id);
        if (takenNames.has(t.name) || (t.name !== t.id && takenIds.has(t.name))) {
            opts.warn(`dsh-maze 故事线配置 "${t.name}" 与已有模板重名，已跳过`);
            continue;
        }
        const overridesBuiltin = builtinIds.includes(t.id);
        if (!overridesBuiltin && builtinIds.length + added >= opts.max) {
            opts.warn(`dsh-maze narratives 超出 ${opts.max} 条上限，丢弃: ${t.id}`);
            continue;
        }
        if (!overridesBuiltin)
            added++;
        takenNames.add(t.name);
        takenIds.add(t.id);
        keptConfig.push(t);
    }
    // store 幸存集：撞未覆盖内置的名字、名字撞任何已占 id（merge 的 ids.has(name) 交叉硬约束）、
    // store 内部同名/交叉（顺序累加占位自然处理双条目）；与 config 同规则做容量软收敛——
    // 否则手改 store 超限会触发 mergeNarratives 硬 throw，装载降级清空整个 store（破坏性落盘）
    const keptStore = store.filter(s => {
        if (takenNames.has(s.name)) {
            opts.warn(`dsh-maze narratives store 条目 "${s.name}" 重名，已跳过`);
            return false;
        }
        if (s.name !== s.id && takenIds.has(s.name)) {
            opts.warn(`dsh-maze narratives store 条目 "${s.name}" 与已有模板 id 冲突，已跳过`);
            return false;
        }
        const overridesBuiltin = builtinIds.includes(s.id);
        if (!overridesBuiltin && builtinIds.length + added >= opts.max) {
            opts.warn(`dsh-maze narratives store 超出 ${opts.max} 条上限，丢弃: ${s.id}`);
            return false;
        }
        if (!overridesBuiltin)
            added++;
        takenNames.add(s.name);
        takenIds.add(s.id);
        return true;
    });
    return { config: keptConfig, store: keptStore };
}
