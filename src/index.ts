/**
 * dsh-maze 宿主半边（Maze 个人助手框架；右下角常驻的接待员名叫 Dolores）：
 * - llm/stream 观察（model-call 规则）+ 30s tick 调度器（cron 规则）
 * - 会话事件流 → Dolores 神态镜像（narrative.ts，供客户端微动效与台词）
 * - 规则装载校验（fail-loud）与 config/store 合并持久化（tombstone 语义见 reminders/store.ts）
 * - HTTP 路由：GET/POST /maze/reminders/{state,ack,rule,preview}、GET/PUT /maze/appearance、
 *   GET /maze/events（SSE 状态推送）
 * - 同源信任栅栏 + 请求体上限（回环 socket 平台免鉴权，需自挡恶意网页的
 *   cross-site fetch）
 *
 * 纯 UI 提醒：不向模型上下文注入任何内容。
 * 模块化预留：提醒中心（reminders）是 Maze 的第一个功能模块，路由统一挂
 * /maze/reminders/* 前缀；未来新模块各占 /maze/<module>/* 与设置页一个 tab。
 */

import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-session';
import z from '@deepseek-ai/schemastery';
import { join } from 'node:path';
import {
  compileWhen,
  evaluateModelCall,
  localDateKey,
  muteRuleForToday,
  observe,
  observeTick,
  renderMessage,
  setRuleEnabled,
  type AckAction,
  type HistoryEntry,
  type ModelUse,
  type Reminder,
  type RuleDef,
  type RuleState,
  type WhenFn,
} from './reminders/engine.js';
import { matchesCron, nextCronMatch, parseCron, type CronSpec } from './reminders/cron.js';
import { validateRule } from './reminders/validate.js';
import { loadStoreSync, mergeRules, pluginRoot, resolveDataDir, saveStoreSync } from './reminders/store.js';
import { DEFAULT_APPEARANCE, loadAppearanceSync, resolveDefaultAppearance, saveAppearanceSync, validateAppearance, type AppearanceConfig } from './appearance.js';
import { currentDemeanor, narrativeEventToDemeanor, pickDemeanorRecord, type Demeanor, type DemeanorRecord } from './narrative.js';

export const name = 'dsh-maze';
export const inject = ['webServer'];

/** 调度器节拍：30s。分钟级 cron 的去重由引擎的 lastCronMinute 保证 */
const TICK_MS = 30_000;
/** 历史保留条数 */
const HISTORY_LIMIT = 50;

export interface Config {
  rules: unknown[];
}

export const Config: z<Config> = z.object({
  rules: z.array(z.any()).default([
    // 默认规则与文档示例一致：GLM 高峰时段额度提醒
    { id: 'glm-peak-hours', name: 'GLM 高峰时段提醒', message: '当前 {model}（{provider}）额度消耗较快，建议切换其他模型', startHour: 14, endHour: 18, modelPattern: '*glm*', maxPerDay: 2, cooldownMinutes: 120 },
  ]),
});

/**
 * 最小路由形状：webServer 把 handler 当不透明函数组合，这里收敛一次类型供全部路由共用。
 * SSE 路由额外用到 write/on('close')；headers/destroy 供信任栅栏与 body 上限使用。
 */
export interface RouteReq {
  method?: string;
  headers?: Record<string, unknown>;
  on(ev: 'data' | 'end' | 'error' | 'close', cb: (chunk?: unknown) => void): void;
  destroy?(): void;
  url?: string;
}
interface RouteRes {
  writeHead(code: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(body?: string): void;
  on?(ev: 'close' | 'error', cb: () => void): void;
}
type RouteHandler = (req: RouteReq, res: RouteRes) => void | Promise<void>;

/** JSON 响应统一出口 */
function sendJson(res: RouteRes, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

/** 常规路由请求体上限；外观 PUT 含 base64 大图单独放宽 */
const BODY_MAX_DEFAULT = 64 * 1024;
const BODY_MAX_APPEARANCE = 8 * 1024 * 1024; // schema 侧另有图片聚合上限 7.5M 字符（见 appearance.ts），合法配置总能装进该 cap

/**
 * 读 JSON 请求体；坏 JSON / 请求中断（error 事件）/ 超过 maxBytes 都返回 undefined（路由回 400）。
 * 超限即停止缓冲并销毁连接（宁可断流，不缓冲无上限的 body）。
 */
export function readJsonBody(req: RouteReq, maxBytes: number = BODY_MAX_DEFAULT): Promise<unknown> {
  return new Promise((resolveBody) => {
    // 缓冲原始 Buffer、结束时一次解码：逐块 String(chunk) 会把跨块的多字节
    // UTF-8 字符拆成 U+FFFD；上限按真实字节计（data.length 数的是 UTF-16 单元）
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk: unknown) => {
      if (overflow) return;
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
      if (overflow || chunks.length === 0) return resolveBody(undefined);
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolveBody(undefined);
      }
    });
  });
}

