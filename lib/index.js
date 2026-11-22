/**
 * dsh-maze 宿主半边（Maze 个人助手框架；右下角常驻的接待员名叫 Dolores）：
 * - llm/stream 观察（model-call 规则）+ 30s tick 调度器（cron 规则）
 * - 会话事件流 → Dolores 神态镜像（narrative.ts，供客户端微动效与台词）
 * - 规则装载校验（fail-loud）与 config/store 合并持久化（tombstone 语义见 reminders/store.ts）
 * - HTTP 路由：GET/POST /maze/reminders/{state,ack,rule,preview}、GET/PUT /maze/appearance、
 *   GET/PUT /maze/notes/、GET/PUT/DELETE /maze/narratives/{state,template}、POST /maze/narratives/compose
 *   GET /maze/events（SSE 状态推送）
 * - /maze-story 斜杠命令：合成故事线消息直达当前会话（agent.followup）
 * - 同源信任栅栏 + 请求体上限（回环 socket 平台免鉴权，需自挡恶意网页的
 *   cross-site fetch）
 *
 * 纯 UI 提醒：不向模型上下文注入任何内容（故事线命令例外：那是用户显式
 * 触发的用户消息，透明进 transcript）。
 * 模块化预留：提醒中心（reminders）是 Maze 的第一个功能模块，路由统一挂
 * /maze/reminders/* 前缀；未来新模块各占 /maze/<module>/* 与设置页一个 tab。
 */
import z from '@deepseek-ai/schemastery';
import { join } from 'node:path';
import { compileWhen, evaluateModelCall, localDateKey, muteRuleForToday, observe, observeTick, renderMessage, setRuleEnabled, } from './reminders/engine.js';
import { matchesCron, nextCronMatch, parseCron } from './reminders/cron.js';
import { validateRule } from './reminders/validate.js';
import { loadStoreSync, mergeRules, pluginRoot, resolveDataDir, saveStoreSync } from './reminders/store.js';
import { DEFAULT_APPEARANCE, loadAppearanceSync, resolveDefaultAppearance, saveAppearanceSync, validateAppearance } from './appearance.js';
import { currentDemeanor, narrativeEventToDemeanor, pickDemeanorRecord } from './narrative.js';
import { loadNotesConfigSync, saveNotesConfigSync, emptyNotesConfig, validateNotesConfig } from './notes/config.js';
import { VikunjaNoteStore } from './notes/vikunja.js';
import { BUILTIN_TEMPLATE_IDS, BUILTIN_TEMPLATES, NARRATIVES_MAX, assembleNarrativeTemplates, mergeNarratives, storylinesVersion, validateNarrativeTemplate } from './narratives.js';
import { loadNarrativesSync, narrativesPathOf, saveNarrativesSync } from './narrative-store.js';
import { composeNarrativeMessage } from './narrative-script.js';
import { davRequest, loadSyncConnection, saveSyncConnection, summarizeBundle, validateSyncBundle, validateSyncConnection } from './sync.js';
import { hostname } from 'node:os';
import { closeStaleRuns, loadRunsSync, projectSessionEvent, runsPathOf, saveRunsSync } from './runs.js';
import { NotifyTracker } from './notify.js';
export const name = 'dsh-maze';
/** 调度器节拍：30s。分钟级 cron 的去重由引擎的 lastCronMinute 保证 */
const TICK_MS = 30_000;
/** 历史保留条数 */
const HISTORY_LIMIT = 50;
export const Config = z.object({
    rules: z.array(z.any()).default([
        // 默认规则与文档示例一致：GLM 高峰时段额度提醒
        { id: 'glm-peak-hours', name: 'GLM 高峰时段提醒', message: '当前 {model}（{provider}）额度消耗较快，建议切换其他模型', startHour: 14, endHour: 18, modelPattern: '*glm*', maxPerDay: 2, cooldownMinutes: 120 },
    ]),
    // 附加故事线模板（内置三条为基底；同 id 覆盖）
    narratives: z.array(z.any()).default([]),
});
/** JSON 响应统一出口 */
function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
}
/** 常规路由请求体上限；外观 PUT 含 base64 大图单独放宽 */
const BODY_MAX_DEFAULT = 64 * 1024;
const BODY_MAX_APPEARANCE = 8 * 1024 * 1024;
// 故事线模板 body 上限：覆盖 12 环 × 2000 字中文提示词的最坏体积
const BODY_MAX_NARRATIVES = 256 * 1024;
/**
 * 读 JSON 请求体；坏 JSON / 请求中断（error 事件）/ 超过 maxBytes 都返回 undefined（路由回 400）。
 * 超限即停止缓冲并销毁连接（宁可断流，不缓冲无上限的 body）。
 */
export function readJsonBody(req, maxBytes = BODY_MAX_DEFAULT) {
    return new Promise((resolveBody) => {
        // 缓冲原始 Buffer、结束时一次解码：逐块 String(chunk) 会把跨块的多字节
        // UTF-8 字符拆成 U+FFFD；上限按真实字节计（data.length 数的是 UTF-16 单元）
        const chunks = [];
        let size = 0;
        let overflow = false;
        req.on('data', (chunk) => {
            if (overflow)
                return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''), 'utf8');
            size += buf.length;
            if (size > maxBytes) {
                overflow = true;
                req.destroy?.();
                resolveBody(undefined);
                return;
            }
            chunks.push(buf);
        });
        // 客户端提前断开：resolve 掉悬空的 Promise，不等待永远不会来的 end
        req.on('error', () => resolveBody(undefined));
        req.on('end', () => {
            if (overflow || chunks.length === 0)
                return resolveBody(undefined);
            try {
                resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            }
            catch {
                resolveBody(undefined);
            }
        });
    });
}
/** 大小写不敏感取请求头（Node 的 headers 本身全小写，这里防御任意形状） */
function headerOf(req, name) {
    const headers = req.headers;
    if (headers === undefined)
        return undefined;
    const raw = headers[name] ?? headers[name.toLowerCase()];
    if (typeof raw === 'string')
        return raw;
    if (Array.isArray(raw) && typeof raw[0] === 'string')
        return raw[0];
    return undefined;
}
/**
 * 同源信任栅栏：dsh 平台对回环 socket 免鉴权，意味着任何
 * 本地进程与恶意网页的 drive-by fetch 都能打到 /maze/* 路由。浏览器跨站请求必然携带
 * sec-fetch-site 或 Origin 之一，在这里拒掉；curl 等不带浏览器标记的本地工具不受影响。
 */
