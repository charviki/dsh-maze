/**
 * 故事线场次投影测试：workflow 工具调用归约为场次记录。
 * @module dsh-maze/runs.test
 */
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { RUNS_MAX, closeStaleRuns, loadRunsSync, projectSessionEvent } from './runs.js';
/** 构造一条 tool/call 事件（arguments 是 JSON 字符串，与真实事件一致）。 */
function toolCall(callId, script) {
    return { type: 'tool/call', time: 1_000, data: { turn: 1, step: 1, callId, name: 'workflow', arguments: JSON.stringify({ script }) } };
}
/** 构造一条 tool/result 事件。 */
function toolResult(callId, errorName) {
    return { type: 'tool/result', time: 2_000, data: { turn: 1, step: 1, message: { callId }, ...(errorName === undefined ? {} : { error: { name: errorName, code: 'x' } }) } };
}
test('projectSessionEvent：workflow 开场次，提取故事线名', () => {
    const runs = projectSessionEvent([], 'session-a', toolCall('c1', "const wf = workflow(script, { meta: { name: '《功能开发线》' } })"), 1_000);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.templateName, '功能开发线');
    assert.equal(runs[0]?.sessionId, 'session-a');
    assert.equal(runs[0]?.verdict, undefined);
});
test('projectSessionEvent：同 callId 幂等；无关工具不开场次', () => {
    let runs = projectSessionEvent([], 's', toolCall('c1', "phase('《功能开发线》· 拆解')"), 1);
    runs = projectSessionEvent(runs, 's', toolCall('c1', "phase('《功能开发线》· 拆解')"), 2); // 重复投递
    assert.equal(runs.length, 1);
    const other = { type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{}' } };
    assert.equal(projectSessionEvent(runs, 's', other, 3).length, 1); // 非 workflow
});
test('projectSessionEvent：安装版 tool/result 形状（toolCallId + isError）闭场', () => {
    // 实测安装版会话日志：message.toolCallId / message.isError（无 callId / data.error）——
    // 该形状闭不了场是「轨迹永远进行中」的根因，此处钉住回归
    let runs = projectSessionEvent([], 's1', { type: 'tool/call', data: { callId: 'c1', name: 'workflow', arguments: '{ "meta": { "name": "《验证线》" } }' } }, 1_000);
    runs = projectSessionEvent(runs, 's1', { type: 'tool/result', data: { message: { toolCallId: 'c1', isError: false } } }, 2_000);
    assert.equal(runs[0].endedAt, 2_000);
    assert.equal(runs[0].verdict, 'done');
    // isError=true 闭为 failed，errorName 兜底 'error'
    let runs2 = projectSessionEvent([], 's1', { type: 'tool/call', data: { callId: 'c2', name: 'workflow', arguments: '{ "meta": { "name": "《验证线》" } }' } }, 3_000);
    runs2 = projectSessionEvent(runs2, 's1', { type: 'tool/result', data: { message: { toolCallId: 'c2', isError: true } } }, 4_000);
    assert.equal(runs2[0].verdict, 'failed');
    assert.equal(runs2[0].errorName, 'error');
});
test('projectSessionEvent：tool/result 闭场（done 与 failed）', () => {
    const opened = projectSessionEvent([], 's', toolCall('c1', "phase('《修复线》· 复检')"), 1);
    const done = projectSessionEvent(opened, 's', toolResult('c1'), 2);
    assert.equal(done[0]?.verdict, 'done');
    assert.notEqual(done[0]?.endedAt, undefined);
    const failed = projectSessionEvent(opened, 's', toolResult('c1', 'WorkflowError'), 3);
    assert.equal(failed[0]?.verdict, 'failed');
    assert.equal(failed[0]?.errorName, 'WorkflowError');
});
test('projectSessionEvent：templateId 由解析器回填', () => {
    const ev = toolCall('c9', "phase('《修复线》· 定位')");
    const withResolver = projectSessionEvent([], 's1', ev, 1, (name) => (name === '修复线' ? 'fix-line' : ''));
    assert.equal(withResolver[0]?.templateId, 'fix-line');
    // 不给解析器时回落空串（旧调用兼容）
    const withoutResolver = projectSessionEvent([], 's1', ev, 1);
    assert.equal(withoutResolver[0]?.templateId, '');
});
test('loadRunsSync：坏条目整体拒绝（调用方降级）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maze-runs-'));
    const p = join(dir, 'runs.json');
    writeFileSync(p, JSON.stringify({ version: 1, runs: [{ id: 'ok', templateId: '', templateName: 'X', sessionId: 's', startedAt: 1 }, null] }), 'utf8');
    assert.throws(() => loadRunsSync(p), /非法场次条目/);
});
test('loadRunsSync：窗口外的旧坏条目不影响可用历史（只校验最近 RUNS_MAX 场）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maze-runs-'));
    const p = join(dir, 'runs.json');
    const fresh = Array.from({ length: RUNS_MAX }, (_, i) => ({ id: `r${i}`, templateId: '', templateName: 'X', sessionId: 's', startedAt: i + 1 }));
    // 第 21 条（窗口外）是坏条目：仍应返回前 20 条完好场次
    writeFileSync(p, JSON.stringify({ version: 1, runs: [...fresh, null] }), 'utf8');
    const out = loadRunsSync(p);
    assert.equal(out.length, RUNS_MAX);
    assert.equal(out[0].id, 'r0');
});
test('projectSessionEvent：容量截断至 RUNS_MAX', () => {
    let runs = [];
    for (let i = 0; i < RUNS_MAX + 5; i++) {
        runs = projectSessionEvent(runs, 's', toolCall(`c${i}`, "phase('《功能开发线》· 拆解')"), i);
    }
    assert.equal(runs.length, RUNS_MAX);
    // 最新场次在最前
    assert.equal(runs[0]?.id, `c${RUNS_MAX + 4}`);
});
test('projectSessionEvent：无《》标记的 workflow 调用不进轨迹（坏形状/用户手跑/其他编排）', () => {
    // arguments 非串：读不出标记 → 忽略
    const bad = { type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'c9', name: 'workflow', arguments: 42 } };
    assert.equal(projectSessionEvent([], 's', bad, 1).length, 0);
    // 正常字符串但没有《故事线名》标记：同样忽略（官方 agent-team/手工 workflow 不混淆轨迹）
    const bare = { type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'c10', name: 'workflow', arguments: 'run my own script' } };
    assert.equal(projectSessionEvent([], 's', bare, 1).length, 0);
    // 生产形态：骨架 phase 用双引号，经 JSON.stringify(arguments) 后引号被转义为 \" ——正则必须容忍
    const escaped = { type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'c12', name: 'workflow', arguments: JSON.stringify({ script: 'phase("《功能开发线》· 拆解")' }) } };
    {
        const runs = projectSessionEvent([], 's', escaped, 1);
        assert.equal(runs.length, 1);
        assert.equal(runs[0]?.templateName, '功能开发线');
    }
    // 裸《…》没有 name/phase 锚（如环提示文本混进参数）：不得误开场次
    const bareMarker = { type: 'tool/call', time: 1, data: { turn: 1, step: 1, callId: 'c11', name: 'workflow', arguments: JSON.stringify({ script: '《环》拆解 一些提示' }) } };
    assert.equal(projectSessionEvent([], 's', bareMarker, 1).length, 0);
    // 无关事件照旧忽略
    assert.equal(projectSessionEvent([], 's', { type: 'turn/start', time: 1, data: {} }, 1).length, 0);
});
test('closeStaleRuns：应用重启后关闭无主的进行中场次', () => {
    const base = [
        { id: 'a', templateId: 'feature-line', templateName: '功能开发线', sessionId: 's1', startedAt: 1, endedAt: 100, verdict: 'done' },
        { id: 'b', templateId: 'feature-line', templateName: '功能开发线', sessionId: 's2', startedAt: 2 },
    ];
    const closed = closeStaleRuns(base, 500);
    assert.equal(closed[0], base[0]); // 已关闭的原样保留（含引用）
    assert.equal(closed[1].endedAt, 500);
    assert.equal(closed[1].verdict, 'failed');
    assert.equal(closed[1].errorName, 'interrupted');
    // 无开放场次时返回原引用（调用方跳过落盘）
    assert.equal(closeStaleRuns(closed, 600), closed);
});