/** 大小写不敏感取请求头（Node 的 headers 本身全小写，这里防御任意形状） */
function headerOf(req: RouteReq, name: string): string | undefined {
  const headers = req.headers;
  if (headers === undefined) return undefined;
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return undefined;
}

/**
 * 同源信任栅栏：dsh 平台对回环 socket 免鉴权，意味着任何
 * 本地进程与恶意网页的 drive-by fetch 都能打到 /maze/* 路由。浏览器跨站请求必然携带
 * sec-fetch-site 或 Origin 之一，在这里拒掉；curl 等不带浏览器标记的本地工具不受影响。
 */
export function isSameOriginRequest(req: RouteReq): boolean {
  const fetchSite = headerOf(req, 'sec-fetch-site');
  // 'none' = 地址栏直达/书签等非页面发起，放行
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') return false;
  const origin = headerOf(req, 'origin');
  if (origin !== undefined) {
    const host = headerOf(req, 'host') ?? '';
    try {
      // Origin 含端口，须与 Host（含端口）全等才放行
      if (new URL(origin).host !== host) return false;
    } catch {
      // 非 URL 形状的 Origin 一律不信任
      return false;
    }
  }
  return true;
}

/** 注册统一入口：先过同源栅栏再进 handler（403 拒绝跨站浏览器请求） */
function registerRoute(
  webServer: { register: (def: { kind: 'exact'; path: string; handler: RouteHandler }) => () => void },
  path: string,
  handler: RouteHandler,
): () => void {
  return webServer.register({ kind: 'exact', path, handler: (req, res) => {
    if (!isSameOriginRequest(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    return handler(req, res);
  } });
}

// ctx 显式 any：插件不依赖 @deepseek-ai/cordis 运行时类型包（peer 由宿主
// 进程提供、独立 tsconfig 不引它的 d.ts），事件表/服务注入靠宿主侧声明合并
export function apply(ctx: any, config: Config): void {
  // 走一次 schema 实例调用补全默认值（schemastery 运行时归一化）
  const cfg: Config = Config(config);

  // ---- 装载：config 校验 → 迁移 → store 合并 → 派生编译表 --------------------------
  // when/locked 只在文件装载路径放行（config 是用户自己的 cordis.patch.yml）
  const configRules: RuleDef[] = cfg.rules.map(r => validateRule(r, { allowWhen: true, allowLocked: true }));
  const dataDir = resolveDataDir(pluginRoot());
  // store 损坏不阻断宿主：退回纯 config 规则集并告警（编辑落盘失效但提醒可用）
  let storeRules: RuleDef[] = [];
  let deletedIds: string[] = [];
  try {
    const store = loadStoreSync(dataDir);
    storeRules = store.rules;
    deletedIds = store.deletedIds;
  } catch (err) {
    ctx.logger?.warn?.(`dsh-maze store 读取失败，忽略运行时编辑: ${String(err)}`);
  }
  let rules: RuleDef[] = mergeRules(configRules, storeRules, deletedIds);

  // 外观偏好：文件缺失=资产版出厂默认（背景/头像随插件发行）；损坏也只退回
  // 纯内置默认（外观不值得阻断装载）
  let appearance: AppearanceConfig;
  try {
    appearance = loadAppearanceSync(dataDir, () => resolveDefaultAppearance(join(pluginRoot(), 'assets')));
  } catch (err) {
    // 走 validateAppearance 拿深克隆（lines 不与模块级 DEFAULT_LINES 共享引用）
    appearance = validateAppearance(DEFAULT_APPEARANCE);
    ctx.logger?.warn?.(`dsh-maze appearance 读取失败，使用默认外观: ${String(err)}`);
  }

  const states = new Map<string, RuleState>();
  const pending: Reminder[] = [];
  const history: HistoryEntry[] = [];
  let currentUse: ModelUse | null = null;
  // Dolores 神态按会话分桶（纯内存）：悬浮球跟随用户正在看的会话，多会话并行
  // 不互相串台。session/event 自带会话身份直接入桶；llm/stream 无会话标识，
  // 归给最近活跃的会话（模型调用总发生在某个会话的 turn 内，而该会话在调用
  // 前后必有事件流出）。
  const demeanorBySession = new Map<string, DemeanorRecord>();
  let lastActiveSessionId: string | undefined;
  /** 桶数量上限：防长期运行（每天大量临时会话）内存膨胀，按记录时间淘汰最旧 */
  const NARRATIVE_SESSIONS_MAX = 32;
  function recordDemeanor(sessionId: string, record: DemeanorRecord): void {
    demeanorBySession.set(sessionId, record);
    if (demeanorBySession.size > NARRATIVE_SESSIONS_MAX) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [key, r] of demeanorBySession) {
        if (r.at < oldestAt) { oldestAt = r.at; oldestKey = key; }
      }
      // 刚写入的桶永不淘汰（即使它最旧也说明其它桶更新）
      if (oldestKey !== undefined && oldestKey !== sessionId) demeanorBySession.delete(oldestKey);
    }
  }

  /** when 表达式与 cron 匹配器的派生表（装载与每次规则变更后重建） */
  const compiled = new Map<string, WhenFn | null>();
  const cronSpecs = new Map<string, (at: Date) => boolean>();
  function rebuildDerived(): void {
    compiled.clear();
    cronSpecs.clear();
    for (const r of rules) {
      compiled.set(r.id, compileWhen(r.when));
      if (r.trigger === 'cron') {
        // validateRule（config 与 store 装载路径都跑）已保证 cron 规则 schedule 可解析
        const spec: CronSpec = parseCron(r.schedule ?? '');
        cronSpecs.set(r.id, (at: Date) => matchesCron(spec, at));
      }
    }
  }
  rebuildDerived();

  /** 规则集变更统一出口：先落盘后改内存（写失败时内存与磁盘保持旧值一致），再合并重建（调用方保证已过校验与 locked 检查） */
  function commitStore(nextRules: readonly RuleDef[], nextDeleted: readonly string[]): void {
    saveStoreSync(dataDir, nextRules, nextDeleted);
    storeRules = [...nextRules];
    deletedIds = [...nextDeleted];
    rules = mergeRules(configRules, storeRules, deletedIds);
    rebuildDerived();
  }

  /** state 路由负载：规则快照（含运行时状态）+ 当前模型 + pending + 历史 + 神态。
   *  session 指定 时 narrative 取该会话的桶；narratives 附全量分桶供 SSE 客户端各自挑选 */
  function statePayload(session?: string): unknown {
    const now = Date.now();
    const today = localDateKey(now);
    const record = pickDemeanorRecord(demeanorBySession, session);
    const narratives: Record<string, { demeanor: Demeanor; since: number }> = {};
    for (const [id, r] of demeanorBySession) narratives[id] = { demeanor: currentDemeanor(r, now), since: r.at };
    return {
      current: currentUse === null ? null : { provider: currentUse.provider, model: currentUse.model, since: currentUse.at },
      narrative: { demeanor: currentDemeanor(record, now), since: record?.at ?? null },
      narratives,
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
    };
  }

  // ---- SSE 状态推送 ------------------------------------------------------------------
  // 连接即回发快照；之后状态变化经 scheduleBroadcast 推送。500ms 节流 + 负载不变跳过
  // （流式期间神态不变时零流量）；EventSource 断线自动重连且重连即回发，无需补偿拉取。
  const SSE_THROTTLE_MS = 500;
  const SSE_HEARTBEAT_MS = 30_000;
  const sseClients = new Set<{ write: (payload: string) => void; close: () => void }>();
  let sseLastSent = '';
  let sseFlushTimer: ReturnType<typeof setTimeout> | undefined;
  let sseLastFlushAt = 0;
  function broadcastNow(): void {
    const snapshot = statePayload() as { now?: number };
    const payload = JSON.stringify(snapshot);
    // now 每帧必变，直接逐字节比较永不命中（去重失效）：指纹剔除 now 后再比
    const fingerprint = JSON.stringify({ ...snapshot, now: 0 });
    if (fingerprint === sseLastSent) return;
    sseLastSent = fingerprint;
    for (const client of sseClients) client.write(payload);
  }
  function scheduleBroadcast(): void {
    if (sseFlushTimer !== undefined) return;
    const wait = Math.max(0, SSE_THROTTLE_MS - (Date.now() - sseLastFlushAt));
    sseFlushTimer = setTimeout(() => {
      sseFlushTimer = undefined;
      sseLastFlushAt = Date.now();
      broadcastNow();
    }, wait);
  }

  // ---- 观察者：模型调用（llm/stream waterfall 必须 next() 委托）---------------------
  ctx.on('llm/stream', (options: { provider: string; model: string }, next: () => unknown) => {
    const use: ModelUse = { provider: options.provider, model: options.model, at: Date.now() };
    currentUse = use;
    // 神态归给最近活跃会话（见 demeanorBySession 注释）；尚无任何会话事件时
    // 无法归属，只记模型不记神态
    if (lastActiveSessionId !== undefined) recordDemeanor(lastActiveSessionId, { demeanor: 'thinking', at: use.at });
    pending.push(...observe(rules, states, use, compiled));
    scheduleBroadcast();
    return next();
  });

  // ---- 观察者：会话事件流 → Dolores 神态镜像（idle/waiting/thinking/tool/review/done/failed）
  ctx.on('session/event', (session: unknown, event: { type: string; time?: unknown; data?: unknown }) => {
    // 会话身份防御式读取（跨构建 Session 类型可能滞后）
    const sid = typeof (session as { id?: unknown } | null)?.id === 'string' ? (session as { id: string }).id : undefined;
    if (sid !== undefined) lastActiveSessionId = sid;
    // turn/end 的 reason.kind 决定收场神态；字段做防御式读取（跨构建类型表可能滞后于运行时）
    let reasonKind: string | undefined;
    if (event.type === 'turn/end') {
      const reason = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason;
      if (reason !== undefined && typeof reason.kind === 'string') reasonKind = reason.kind;
    }
    const demeanor = narrativeEventToDemeanor(event.type, reasonKind);
    if (demeanor === undefined || sid === undefined) return;
    // 事件时间戳缺失（异常流）时退回当前时间
    const at = typeof event.time === 'number' ? event.time : Date.now();
    recordDemeanor(sid, { demeanor, at });
    scheduleBroadcast();
  });

  // 会话销毁即清理其神态桶（防 map 慢性累积；上限淘汰之外的兜底）
  ctx.on('session/disposed', (session: unknown) => {
    const sid = typeof (session as { id?: unknown } | null)?.id === 'string' ? (session as { id: string }).id : undefined;
    if (sid === undefined || !demeanorBySession.delete(sid)) return;
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

  // ---- HTTP 路由（软依赖：无 web 组合时静默不装）-----------------------------------
  ctx.inject(['webServer'], (webCtx: { webServer: { register: (def: { kind: 'exact'; path: string; handler: RouteHandler }) => () => void }; effect: (fn: () => () => void) => void }) => {
    const disposers = [
      registerRoute(webCtx.webServer, '/maze/events', (req: RouteReq, res: RouteRes) => {
        // SSE：连接即回发快照；之后 broadcastNow 推送。栅栏在 registerRoute 统一入口。
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        // 断线后写入会抛错：吞掉写错误，由 close 统一清理
        res.on?.('error', () => {});
        res.write('retry: 3000\n\n');
        let closed = false;
        const client = {
          write(payload: string): void {
            if (closed) return;
            try {
              res.write(`data: ${payload}\n\n`);
            } catch {
              client.close();
            }
          },
          close(): void {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            sseClients.delete(client);
            try { res.end(); } catch { /* 连接已关闭 */ }
          },
        };
        // 心跳注释行保持空闲连接活性（防中间层/浏览器回收）。
        // 直接 res.write：client.write 会加 data: 前缀，注释行会变成畸形消息帧
        const heartbeat = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            client.close();
          }
        }, SSE_HEARTBEAT_MS);
        sseClients.add(client);
        // 连接建立即回发当前快照（重连后的补偿也靠这一次回发）
        client.write(JSON.stringify(statePayload()));
        req.on('close', () => { client.close(); });
        res.on?.('close', () => { client.close(); });
      }),
      registerRoute(webCtx.webServer, '/maze/reminders/state', (req: RouteReq, res: RouteRes) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        // ?session=<id>：神态跟随指定会话（悬浮球/彩蛋传当前会话）；缺省回落最近活跃
        let session: string | undefined;
        try {
          session = new URL(req.url ?? '', 'http://localhost').searchParams.get('session') ?? undefined;
        } catch {
          session = undefined;
        }
        sendJson(res, 200, statePayload(session === '' ? undefined : session));
      }),
      registerRoute(webCtx.webServer, '/maze/reminders/ack', async (req: RouteReq, res: RouteRes) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = await readJsonBody(req) as { reminderId?: string; action?: string } | null | undefined;
        if (body === null || body === undefined || typeof body.reminderId !== 'string' || (body.action !== 'dismiss' && body.action !== 'muteToday')) {
          return sendJson(res, 400, { error: 'body 应为 {reminderId, action: "dismiss"|"muteToday"}' });
        }
        const idx = pending.findIndex(p => p.id === body.reminderId);
        if (idx === -1) return sendJson(res, 404, { error: `unknown reminder "${body.reminderId}"` });
        const [rem] = pending.splice(idx, 1);
        const action: AckAction = body.action;
        if (action === 'muteToday') muteRuleForToday(rem!.ruleId, states, Date.now());
        history.unshift({ reminderId: rem!.id, ruleId: rem!.ruleId, message: rem!.message, firedAt: rem!.firedAt, ackedAt: Date.now(), action });
        if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
        scheduleBroadcast();
        sendJson(res, 200, { ok: true });
      }),
      registerRoute(webCtx.webServer, '/maze/reminders/rule', async (req: RouteReq, res: RouteRes) => {
        // POST = 启停开关（locked 规则也允许：只影响运行时，不改规则内容与 store）
        if (req.method === 'POST') {
          const body = await readJsonBody(req) as { ruleId?: string; enabled?: boolean } | null | undefined;
          if (body === null || body === undefined || typeof body.ruleId !== 'string' || typeof body.enabled !== 'boolean') {
            return sendJson(res, 400, { error: 'body 应为 {ruleId, enabled}' });
          }
          if (!rules.some(x => x.id === body.ruleId)) return sendJson(res, 404, { error: `unknown rule "${body.ruleId}"` });
          setRuleEnabled(body.ruleId, body.enabled, states, Date.now());
          scheduleBroadcast();
          return sendJson(res, 200, { ok: true });
        }
        // PUT = 新建/编辑（upsert；拒绝 locked id）
        if (req.method === 'PUT') {
          const body = await readJsonBody(req) as { rule?: Record<string, unknown> } | null | undefined;
          if (body === null || body === undefined || typeof body.rule !== 'object' || body.rule === null) {
            return sendJson(res, 400, { error: 'body 应为 {rule: {...}}' });
          }
          let validated: RuleDef;
          try {
            validated = validateRule(body.rule);
          } catch (err) {
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
          } catch (err) {
            return sendJson(res, 500, { error: `规则保存失败: ${String(err)}` });
          }
          scheduleBroadcast();
          return sendJson(res, 200, { ok: true, rule: validated });
        }
        // DELETE = 删除（拒绝 locked id；config 规则删除走墓碑防复活）
        if (req.method === 'DELETE') {
          const body = await readJsonBody(req) as { ruleId?: string } | null | undefined;
          if (body === null || body === undefined || typeof body.ruleId !== 'string') {
            return sendJson(res, 400, { error: 'body 应为 {ruleId}' });
          }
          const target = rules.find(x => x.id === body.ruleId);
          if (target === undefined) return sendJson(res, 404, { error: `unknown rule "${body.ruleId}"` });
          if (target.locked === true) {
            return sendJson(res, 403, { error: `规则 ${body.ruleId} 已锁定，不可删除` });
          }
          const isFromConfig = configRules.some(x => x.id === target.id);
          // 同 PUT：从 store 集合推导，config 规则经墓碑移除而非复制进 store
          const nextRules = storeRules.filter(x => x.id !== target.id);
          // 仅 config 来源的规则需要墓碑（store 来源的规则直接从落盘集合消失即可）
          const nextDeleted = isFromConfig ? [...new Set([...deletedIds, target.id])] : deletedIds.filter(id => id !== target.id);
          try {
            commitStore(nextRules, nextDeleted);
          } catch (err) {
            return sendJson(res, 500, { error: `规则保存失败: ${String(err)}` });
          }
          scheduleBroadcast();
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }),
      // 预览：按给定规则（草稿）渲染消息并判断会不会命中，纯函数不碰任何运行时状态
      registerRoute(webCtx.webServer, '/maze/reminders/preview', async (req: RouteReq, res: RouteRes) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = await readJsonBody(req) as { rule?: Record<string, unknown>; use?: { provider?: unknown; model?: unknown } } | null | undefined;
        if (body === null || body === undefined || typeof body.rule !== 'object' || body.rule === null) {
          return sendJson(res, 400, { error: 'body 应为 {rule: {...}, use?: {provider, model}}' });
        }
        let rule: RuleDef;
        try {
          rule = validateRule(body.rule);
        } catch (err) {
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
          ? body.use as { provider?: unknown; model?: unknown }
          : currentUse === null ? {} : currentUse;
        const use: ModelUse = {
          provider: typeof src.provider === 'string' && src.provider !== '' ? src.provider : '示例提供方',
          model: typeof src.model === 'string' && src.model !== '' ? src.model : 'glm-5.3',
          at: Date.now(),
        };
        // 预览只看条件命中（enabled/muted/频控都按全新状态评估），不占用真实频控额度
        const freshState: RuleState = { enabled: true, firedToday: [] };
        const wouldFire = evaluateModelCall(rule, freshState, use, compileWhen(rule.when));
        return sendJson(res, 200, {
          trigger: 'model-call',
          message: renderMessage(rule.message, use),
          wouldFire,
          evaluatedWith: { provider: use.provider, model: use.model, hour: new Date().getHours() },
        });
      }),
      // 外观偏好：GET 读当前值；PUT 整体替换（校验 fail-loud，坏负载 400）
      registerRoute(webCtx.webServer, '/maze/appearance', async (req: RouteReq, res: RouteRes) => {
        if (req.method === 'GET') return sendJson(res, 200, appearance);
        if (req.method !== 'PUT') return sendJson(res, 405, { error: 'method not allowed' });
        // 外观含 base64 图片：body 上限放宽到 8MiB（IMAGE_MAX_CHARS 6M 字符 + 余量）
        const body = await readJsonBody(req, BODY_MAX_APPEARANCE) as Record<string, unknown> | null | undefined;
        if (body === null || body === undefined) return sendJson(res, 400, { error: 'body 应为外观配置对象' });
        let next: AppearanceConfig;
        try {
          next = validateAppearance(body);
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        // 先落盘后改内存：保存失败时后续 GET 仍返回旧值，内存与磁盘不致分叉
        try {
          saveAppearanceSync(dataDir, next);
        } catch (err) {
          return sendJson(res, 500, { error: `外观保存失败: ${String(err)}` });
        }
        appearance = next;
        return sendJson(res, 200, appearance);
      }),
    ];
    webCtx.effect(() => () => {
      for (const d of disposers) d();
      // SSE 流与节流定时器随插件卸载关闭
      if (sseFlushTimer !== undefined) clearTimeout(sseFlushTimer);
      for (const client of [...sseClients]) client.close();
    });
  });
}