export function isSameOriginRequest(req) {
    const fetchSite = headerOf(req, 'sec-fetch-site');
    // 'none' = 地址栏直达/书签等非页面发起，放行
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none')
        return false;
    const origin = headerOf(req, 'origin');
    if (origin !== undefined) {
        const host = headerOf(req, 'host') ?? '';
        try {
            // Origin 含端口，须与 Host（含端口）全等才放行
            if (new URL(origin).host !== host)
                return false;
        }
        catch {
            // 非 URL 形状的 Origin 一律不信任
            return false;
        }
    }
    return true;
}
/** 注册统一入口：先过同源栅栏再进 handler（403 拒绝跨站浏览器请求） */
function registerRoute(webServer, path, handler) {
    return webServer.register({ kind: 'exact', path, handler: (req, res) => {
            if (!isSameOriginRequest(req))
                return sendJson(res, 403, { error: 'cross-origin request rejected' });
            return handler(req, res);
        } });
}
// ctx 显式 any：插件不依赖 @deepseek-ai/cordis 运行时类型包（peer 由宿主
// 进程提供、独立 tsconfig 不引它的 d.ts），事件表/服务注入靠宿主侧声明合并
export function apply(ctx, config) {
    // 走一次 schema 实例调用补全默认值（schemastery 运行时归一化）
    const cfg = Config(config);
    // ---- 装载：config 校验 → 迁移 → store 合并 → 派生编译表 --------------------------
    // when/locked 只在文件装载路径放行（config 是用户自己的 cordis.patch.yml）
    const configRules = cfg.rules.map(r => validateRule(r, { allowWhen: true, allowLocked: true }));
    const dataDir = resolveDataDir(pluginRoot());
    // store 损坏不阻断宿主：退回纯 config 规则集并告警（编辑落盘失效但提醒可用）
    let storeRules = [];
    let deletedIds = [];
    try {
        const store = loadStoreSync(dataDir);
        storeRules = store.rules;
        deletedIds = store.deletedIds;
    }
    catch (err) {
        ctx.logger?.warn?.(`dsh-maze store 读取失败，忽略运行时编辑: ${String(err)}`);
    }
    let rules = mergeRules(configRules, storeRules, deletedIds);
    // 外观偏好：文件缺失=资产版出厂默认（背景/头像随插件发行）；损坏也只退回
    // 纯内置默认（外观不值得阻断装载）
    let appearance;
    try {
        appearance = loadAppearanceSync(dataDir, () => resolveDefaultAppearance(join(pluginRoot(), 'assets')));
    }
    catch (err) {
        // 走 validateAppearance 拿深克隆（lines 不与模块级 DEFAULT_LINES 共享引用）
        appearance = validateAppearance(DEFAULT_APPEARANCE);
        ctx.logger?.warn?.(`dsh-maze appearance 读取失败，使用默认外观: ${String(err)}`);
    }
    // 小记连接配置：文件缺失=未配置（UI 引导去设置页）；损坏也只降级为未配置
    // （小记是软功能，不值得阻断插件装载），与 appearance 同策略
    let notes;
    try {
        notes = loadNotesConfigSync(dataDir);
    }
    catch (err) {
        notes = emptyNotesConfig();
        ctx.logger?.warn?.(`dsh-maze notes 配置读取失败，按未配置处理: ${String(err)}`);
    }
    // ---- 故事线：模板（内置基底 + config 附加 + store 覆盖/墓碑）与故事线场次 --------
    // 故事线是软功能：config 单条非法只跳过该条（warn），不拖垮提醒/外观/小记
    let configNarratives = [];
    for (const raw of cfg.narratives) {
        try {
            configNarratives.push(validateNarrativeTemplate(raw));
        }
        catch (err) {
            ctx.logger?.warn?.(`dsh-maze narratives 配置条目非法，已跳过: ${String(err)}`);
        }
    }
    let narrativeStoreTemplates = [];
    let narrativeDeletedIds = [];
    // 输入框工具行 chip 的选中故事线（'' = 未选择）；斜杠命令不带模板名时用它
    let narrativeSelectedId = '';
    const narrativesPath = narrativesPathOf(dataDir);
    try {
        const store = loadNarrativesSync(narrativesPath);
        narrativeStoreTemplates = store.templates;
        narrativeDeletedIds = store.deletedIds;
        narrativeSelectedId = store.selectedTemplateId;
    }
    catch (err) {
        // 与 store 同策略：损坏只损失运行时编辑，内置模板仍可用
        ctx.logger?.warn?.(`dsh-maze narratives store 读取失败，忽略运行时编辑: ${String(err)}`);
    }
    // 冲突软去重与容量收敛（纯函数 assembleNarrativeTemplates，测试在 narratives.test.ts）：
    // 名字撞名字、名字撞 id 跨三源只丢冲突条目（warn），不让一条重名配置把用户声明的全部模板
    // 拖进兜底清空；mergeNarratives 的硬约束兜底只剩真正意外的情况。
    {
        const assembled = assembleNarrativeTemplates(BUILTIN_TEMPLATES, configNarratives, narrativeStoreTemplates, {
            max: NARRATIVES_MAX,
            warn: m => ctx.logger?.warn?.(m),
        });
        configNarratives = [...assembled.config];
        narrativeStoreTemplates = [...assembled.store];
    }
    let narrativeTemplates;
    try {
        narrativeTemplates = mergeNarratives(configNarratives, narrativeStoreTemplates, new Set(narrativeDeletedIds));
    }
    catch (err) {
        // 故事线是软功能：合并超限/重名等配置错误只丢故事线，不拖垮提醒/外观/小记。
        // 降级必须整组重置 store 派生态——否则视图丢了 store 副本而 origin/选中态/后续 PUT 仍引用它们，三态分叉
        ctx.logger?.warn?.(`dsh-maze narratives 合并失败，回退内置+配置基底: ${String(err)}`);
        narrativeStoreTemplates = [];
        narrativeDeletedIds = [];
        narrativeSelectedId = '';
        // 同步落盘空 store：磁盘若仍留旧内容，后续任何一次 commit 都会用已清空的内存覆盖它，
        // 把只是被本次降级隐藏的运行时编辑永久丢弃（内存/磁盘分叉）
        try {
            saveNarrativesSync(narrativesPath, [], [], '');
        }
        catch { /* 落盘失败不阻断降级 */ }
        try {
            narrativeTemplates = mergeNarratives(configNarratives, [], new Set());
        }
        catch (err2) {
            // 配置自身也合并不了（如重名）：最后退到纯内置，故事线线绝不拖垮其他模块
            ctx.logger?.warn?.(`dsh-maze narratives 基底合并失败，回退内置模板: ${String(err2)}`);
            configNarratives = []; // 不清空的话后续每次 PUT/DELETE 都会重炸同一样的合并错误
            narrativeTemplates = mergeNarratives([], [], new Set());
        }
    }
    // 盘上选中可能指向墓碑/被丢弃的模板：合并视图定型后重置失效引用（chip 回「未选择」）。
    // 只改内存不回写盘：磁盘惰性收敛——下次选中态变更落盘时自然带上，避免装载期多余一次写盘
    if (narrativeSelectedId !== '' && !narrativeTemplates.some(t => t.id === narrativeSelectedId)) {
        narrativeSelectedId = '';
    }
    // 版本指纹缓存：storylinesVersion 对全量模板（含提示词）做 stringify+fnv1a，最坏数百 KB；
    // 只在模板集/选中变更点重算（装载链与 commitNarratives），广播帧与 statePayload 只读缓存，
    // 否则活跃会话 500ms 节流下每次广播都白付一次全量序列化。
    const narrativeVersionRef = { value: storylinesVersion(narrativeTemplates, narrativeSelectedId) };
    /** 模板集变更统一出口：先算合并视图（可能因超限/重名 throw），成功才落盘与改内存 */
    function commitNarratives(nextTemplates, nextDeleted) {
        const merged = mergeNarratives(configNarratives, nextTemplates, new Set(nextDeleted));
        saveNarrativesSync(narrativesPath, nextTemplates, nextDeleted, narrativeSelectedId);
        narrativeStoreTemplates = [...nextTemplates];
        narrativeDeletedIds = [...nextDeleted];
        narrativeTemplates = merged;
        narrativeVersionRef.value = storylinesVersion(narrativeTemplates, narrativeSelectedId);
    }
    /** 模板视图：附环名链与来源徽标（builtin=未定制 / overridden=内置被覆盖 / custom=自建）；
     *  withPrompt=false 时剥掉每环提示词（SSE 广播帧瘦身用；全文走按需 GET）。 */
    const templateView = (t, withPrompt = true) => ({
        ...t,
        layers: withPrompt ? t.layers : t.layers.map(l => ({ ...l, prompt: '' })),
        stages: t.layers.map(l => l.name),
        // 来源徽标：store 或 config 任一层覆盖了内置 id 都算"已定制"
        origin: (narrativeStoreTemplates.some(s => s.id === t.id) || configNarratives.some(c => c.id === t.id))
            ? (BUILTIN_TEMPLATE_IDS.includes(t.id) ? 'overridden' : 'custom')
            : 'builtin',
    });
    /** 接待员名册查找（compose 时把 hostId 渲染成显示名） */
    const hostNameOf = (hostId) => appearance.hosts.find(h => h.id === hostId)?.name;
    // 故事线场次：workflow 工具调用的投影留档（最近 RUNS_MAX 场，跨重启持久）
    const runsPath = runsPathOf(dataDir);
    let runs = [];
    // 后台通知状态机：跨会话审批等待 + 待答问题卡 + 卡死观察（纯内存，重启清零）
    const notifyTracker = new NotifyTracker();
    try {
        runs = loadRunsSync(runsPath);
    }
    catch (err) {
        // 场次历史只是记录：损坏即从空重来，不拦插件装载
        ctx.logger?.warn?.(`runs 文件读取失败，从空历史开始: ${String(err)}`);
    }
    {
        // 应用重启后，进行中的旧场次永远等不到结果：关闭为 interrupted（呈现为出岔）
        const closed = closeStaleRuns(runs, Date.now());
        if (closed !== runs) {
            runs = closed;
            try {
                saveRunsSync(runsPath, runs);
            }
            catch { /* 历史记录，落盘失败不拦装载 */ }
        }
    }
    const states = new Map();
    const pending = [];
    const history = [];
    let currentUse = null;
    // Dolores 神态按会话分桶（纯内存）：悬浮球跟随用户正在看的会话，多会话并行
    // 不互相串台。session/event 自带会话身份直接入桶；llm/stream 无会话标识，
    // 归给最近活跃的会话（模型调用总发生在某个会话的 turn 内，而该会话在调用
    // 前后必有事件流出）。
    const demeanorBySession = new Map();
    let lastActiveSessionId;
    /** 桶数量上限：防长期运行（每天大量临时会话）内存膨胀，按记录时间淘汰最旧 */
    const NARRATIVE_SESSIONS_MAX = 32;
    function recordDemeanor(sessionId, record) {
        demeanorBySession.set(sessionId, record);
        if (demeanorBySession.size > NARRATIVE_SESSIONS_MAX) {
            let oldestKey;
            let oldestAt = Infinity;
            for (const [key, r] of demeanorBySession) {
                if (r.at < oldestAt) {
                    oldestAt = r.at;
                    oldestKey = key;
                }
            }
            // 刚写入的桶永不淘汰（即使它最旧也说明其它桶更新）
            if (oldestKey !== undefined && oldestKey !== sessionId)
                demeanorBySession.delete(oldestKey);
        }
    }
    /** when 表达式与 cron 匹配器的派生表（装载与每次规则变更后重建） */
    const compiled = new Map();
    const cronSpecs = new Map();
    function rebuildDerived() {
        compiled.clear();
        cronSpecs.clear();
        for (const r of rules) {
            compiled.set(r.id, compileWhen(r.when));
            if (r.trigger === 'cron') {
                // validateRule（config 与 store 装载路径都跑）已保证 cron 规则 schedule 可解析
                const spec = parseCron(r.schedule ?? '');
                cronSpecs.set(r.id, (at) => matchesCron(spec, at));
            }
        }
    }
    rebuildDerived();
    /** 规则集变更统一出口：先落盘后改内存（写失败时内存与磁盘保持旧值一致），再合并重建（调用方保证已过校验与 locked 检查） */
    function commitStore(nextRules, nextDeleted) {
        saveStoreSync(dataDir, nextRules, nextDeleted);
        storeRules = [...nextRules];
        deletedIds = [...nextDeleted];
        rules = mergeRules(configRules, storeRules, deletedIds);
        rebuildDerived();
    }
    /** state 路由负载：规则快照（含运行时状态）+ 当前模型 + pending + 历史 + 神态。
     *  session 指定 时 narrative 取该会话的桶；narratives 附全量分桶供 SSE 客户端各自挑选。
     *  withPrompts=false 供 SSE 广播：剥离环提示词（最坏 12×12×2000 字≈288KB → KB 级），
     *  narrativeVersion 让客户端发现模板语义变化后按需 GET 全文。 */
    function statePayload(session, withPrompts = true) {
        const now = Date.now();
        const today = localDateKey(now);
        const record = pickDemeanorRecord(demeanorBySession, session);
        const narratives = {};
        for (const [id, r] of demeanorBySession)
            narratives[id] = { demeanor: currentDemeanor(r, now), since: r.at };
        return {
            current: currentUse === null ? null : { provider: currentUse.provider, model: currentUse.model, since: currentUse.at },
            narrative: { demeanor: currentDemeanor(record, now), since: record?.at ?? null },
            narratives,
            // 后台通知（跨会话审批等待/卡死）：collectDue 挂在读上有意为之——轮询/广播
            // 驱动补提节律，无需独立定时器
            notifications: notifyTracker.collectDue(now),
            now,
            rules: rules.map(r => {
                const s = states.get(r.id);
                return {
                    ...r,
                    enabled: s?.enabled ?? true,
                    firedToday: s?.firedToday.filter(t => localDateKey(t) === today).length ?? 0,
                    mutedToday: s?.mutedDay === today,
                };
            }),
            pending: pending.map(p => ({ id: p.id, ruleId: p.ruleId, message: p.message, firedAt: p.firedAt })),
            history: history.slice(0, HISTORY_LIMIT),
            // stages 随模板下发：环名表单一事实源在宿主，客户端不再复制一份
            storylines: {
                templates: narrativeTemplates.map(t => templateView(t, withPrompts)),
                runs,
                selectedTemplateId: narrativeSelectedId,
                narrativeVersion: narrativeVersionRef.value,
            },
        };
    }
    // ---- SSE 状态推送 ------------------------------------------------------------------
    // 连接即回发快照；之后状态变化经 scheduleBroadcast 推送。500ms 节流 + 负载不变跳过
    // （流式期间神态不变时零流量）；EventSource 断线自动重连且重连即回发，无需补偿拉取。
    const SSE_THROTTLE_MS = 500;
    const SSE_HEARTBEAT_MS = 30_000;
    const sseClients = new Set();
    let sseLastSent = '';
    let sseFlushTimer;
    let sseLastFlushAt = 0;
    /** 广播帧：剥提示词、剥 now（now 每帧必变会打死去重；客户端只用本地时钟）。 */
    function slimFrame() {
        const snapshot = statePayload(undefined, false);
        delete snapshot.now;
        return JSON.stringify(snapshot);
    }
    function broadcastNow() {
        // 单次序列化：帧字符串即指纹，未变零成本跳过
        const frame = slimFrame();
        if (frame === sseLastSent)
            return;
        sseLastSent = frame;
        for (const client of sseClients)
            client.write(frame);
    }
    function scheduleBroadcast() {
        if (sseFlushTimer !== undefined)
            return;
        const wait = Math.max(0, SSE_THROTTLE_MS - (Date.now() - sseLastFlushAt));
        sseFlushTimer = setTimeout(() => {
            sseFlushTimer = undefined;
            sseLastFlushAt = Date.now();
            broadcastNow();
        }, wait);
    }
    // ---- 观察者：模型调用（llm/stream waterfall 必须 next() 委托）---------------------
    ctx.on('llm/stream', (options, next) => {
        const use = { provider: options.provider, model: options.model, at: Date.now() };
        currentUse = use;
        // 神态归给最近活跃会话（见 demeanorBySession 注释）；尚无任何会话事件时
        // 无法归属，只记模型不记神态
        if (lastActiveSessionId !== undefined)
            recordDemeanor(lastActiveSessionId, { demeanor: 'thinking', at: use.at });
        pending.push(...observe(rules, states, use, compiled));
        scheduleBroadcast();
        return next();
    });
    // ---- 观察者：会话事件流 → Dolores 神态镜像（idle/waiting/thinking/tool/review/done/failed）
    ctx.on('session/event', (session, event) => {
        // 会话身份防御式读取（跨构建 Session 类型可能滞后）
        const sid = typeof session?.id === 'string' ? session.id : undefined;
        if (sid !== undefined)
            lastActiveSessionId = sid;
        // 后台通知：审批等待/问题卡/卡死观察（sid 缺失就不观察——通知必须带准确归属）
        if (sid !== undefined && sid !== '')
            notifyTracker.observe(sid, event.type, event.data, typeof event.time === 'number' ? event.time : Date.now());
        // 故事线运行投影（workflow 工具调用/结果）：先于神态早退，任何事件形状都要过一遍
        // 会话身份缺失（理论上不会）时跳过投影：空串 sessionId 会把该事件混进全局轨迹
        let projected = runs;
        if (sid !== undefined && sid !== '') {
            projected = projectSessionEvent(runs, sid, event, Date.now(), (name) => narrativeTemplates.find(t => t.name === name)?.id ?? '');
        }
        if (projected !== runs) {
            runs = projected;
            try {
                saveRunsSync(runsPath, runs);
            }
            catch (err) {
                // 落盘失败只损失跨重启历史：内存场次照常推进
                ctx.logger?.warn?.(`dsh-maze runs 保存失败: ${String(err)}`);
            }
            scheduleBroadcast();
        }
        // turn/end 的 reason.kind 决定收场神态；字段做防御式读取（跨构建类型表可能滞后于运行时）
        let reasonKind;
        if (event.type === 'turn/end') {
            const reason = event.data?.reason;
            if (reason !== undefined && typeof reason.kind === 'string')
                reasonKind = reason.kind;
        }
        const demeanor = narrativeEventToDemeanor(event.type, reasonKind);
        if (demeanor === undefined || sid === undefined)
            return;
        // 事件时间戳缺失（异常流）时退回当前时间
        const at = typeof event.time === 'number' ? event.time : Date.now();
        recordDemeanor(sid, { demeanor, at });
        scheduleBroadcast();
    });
    // 会话销毁即清理其神态桶（防 map 慢性累积；上限淘汰之外的兜底）
    ctx.on('session/disposed', (session) => {
        const sid = typeof session?.id === 'string' ? session.id : undefined;
        if (sid === undefined || !demeanorBySession.delete(sid))
            return;
        scheduleBroadcast();
    });
    // ---- 调度器：cron tick ------------------------------------------------------------
    ctx.effect(() => {
        const timer = setInterval(() => {
            const fired = observeTick(rules, states, Date.now(), cronSpecs, compiled);
            if (fired.length > 0) {
                pending.push(...fired);
                scheduleBroadcast();
            }
        }, TICK_MS);
        return () => clearInterval(timer);
    });
    // ---- /maze-story 斜杠命令：合成故事线消息直达当前会话（用户显式触发）--------------
    /** 命令体：解析模板选择 + 目标 → 合成故事线 → followup 开启下一轮（异步：createUserMessage 运行时才从宿主解析） */
    async function handleStoryCommand(invocation) {
        const input = invocation.rawInput.trim();
        // 解析顺序：①整段恰好是模板 id/名（显式选故事线、目标空）②「模板 id/名 + 空格 +
        // 目标」的最长前缀匹配（模板名可含空格）③都不是 → 整段就是目标，用工具行 chip
        // 选中的故事线（未选中时报用法）。显式模板始终覆盖 chip 选中。
        let tpl = narrativeTemplates.find(t => t.id === input || t.name === input);
        let goal = '';
        if (tpl === undefined) {
            // 名字可含空格（"foo"与"foo bar"可并存）：收集全部前缀匹配，取最长者，
            // 否则短名会截胡用户明确输入的长名
            let longestKey = '';
            for (const t of narrativeTemplates) {
                for (const key of [t.id, t.name]) {
                    if (input.startsWith(`${key} `) && key.length > longestKey.length) {
                        longestKey = key;
                        tpl = t;
                        goal = input.slice(key.length + 1).trim();
                    }
                }
            }
        }
        if (tpl === undefined) {
            goal = input;
            tpl = narrativeTemplates.find(t => t.id === narrativeSelectedId);
            if (tpl === undefined) {
                const list = narrativeTemplates.map(t => `${t.id}（${t.name}）`).join('、');
                return { kind: 'error', text: input === ''
                        ? `未选中故事线。先在输入框工具行「故事线」chip 选择，或 /maze-story <模板> [目标]。可用：${list}`
                        : `未选中故事线。可用：${list}；或 /maze-story <模板> [目标] 显式指定。` };
            }
        }
        try {
            const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
            const message = composeNarrativeMessage(tpl, hostNameOf, goal);
            // 直达发送：故事线作为带 snapshot 源的上下文消息入队启程——模型收到完整 content，
            // 聊天界面按「上下文注入」折叠卡渲染（与 time-context 同款形态），不刷屏
            await invocation.agent.followup(createUserMessage({
                content: [{ type: 'text', text: message }],
                source: { kind: 'maze-story', form: 'snapshot', sections: [{ name: `故事线启程 · 《${tpl.name}》`, text: message }] },
            }));
            return { kind: 'success', text: `故事线已启程：《${tpl.name}》${goal === '' ? '（当前会话先出基石与子任务清单，等你确认）' : ''}` };
        }
        catch (err) {
            return { kind: 'error', text: `故事线投递失败：${err instanceof Error ? err.message : String(err)}` };
        }
    }
    ctx.inject(['commands'], (cmdCtx) => {
        cmdCtx.effect(() => cmdCtx.commands.register({
            name: 'maze-story',
            description: '开启一条故事线（叙事工作流）',
            input: { hint: '[模板 id 或名] [一句话目标]（不带模板=用工具行选中的故事线）' },
            handler: invocation => handleStoryCommand(invocation),
        }));
    });
    // ---- HTTP 路由（软依赖：无 webServer 服务的宿主组合时静默不装，其余功能不受影响）----
    ctx.inject(['webServer'], (webCtx) => {
        // ---- 小记（notes）路由 ----------------------------------------------------------
        // 每请求新建 store：构造只是归一 baseUrl（无握手状态）；inboxProjectId 从
        // 闭包 notes 提供，onInboxResolved 首次发现后回写落盘加速后续装载
        const noteStore = () => new VikunjaNoteStore({
            baseUrl: notes.baseUrl,
            token: notes.token,
            ...(notes.inboxProjectId === undefined ? {} : { inboxProjectId: notes.inboxProjectId }),
            onInboxResolved: (id) => {
                notes.inboxProjectId = id;
                try {
                    saveNotesConfigSync(dataDir, notes);
                }
                catch (err) {
                    // 回写失败只损失加速：内存 id 已更新，进程重启后重新发现即可
                    ctx.logger?.warn?.(`dsh-maze notes Inbox id 回写失败: ${String(err)}`);
                }
            },
        });
        // 闭包读当前值（PUT config 会整体重赋 notes，注册时求值一次会固化旧状态）
        const notesConfigured = () => notes.baseUrl !== '' && notes.token !== '';
        // 未配置 400、存储侧错误 502 的统一出口，避免每个路由重复 try/catch
        const storeJson = async (res, fn) => {
            if (!notesConfigured())
                return sendJson(res, 400, { error: '小记未配置连接（设置 → 小记 → 保存并测试）' });
            try {
                return await sendJson(res, 200, await fn(noteStore()));
            }
            catch (err) {
                return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
            }
        };
        const disposers = [
            registerRoute(webCtx.webServer, '/maze/events', (req, res) => {
                // SSE：连接即回发快照；之后 broadcastNow 推送。栅栏在 registerRoute 统一入口。
                if (req.method !== 'GET')
                    return sendJson(res, 405, { error: 'method not allowed' });
                res.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache, no-store',
                    connection: 'keep-alive',
                    'x-accel-buffering': 'no',
                });
                // 断线后写入会抛错：吞掉写错误，由 close 统一清理
                res.on?.('error', () => { });
                res.write('retry: 3000\n\n');
                let closed = false;
                const client = {
                    write(payload) {
                        if (closed)
                            return;
                        try {
                            res.write(`data: ${payload}\n\n`);
                        }
                        catch {
                            client.close();
                        }
                    },
                    close() {
                        if (closed)
                            return;
                        closed = true;
                        clearInterval(heartbeat);
                        sseClients.delete(client);
                        try {
                            res.end();
                        }
                        catch { /* 连接已关闭 */ }
                    },
                };
                // 心跳注释行保持空闲连接活性（防中间层/浏览器回收）。
                // 直接 res.write：client.write 会加 data: 前缀，注释行会变成畸形消息帧
                const heartbeat = setInterval(() => {
                    try {
                        res.write(': ping\n\n');
                    }
                    catch {
                        client.close();
                    }
                }, SSE_HEARTBEAT_MS);
                sseClients.add(client);
                // 连接建立即回发当前快照（重连后的补偿也靠这一次回发）
                client.write(slimFrame());
                req.on('close', () => { client.close(); });
                res.on?.('close', () => { client.close(); });
            }),
            registerRoute(webCtx.webServer, '/maze/reminders/state', (req, res) => {
                if (req.method !== 'GET')
                    return sendJson(res, 405, { error: 'method not allowed' });
                // ?session=<id>：神态跟随指定会话（悬浮球/彩蛋传当前会话）；缺省回落最近活跃
                let session;
                try {
                    session = new URL(req.url ?? '', 'http://localhost').searchParams.get('session') ?? undefined;
                }
                catch {
                    session = undefined;
                }
                sendJson(res, 200, statePayload(session === '' ? undefined : session));
            }),
            registerRoute(webCtx.webServer, '/maze/reminders/ack', async (req, res) => {
                if (req.method !== 'POST')
                    return sendJson(res, 405, { error: 'method not allowed' });
                const body = await readJsonBody(req);
                if (body === null || body === undefined || typeof body.reminderId !== 'string' || (body.action !== 'dismiss' && body.action !== 'muteToday')) {
                    return sendJson(res, 400, { error: 'body 应为 {reminderId, action: "dismiss"|"muteToday"}' });
                }
                const idx = pending.findIndex(p => p.id === body.reminderId);
                if (idx === -1)
                    return sendJson(res, 404, { error: `unknown reminder "${body.reminderId}"` });
                const [rem] = pending.splice(idx, 1);
                const action = body.action;
                if (action === 'muteToday')
                    muteRuleForToday(rem.ruleId, states, Date.now());
                history.unshift({ reminderId: rem.id, ruleId: rem.ruleId, message: rem.message, firedAt: rem.firedAt, ackedAt: Date.now(), action });
                if (history.length > HISTORY_LIMIT)
                    history.length = HISTORY_LIMIT;
                scheduleBroadcast();
                sendJson(res, 200, { ok: true });
            }),
            registerRoute(webCtx.webServer, '/maze/reminders/rule', async (req, res) => {
                // POST = 启停开关（locked 规则也允许：只影响运行时，不改规则内容与 store）
                if (req.method === 'POST') {
                    const body = await readJsonBody(req);
                    if (body === null || body === undefined || typeof body.ruleId !== 'string' || typeof body.enabled !== 'boolean') {
                        return sendJson(res, 400, { error: 'body 应为 {ruleId, enabled}' });
                    }
                    if (!rules.some(x => x.id === body.ruleId))
                        return sendJson(res, 404, { error: `unknown rule "${body.ruleId}"` });
                    setRuleEnabled(body.ruleId, body.enabled, states, Date.now());
                    scheduleBroadcast();
                    return sendJson(res, 200, { ok: true });
                }
                // PUT = 新建/编辑（upsert；拒绝 locked id）
                if (req.method === 'PUT') {
                    const body = await readJsonBody(req);
                    if (body === null || body === undefined || typeof body.rule !== 'object' || body.rule === null) {
                        return sendJson(res, 400, { error: 'body 应为 {rule: {...}}' });
                    }
                    let validated;
                    try {
                        validated = validateRule(body.rule);
                    }
                    catch (err) {
                        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                    }
                    if (configRules.some(x => x.id === validated.id && x.locked === true)) {
                        return sendJson(res, 403, { error: `规则 ${validated.id} 已锁定（config locked:true），不可编辑` });
                    }
                    // 重建同名规则即解除墓碑（覆盖旧 config 规则或复活已删规则）。
                    // store 只落 UI 编辑结果：从既有 store 集合推导，不把 config 默认规则
                    // 整体冻结进 store（否则插件升级改 config 默认会被 store 副本永久遮蔽）
                    const nextRules = [...storeRules.filter(x => x.id !== validated.id), validated];
                    const nextDeleted = deletedIds.filter(id => id !== validated.id);
                    try {
                        commitStore(nextRules, nextDeleted);
                    }
                    catch (err) {
                        return sendJson(res, 500, { error: `规则保存失败: ${String(err)}` });
                    }
                    scheduleBroadcast();
                    return sendJson(res, 200, { ok: true, rule: validated });
                }
                // DELETE = 删除（拒绝 locked id；config 规则删除走墓碑防复活）
                if (req.method === 'DELETE') {
                    const body = await readJsonBody(req);
                    if (body === null || body === undefined || typeof body.ruleId !== 'string') {
                        return sendJson(res, 400, { error: 'body 应为 {ruleId}' });
                    }
                    const target = rules.find(x => x.id === body.ruleId);
                    if (target === undefined)
                        return sendJson(res, 404, { error: `unknown rule "${body.ruleId}"` });
                    if (target.locked === true) {
                        return sendJson(res, 403, { error: `规则 ${body.ruleId} 已锁定，不可删除` });
                    }
                    const isFromConfig = configRules.some(x => x.id === target.id);
                    // 同 PUT：从 store 集合推导，config 规则经墓碑移除而非复制进 store
                    const nextRules = storeRules.filter(x => x.id !== target.id);
                    // 仅 config 来源的规则需要墓碑（store 来源的规则直接从落盘集合消失即可）
                    const nextDeleted = isFromConfig ? [...new Set([...deletedIds, target.id])] : deletedIds.filter(id => id !== target.id);
                    // 规则没了，它未确认的提醒也一并撤下——否则幽灵气泡永远挂在悬浮球上
                    for (let i = pending.length - 1; i >= 0; i--) {
                        if (pending[i].ruleId === target.id)
                            pending.splice(i, 1);
                    }
                    try {
                        commitStore(nextRules, nextDeleted);
                    }
                    catch (err) {
                        return sendJson(res, 500, { error: `规则保存失败: ${String(err)}` });
                    }
                    scheduleBroadcast();
                    return sendJson(res, 200, { ok: true });
                }
                return sendJson(res, 405, { error: 'method not allowed' });
            }),
            // 预览：按给定规则（草稿）渲染消息并判断会不会命中，纯函数不碰任何运行时状态
            registerRoute(webCtx.webServer, '/maze/reminders/preview', async (req, res) => {
                if (req.method !== 'POST')
                    return sendJson(res, 405, { error: 'method not allowed' });
                const body = await readJsonBody(req);
                if (body === null || body === undefined || typeof body.rule !== 'object' || body.rule === null) {
                    return sendJson(res, 400, { error: 'body 应为 {rule: {...}, use?: {provider, model}}' });
                }
                let rule;
                try {
                    rule = validateRule(body.rule);
                }
                catch (err) {
                    return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                }
                if (rule.trigger === 'cron') {
                    const spec = parseCron(rule.schedule ?? '');
                    const next = nextCronMatch(spec, new Date());
                    return sendJson(res, 200, {
                        trigger: 'cron',
                        message: renderMessage(rule.message, null),
                        nextAt: next === null ? null : next.getTime(),
                    });
                }
                // model-call：样例优先级 请求显式 use > 会话当前模型 > 内置示例
                const src = body.use !== undefined && body.use !== null && typeof body.use === 'object'
                    ? body.use
                    : currentUse === null ? {} : currentUse;
                const use = {
                    provider: typeof src.provider === 'string' && src.provider !== '' ? src.provider : '示例提供方',
                    model: typeof src.model === 'string' && src.model !== '' ? src.model : 'glm-5.3',
                    at: Date.now(),
                };
                // 预览只看条件命中（enabled/muted/频控都按全新状态评估），不占用真实频控额度
                const freshState = { enabled: true, firedToday: [] };
                const wouldFire = evaluateModelCall(rule, freshState, use, compileWhen(rule.when));
                return sendJson(res, 200, {
                    trigger: 'model-call',
                    message: renderMessage(rule.message, use),
                    wouldFire,
                    evaluatedWith: { provider: use.provider, model: use.model, hour: new Date().getHours() },
                });
            }),
            // 外观偏好：GET 读当前值；PUT 整体替换（校验 fail-loud，坏负载 400）
            registerRoute(webCtx.webServer, '/maze/appearance', async (req, res) => {
                if (req.method === 'GET')
                    return sendJson(res, 200, appearance);
                if (req.method !== 'PUT')
                    return sendJson(res, 405, { error: 'method not allowed' });
                // 外观含 base64 图片：body 上限放宽到 8MiB（IMAGE_MAX_CHARS 6M 字符 + 余量）
                const body = await readJsonBody(req, BODY_MAX_APPEARANCE);
                if (body === null || body === undefined)
                    return sendJson(res, 400, { error: 'body 应为外观配置对象' });
                let next;
                try {
                    next = validateAppearance(body);
                }
                catch (err) {
                    return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                }
                // 先落盘后改内存：保存失败时后续 GET 仍返回旧值，内存与磁盘不致分叉
                try {
                    saveAppearanceSync(dataDir, next);
                }
                catch (err) {
                    return sendJson(res, 500, { error: `外观保存失败: ${String(err)}` });
                }
                appearance = next;
                return sendJson(res, 200, appearance);
            }),
            // 连接配置：GET 返回脱敏视图（token 只报有无不回明文）；PUT 保存并即时
            // 测试连接（fail-loud：凭据/地址错误当场回错，不让用户带着坏配置离开设置页）
            registerRoute(webCtx.webServer, '/maze/notes/config', async (req, res) => {
                const notesView = () => ({
                    baseUrl: notes.baseUrl,
                    tokenSet: notes.token !== '',
                    machineName: notes.machineName,
                    ...(notes.inboxProjectId === undefined ? {} : { inboxProjectId: notes.inboxProjectId }),
                    machines: notes.machines,
                });
                if (req.method === 'GET')
                    return sendJson(res, 200, notesView());
                if (req.method !== 'PUT')
                    return sendJson(res, 405, { error: 'method not allowed' });
                const body = await readJsonBody(req);
                if (body === null || body === undefined)
                    return sendJson(res, 400, { error: 'body 应为配置补丁对象' });
                // 补丁合并：未提供的字段保持现值（token 只报有无，编辑页不回传旧明文）。
                // baseUrl 变更=换实例：旧 inboxProjectId 指向的是旧实例的项目，带上必错，弃之重解析
                //（与 validate 同规则先去尾斜杠，避免同地址多写一个 / 被误判成换实例）
                const baseUrlChanged = typeof body.baseUrl === 'string'
                    && body.baseUrl.trim().replace(/\/+$/, '') !== notes.baseUrl;
                let next;
                try {
                    next = validateNotesConfig({
                        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : notes.baseUrl,
                        token: typeof body.token === 'string' && body.token !== '' ? body.token : notes.token,
                        machineName: typeof body.machineName === 'string' ? body.machineName : notes.machineName,
                        ...(notes.inboxProjectId === undefined || baseUrlChanged ? {} : { inboxProjectId: notes.inboxProjectId }),
                        machines: Array.isArray(body.machines) ? body.machines : notes.machines,
                    });
                }
                catch (err) {
                    return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                }
                // 配置齐了才测试连接；清空 baseUrl/token 的"重置"场景跳过测试直接落盘。
                // 先重赋 notes 再走闭包 noteStore()：测试与预热期间 onInboxResolved 回写
                // 的是新配置；失败则回滚旧值（内存与磁盘都不留坏配置）
                if (next.baseUrl !== '' && next.token !== '') {
                    const prev = notes;
                    notes = next;
                    try {
                        const user = await noteStore().testConnection();
                        // 机器名以 token 身份为准回写：认领/指派全按"机器名=Vikunja 用户名"匹配，
                        // 手误填错的机器名会让任务永远无人认领，成功连接即校正
                        notes = { ...notes, machineName: user };
                        // 预热一次列表：触发 Inbox 发现，让 inboxProjectId 当场落进配置
                        await noteStore().listNotes();
                        await saveNotesConfigSync(dataDir, notes);
                        return sendJson(res, 200, { connected: true, user, machineName: user });
                    }
                    catch (err) {
                        notes = prev;
                        return sendJson(res, 502, { error: `连接失败：${err instanceof Error ? err.message : String(err)}` });
                    }
                }
                notes = next;
                try {
                    saveNotesConfigSync(dataDir, notes);
                }
                catch (err) {
                    return sendJson(res, 500, { error: `小记配置保存失败: ${String(err)}` });
                }
                return sendJson(res, 200, { connected: false });
            }),
            // 小记列表（未分配，新到旧）
            registerRoute(webCtx.webServer, '/maze/notes/list', async (_req, res) => {
                return await storeJson(res, async (store) => ({ notes: await store.listNotes() }));
            }),
            // 速记：一段文本即一条小记（首行作标题）
            registerRoute(webCtx.webServer, '/maze/notes/add', async (req, res) => {
                if (req.method !== 'POST')
                    return sendJson(res, 405, { error: 'method not allowed' });
                const body = await readJsonBody(req);
                if (body === null || body === undefined || typeof body.text !== 'string' || body.text.trim() === '') {
                    return sendJson(res, 400, { error: 'body 应为 {text: 非空字符串}' });
                }
                return await storeJson(res, async (store) => ({ note: await store.quickAdd(body.text) }));
            }),
            // 转任务：小记分配给机器（缺省本机机器名）
            registerRoute(webCtx.webServer, '/maze/notes/promote', async (req, res) => {
                if (req.method !== 'POST')
                    return sendJson(res, 405, { error: 'method not allowed' });
                const body = await readJsonBody(req);
                if (body === null || body === undefined || typeof body.id !== 'number') {
                    return sendJson(res, 400, { error: 'body 应为 {id: number, machine?: string}' });
                }
                const machine = typeof body.machine === 'string' && body.machine.trim() !== '' ? body.machine.trim() : notes.machineName;
                if (machine === '')
                    return sendJson(res, 400, { error: '机器名为空（body.machine 或本机配置任填其一）' });
                return await storeJson(res, async (store) => ({ note: await store.promote(body.id, machine) }));
            }),
            // 本机任务（分配给本机机器名，未完成，新到旧）
            registerRoute(webCtx.webServer, '/maze/notes/tasks', async (_req, res) => {
                if (notes.machineName === '')
                    return sendJson(res, 400, { error: '本机机器名未配置（设置 → 小记）' });
                return await storeJson(res, async (store) => ({ tasks: await store.claimTasks(notes.machineName) }));
            }),
            // 开工：标记进行中（幂等）
            registerRoute(webCtx.webServer, '/maze/notes/start', async (req, res) => {
                if (req.method !== 'POST')
                    return sendJson(res, 405, { error: 'method not allowed' });
                const body = await readJsonBody(req);
                if (body === null || body === undefined || typeof body.id !== 'number') {
                    return sendJson(res, 400, { error: 'body 应为 {id: number}' });
                }
                return await storeJson(res, async (store) => ({ note: await store.startTask(body.id) }));
            }),
            // 完成任务：done=true；summary 非空时以评论回写
            registerRoute(webCtx.webServer, '/maze/notes/complete', async (req, res) => {
                if (req.method !== 'POST')
                    return sendJson(res, 405, { error: 'method not allowed' });
                const body = await readJsonBody(req);
                if (body === null || body === undefined || typeof body.id !== 'number') {
                    return sendJson(res, 400, { error: 'body 应为 {id: number, summary?: string}' });
                }
                const summary = typeof body.summary === 'string' && body.summary.trim() !== '' ? body.summary.trim() : undefined;
                return await storeJson(res, async (store) => ({ note: await store.completeTask(body.id, summary) }));
            }),
            // 删除：移入 Vikunja 任务回收站（UI 两步确认；误删可在 Vikunja 网页回收站页恢复）
            registerRoute(webCtx.webServer, '/maze/notes/delete', async (req, res) => {
                if (req.method !== 'POST')
                    return sendJson(res, 405, { error: 'method not allowed' });
                const body = await readJsonBody(req);
                if (body === null || body === undefined || typeof body.id !== 'number') {
                    return sendJson(res, 400, { error: 'body 应为 {id: number}' });
                }
                await storeJson(res, async (store) => {
                    await store.deleteNote(body.id);
                    return { ok: true };
                });
            }),
            // ---- 故事线（narratives）路由 ----------------------------------------------------
            // 快照：模板（合并视图）+ 故事线场次（新→旧，最多 20 场）
            // 可用模型清单：llm 服务每请求重新解析（晚装载/热重载都能恢复；一次性捕获会把空表永久缓存住）
            // IIFE 是因为这段位于 disposer 数组里，声明必须包进表达式
            (() => {
                let modelsCache;
                return registerRoute(webCtx.webServer, '/maze/models', async (req, res) => {
                    if (req.method !== 'GET')
                        return sendJson(res, 405, { error: 'method not allowed' });
                    if (modelsCache !== undefined && Date.now() - modelsCache.at < 60_000) {
                        return sendJson(res, 200, modelsCache.payload);
                    }
                    const llmLike = ctx.get('llm');
                    if (llmLike === undefined)
                        return sendJson(res, 503, { error: 'llm 服务不可用' });
                    const providers = llmLike.listProviders();
                    // 空 provider 表不进缓存：llm 刚起还没注册完时保持可重试
                    if (providers.length === 0)
                        return sendJson(res, 200, { providers, models: [] });
                    // 并行拉取；单个 provider 失败不拖垮整张清单（模型列表是辅助输入）
                    const settled = await Promise.allSettled(providers.map(p => llmLike.listModels(p.id)));
                    const models = [];
                    for (const r of settled) {
                        if (r.status === 'fulfilled')
                            models.push(...r.value);
                    }
                    const payload = { providers, models };
                    modelsCache = { at: Date.now(), payload };
                    sendJson(res, 200, payload);
                });
            })(),
            registerRoute(webCtx.webServer, '/maze/narratives/state', (req, res) => {
                if (req.method !== 'GET')
                    return sendJson(res, 405, { error: 'method not allowed' });
                // stages 随模板下发（与 statePayload 的 storylines 视图同一形状）
                sendJson(res, 200, { templates: narrativeTemplates.map(t => templateView(t)), runs, selectedTemplateId: narrativeSelectedId, narrativeVersion: narrativeVersionRef.value });
            }),
            // 模板编辑：PUT = upsert（接待员/参数/文案可编辑；builtin 标记归代码所有，PUT 剥离）；
            // DELETE = 删除（内置/config 来源走墓碑防复活；store 来源直接消失）
            registerRoute(webCtx.webServer, '/maze/narratives/template', async (req, res) => {
                if (req.method === 'PUT') {
                    // 上限与校验边界对齐：12 环 × 2000 字提示词（UTF-8 中文 3 字节）可达 ~72KB
                    const body = await readJsonBody(req, BODY_MAX_NARRATIVES);
                    if (body === null || body === undefined || typeof body.template !== 'object' || body.template === null) {
                        return sendJson(res, 400, { error: 'body 应为 {template: {...}}' });
                    }
                    const { builtin: _builtin, ...rest } = body.template;
                    let validated;
                    try {
                        validated = validateNarrativeTemplate(rest);
                    }
                    catch (err) {
                        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                    }
                    // 新建受容量上限（编辑既有不受影响）
                    const isEdit = narrativeTemplates.some(t => t.id === validated.id);
                    if (!isEdit && narrativeTemplates.length >= NARRATIVES_MAX) {
                        return sendJson(res, 400, { error: `故事线模板已达上限 ${NARRATIVES_MAX} 条` });
                    }
                    // 名字唯一（轨迹按《名》归档）：重名在合并层会整体拒绝，这里提前给 400 更友好
                    if (narrativeTemplates.some(t => t.id !== validated.id && t.name === validated.name)) {
                        return sendJson(res, 400, { error: `已有名为「${validated.name}」的故事线（轨迹按名归档，名字必须唯一）` });
                    }
                    // 名字撞 id 在 mergeNarratives 同样是硬拒绝：这里先拦，错误保持 400（客户端输入错）而不是落进兜底 500
                    if (narrativeTemplates.some(t => t.id !== validated.id && t.id === validated.name)) {
                        return sendJson(res, 400, { error: `故事线名「${validated.name}」与已有模板 id 冲突` });
                    }
                    // store 只落 UI 编辑结果（同规则语义：不把内置/config 基底冻结进 store）
                    const nextTemplates = [...narrativeStoreTemplates.filter(t => t.id !== validated.id), validated];
                    const nextDeleted = narrativeDeletedIds.filter(id => id !== validated.id);
                    try {
                        commitNarratives(nextTemplates, nextDeleted);
                    }
                    catch (err) {
                        return sendJson(res, 500, { error: `故事线模板保存失败: ${String(err)}` });
                    }
                    scheduleBroadcast();
                    return sendJson(res, 200, { ok: true, template: narrativeTemplates.find(t => t.id === validated.id) });
                }
                if (req.method === 'DELETE') {
                    const body = await readJsonBody(req);
                    if (body === null || body === undefined || typeof body.templateId !== 'string') {
                        return sendJson(res, 400, { error: 'body 应为 {templateId}' });
                    }
                    const target = narrativeTemplates.find(t => t.id === body.templateId);
                    if (target === undefined)
                        return sendJson(res, 404, { error: `unknown template "${body.templateId}"` });
                    const nextTemplates = narrativeStoreTemplates.filter(t => t.id !== target.id);
                    const needsTombstone = BUILTIN_TEMPLATES.some(t => t.id === target.id)
                        || configNarratives.some(t => t.id === target.id);
                    const nextDeleted = needsTombstone
                        ? [...new Set([...narrativeDeletedIds, target.id])]
                        : narrativeDeletedIds.filter(id => id !== target.id);
                    // 选中项被删：先清选中再一次性落盘（chip 回到「未选择」）；写失败上抛 500，
                    // 避免"盘上选中指向已删模板而广播说已清"或"删了又落第二次"的分叉
                    const previousSelectedId = narrativeSelectedId; // 写失败时回滚，避免内存/盘上选中分叉
                    if (narrativeSelectedId === target.id)
                        narrativeSelectedId = '';
                    try {
                        commitNarratives(nextTemplates, nextDeleted);
                    }
                    catch (err) {
                        narrativeSelectedId = previousSelectedId;
                        return sendJson(res, 500, { error: `故事线模板保存失败: ${String(err)}` });
                    }
                    scheduleBroadcast();
                    return sendJson(res, 200, { ok: true });
                }
                return sendJson(res, 405, { error: 'method not allowed' });
            }),
            // chip 选中态：POST {templateId}（'' 允许=取消选择）
            registerRoute(webCtx.webServer, '/maze/narratives/select', async (req, res) => {
                if (req.method !== 'POST')
                    return sendJson(res, 405, { error: 'method not allowed' });
                const body = await readJsonBody(req);
                if (body === null || body === undefined || typeof body.templateId !== 'string') {
                    return sendJson(res, 400, { error: 'body 应为 {templateId}' });
                }
                if (body.templateId !== '' && !narrativeTemplates.some(t => t.id === body.templateId)) {
                    return sendJson(res, 404, { error: `unknown template "${body.templateId}"` });
                }
                const previousSelectedId = narrativeSelectedId;
                narrativeSelectedId = body.templateId;
                try {
                    commitNarratives(narrativeStoreTemplates, narrativeDeletedIds);
                }
                catch (err) {
                    // 落盘失败回滚内存选中：避免快照/广播与盘上 store 分叉
                    narrativeSelectedId = previousSelectedId;
                    return sendJson(res, 500, { error: `选中态保存失败: ${String(err)}` });
                }
                scheduleBroadcast();
                return sendJson(res, 200, { ok: true, selectedTemplateId: narrativeSelectedId });
            }),
            // 合成故事线消息（轮回按钮与预览用）
            registerRoute(webCtx.webServer, '/maze/narratives/compose', async (req, res) => {
                if (req.method !== 'POST')
                    return sendJson(res, 405, { error: 'method not allowed' });
                const body = await readJsonBody(req);
                if (body === null || body === undefined || typeof body.templateId !== 'string') {
                    return sendJson(res, 400, { error: 'body 应为 {templateId, goal?}' });
                }
                const tpl = narrativeTemplates.find(t => t.id === body.templateId);
                if (tpl === undefined)
                    return sendJson(res, 404, { error: `unknown template "${body.templateId}"` });
                const goal = typeof body.goal === 'string' ? body.goal : '';
                return sendJson(res, 200, { template: { id: tpl.id, name: tpl.name }, message: composeNarrativeMessage(tpl, hostNameOf, goal) });
            }),
            // ---- 配置云端同步（WebDAV）------------------------------------------------------
            // 连接配置：GET 返回脱敏视图（密码只报有无）；PUT 校验后 0600 原子落盘
            registerRoute(webCtx.webServer, '/maze/sync/config', async (req, res) => {
                if (req.method === 'GET') {
                    let conn;
                    try {
                        conn = loadSyncConnection(dataDir);
                    }
                    catch (err) {
                        return sendJson(res, 500, { error: `sync.json 损坏，请在设置页重新保存连接: ${String(err)}` });
                    }
                    if (conn === null)
                        return sendJson(res, 200, { configured: false });
                    return sendJson(res, 200, { configured: true, server: conn.server, username: conn.username, remotePath: conn.remotePath });
                }
                if (req.method !== 'PUT')
                    return sendJson(res, 405, { error: 'method not allowed' });
                const body = await readJsonBody(req);
                if (body === null || body === undefined)
                    return sendJson(res, 400, { error: 'body 应为连接配置对象' });
                // 密码留空 + 此前保存过：沿用已存密码（GET 脱敏不回传，客户端重填其他
                // 字段时不必重输密码；没有"清空密码"的操作语义）
                if (typeof body === 'object' && body !== null
                    && typeof body.password === 'string'
                    && body.password === '') {
                    try {
                        const saved = loadSyncConnection(dataDir);
                        if (saved !== null)
                            body.password = saved.password;
                    }
                    catch { /* 损坏的旧文件按无密码处理，走正常校验报错 */ }
                }
                let conn;
                try {
                    conn = validateSyncConnection(body);
                }
                catch (err) {
                    return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
                }
                try {
                    saveSyncConnection(dataDir, conn);
                }
                catch (err) {
                    return sendJson(res, 500, { error: `连接配置保存失败: ${String(err)}` });
                }
                return sendJson(res, 200, { ok: true });
            }),
            // 云端摘要：GET 远端文档（不应用）。404=云端为空；其余非 2xx 视为远端拒绝
            registerRoute(webCtx.webServer, '/maze/sync/peek', async (req, res) => {
                if (req.method !== 'POST')
                    return sendJson(res, 405, { error: 'method not allowed' });
                let conn;
                try {
                    conn = loadSyncConnection(dataDir);
                }
                catch (err) {
                    return sendJson(res, 500, { error: `sync.json 损坏: ${String(err)}` });
                }
                if (conn === null)
                    return sendJson(res, 400, { error: '尚未配置同步连接' });
                let resp;
                try {
                    resp = await davRequest(conn, 'GET');
                }
                catch (err) {
                    return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
                }
                if (resp.status === 404)
                    return sendJson(res, 200, { empty: true });
                if (resp.status < 200 || resp.status >= 300)
                    return sendJson(res, 502, { error: `WebDAV 服务器返回 ${resp.status}` });
                let bundle;
                try {
                    bundle = validateSyncBundle(JSON.parse(resp.text));
                }
                catch (err) {
                    return sendJson(res, 502, { error: `云端配置包无法解析: ${err instanceof Error ? err.message : String(err)}` });
                }
                return sendJson(res, 200, { empty: false, ...summarizeBundle(bundle) });
            }),
            // 上传：本机三份文件各取磁盘真值（load* 均已校验），打包 PUT；任一读取失败整单拒绝
            registerRoute(webCtx.webServer, '/maze/sync/upload', async (req, res) => {
                if (req.method !== 'POST')
                    return sendJson(res, 405, { error: 'method not allowed' });
                let conn;
                try {
                    conn = loadSyncConnection(dataDir);
                }
                catch (err) {
                    return sendJson(res, 500, { error: `sync.json 损坏: ${String(err)}` });
                }
                if (conn === null)
                    return sendJson(res, 400, { error: '尚未配置同步连接' });
                let rulesSection;
                try {
                    const store = loadStoreSync(dataDir);
                    rulesSection = { version: 1, rules: store.rules, deletedIds: store.deletedIds };
                }
                catch (err) {
                    return sendJson(res, 500, { error: `读取本地提醒规则失败: ${String(err)}` });
                }
                let appearanceSection;
                try {
                    appearanceSection = loadAppearanceSync(dataDir, () => resolveDefaultAppearance(join(pluginRoot(), 'assets')));
                }
                catch (err) {
                    return sendJson(res, 500, { error: `读取本地外观配置失败: ${String(err)}` });
                }
                let narrativesSection;
                try {
                    const nstore = loadNarrativesSync(narrativesPath);
                    narrativesSection = { templates: nstore.templates, deletedIds: nstore.deletedIds, selectedTemplateId: nstore.selectedTemplateId };
                }
                catch (err) {
                    return sendJson(res, 500, { error: `读取本地故事线失败: ${String(err)}` });
                }
                const uploadedAt = Date.now();
                const bundle = {
                    kind: 'dsh-maze-config', version: 1, uploadedAt, machine: hostname(),
                    rules: rulesSection, appearance: appearanceSection, narratives: narrativesSection,
                };
                // 序列化一次复用：包内含头像/背景 base64，可达数 MB，重复 stringify 纯浪费
                const body = JSON.stringify(bundle);
                let resp;
                try {
                    resp = await davRequest(conn, 'PUT', body);
                }
                catch (err) {
                    return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
                }
                if (resp.status < 200 || resp.status >= 300)
                    return sendJson(res, 502, { error: `WebDAV 服务器返回 ${resp.status}` });
                return sendJson(res, 200, { ok: true, uploadedAt, bytes: Buffer.byteLength(body, 'utf8') });
            }),
            // 下载：GET → 整包预校验（规则/外观/故事线各自 validate + 故事线干跑合并）→
            // 全部通过才经运行时同款出口应用（commitStore/saveAppearance/commitNarratives），
            // 热生效并广播。校验失败（400/502）本地零改动；应用期落盘失败按段 500——
            // 已落盘的段保留（各段独立原子写，重启后以盘上为准），不会回到应用前
            registerRoute(webCtx.webServer, '/maze/sync/download', async (req, res) => {
                if (req.method !== 'POST')
                    return sendJson(res, 405, { error: 'method not allowed' });
                let conn;
                try {
                    conn = loadSyncConnection(dataDir);
                }
                catch (err) {
                    return sendJson(res, 500, { error: `sync.json 损坏: ${String(err)}` });
                }
                if (conn === null)
                    return sendJson(res, 400, { error: '尚未配置同步连接' });
                let resp;
                try {
                    resp = await davRequest(conn, 'GET');
                }
                catch (err) {
                    return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
                }
                if (resp.status === 404)
                    return sendJson(res, 400, { error: '云端还没有配置' });
                if (resp.status < 200 || resp.status >= 300)
                    return sendJson(res, 502, { error: `WebDAV 服务器返回 ${resp.status}` });
                let bundle;
                try {
                    bundle = validateSyncBundle(JSON.parse(resp.text));
                }
                catch (err) {
                    return sendJson(res, 502, { error: `云端配置包无法解析: ${err instanceof Error ? err.message : String(err)}` });
                }
                // ---- 预校验（应用前全部完成，保证本地零改动直到确定可应用） ----
                let nextRules = null;
                let nextDeleted = [];
                if (bundle.rules !== null) {
                    const r = bundle.rules;
                    if (!Array.isArray(r.rules))
                        return sendJson(res, 400, { error: '配置包 rules 段缺少 rules 数组' });
                    if (r.deletedIds !== undefined && !Array.isArray(r.deletedIds))
                        return sendJson(res, 400, { error: '配置包 rules.deletedIds 必须是数组' });
                    try {
                        // store 语义来源（另一台机器的运行时编辑）：when/locked 按文件装载口径放行
                        nextRules = r.rules.map(x => validateRule(x, { allowWhen: true, allowLocked: true }));
                        nextDeleted = Array.isArray(r.deletedIds) ? r.deletedIds.map(x => String(x)) : [];
                    }
                    catch (err) {
                        return sendJson(res, 400, { error: `配置包内的提醒规则非法: ${err instanceof Error ? err.message : String(err)}` });
                    }
                }
                let nextAppearance = null;
                if (bundle.appearance !== null) {
                    try {
                        nextAppearance = validateAppearance(bundle.appearance);
                    }
                    catch (err) {
                        return sendJson(res, 400, { error: `配置包内的外观配置非法: ${err instanceof Error ? err.message : String(err)}` });
                    }
                }
                let nextNarratives = null;
                let nextNarrativeDeleted = [];
                let nextNarrativeSelected = '';
                if (bundle.narratives !== null) {
                    const n = bundle.narratives;
                    if (!Array.isArray(n.templates))
                        return sendJson(res, 400, { error: '配置包 narratives 段缺少 templates 数组' });
                    if (n.deletedIds !== undefined && !Array.isArray(n.deletedIds))
                        return sendJson(res, 400, { error: '配置包 narratives.deletedIds 必须是数组' });
                    try {
                        nextNarratives = n.templates.map(x => validateNarrativeTemplate(x));
                        nextNarrativeDeleted = Array.isArray(n.deletedIds) ? n.deletedIds.map(x => String(x)) : [];
                        nextNarrativeSelected = typeof n.selectedTemplateId === 'string' ? n.selectedTemplateId : '';
                        // 干跑合并：超限/重名等会在 commitNarratives 内炸的错误在应用前暴露
                        mergeNarratives(configNarratives, nextNarratives, new Set(nextNarrativeDeleted));
                    }
                    catch (err) {
                        return sendJson(res, 400, { error: `配置包内的故事线非法: ${err instanceof Error ? err.message : String(err)}` });
                    }
                }
                // ---- 应用（与运行时编辑同一出口：落盘+内存+派生表+广播） ----
                if (nextRules !== null) {
                    try {
                        commitStore(nextRules, nextDeleted);
                    }
                    catch (err) {
                        return sendJson(res, 500, { error: `提醒规则应用失败: ${String(err)}` });
                    }
                }
                if (nextAppearance !== null) {
                    try {
                        saveAppearanceSync(dataDir, nextAppearance);
                    }
                    catch (err) {
                        return sendJson(res, 500, { error: `外观配置应用失败: ${String(err)}` });
                    }
                    appearance = nextAppearance;
                }
                if (nextNarratives !== null) {
                    const prevSelected = narrativeSelectedId;
                    narrativeSelectedId = nextNarrativeSelected;
                    try {
                        commitNarratives(nextNarratives, nextNarrativeDeleted);
                    }
                    catch (err) {
                        narrativeSelectedId = prevSelected;
                        return sendJson(res, 500, { error: `故事线应用失败: ${String(err)}` });
                    }
                    // 盘上选中可能指向墓碑/被丢弃模板：与装载期同款惰性收敛
                    if (narrativeSelectedId !== '' && !narrativeTemplates.some(t => t.id === narrativeSelectedId))
                        narrativeSelectedId = '';
                }
                broadcastNow();
                return sendJson(res, 200, {
                    ok: true, uploadedAt: bundle.uploadedAt, machine: bundle.machine,
                    applied: { rules: nextRules?.length ?? 0, appearance: nextAppearance !== null, narratives: nextNarratives?.length ?? 0 },
                });
            }),
        ];
        webCtx.effect(() => () => {
            for (const d of disposers)
                d();
            // SSE 流与节流定时器随插件卸载关闭
            if (sseFlushTimer !== undefined)
                clearTimeout(sseFlushTimer);
            for (const client of [...sseClients])
                client.close();
        });
    });
}
