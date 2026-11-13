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
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-maze";
export declare const inject: string[];
export interface Config {
    rules: unknown[];
}
export declare const Config: z<Config>;
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
/**
 * 读 JSON 请求体；坏 JSON / 请求中断（error 事件）/ 超过 maxBytes 都返回 undefined（路由回 400）。
 * 超限即停止缓冲并销毁连接（宁可断流，不缓冲无上限的 body）。
 */
export declare function readJsonBody(req: RouteReq, maxBytes?: number): Promise<unknown>;
/**
 * 同源信任栅栏：dsh 平台对回环 socket 免鉴权，意味着任何
 * 本地进程与恶意网页的 drive-by fetch 都能打到 /maze/* 路由。浏览器跨站请求必然携带
 * sec-fetch-site 或 Origin 之一，在这里拒掉；curl 等不带浏览器标记的本地工具不受影响。
 */
export declare function isSameOriginRequest(req: RouteReq): boolean;
export declare function apply(ctx: any, config: Config): void;
