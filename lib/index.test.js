import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameOriginRequest, readJsonBody } from './index.js';
/** 构造带指定头的最小请求形状（栅栏只读 headers） */
function reqWith(headers) {
    return { method: 'GET', headers, on: () => { } };
}
test('同源栅栏：无浏览器标记（curl/本地工具形状）放行', () => {
    assert.equal(isSameOriginRequest(reqWith({})), true);
    assert.equal(isSameOriginRequest({ method: 'GET', on: () => { } }), true);
});
test('同源栅栏：sec-fetch-site 只有 same-origin/same-site/none 放行', () => {
    assert.equal(isSameOriginRequest(reqWith({ 'sec-fetch-site': 'cross-site' })), false);
    assert.equal(isSameOriginRequest(reqWith({ 'sec-fetch-site': 'same-origin' })), true);
    assert.equal(isSameOriginRequest(reqWith({ 'sec-fetch-site': 'same-site' })), true);
    assert.equal(isSameOriginRequest(reqWith({ 'sec-fetch-site': 'none' })), true);
});
test('同源栅栏：Origin 必须与 Host（含端口）全等', () => {
    // 同源页面 fetch：Origin 与 Host 一致
    assert.equal(isSameOriginRequest(reqWith({ origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })), true);
    // 恶意网页 drive-by：Origin 是攻击者站点
    assert.equal(isSameOriginRequest(reqWith({ origin: 'https://evil.example', host: '127.0.0.1:3080' })), false);
    // 同域名不同端口也不放行（可能是本机另一个页面）
    assert.equal(isSameOriginRequest(reqWith({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:3080' })), false);
    // 坏 URL 形状的 Origin 不信任
    assert.equal(isSameOriginRequest(reqWith({ origin: 'not-a-url', host: '127.0.0.1:3080' })), false);
});
test('同源栅栏：sec-fetch-site 与 Origin 双跨站时仍拒绝', () => {
    assert.equal(isSameOriginRequest(reqWith({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example', host: '127.0.0.1:3080' })), false);
});
/** 构造可手动发射事件的请求体形状（readJsonBody 只用 on/destroy） */
function fakeStreamReq() {
    const handlers = new Map();
    const req = {
        method: 'PUT',
        on: (ev, cb) => {
            const list = handlers.get(ev) ?? [];
            list.push(cb);
            handlers.set(ev, list);
        },
    };
    return { req, emit: (ev, chunk) => { for (const cb of handlers.get(ev) ?? [])
            cb(chunk); } };
}
test('readJsonBody：正常小负载解析为对象', async () => {
    const { req, emit } = fakeStreamReq();
    const pending = readJsonBody(req);
    emit('data', '{"ok":');
    emit('data', 'true}');
    emit('end');
    assert.deepEqual(await pending, { ok: true });
});
test('readJsonBody：坏 JSON 与空体都返回 undefined', async () => {
    const bad = fakeStreamReq();
    const p1 = readJsonBody(bad.req);
    bad.emit('data', '{oops');
    bad.emit('end');
    assert.equal(await p1, undefined);
    const empty = fakeStreamReq();
    const p2 = readJsonBody(empty.req);
    empty.emit('end');
    assert.equal(await p2, undefined);
});
test('readJsonBody：超过 maxBytes 截断并返回 undefined（超限断流语义）', async () => {
    const { req, emit } = fakeStreamReq();
    const pending = readJsonBody(req, 1024);
    // 一次 2KB 数据块即超限：应立即 resolve undefined，后续 end 不再影响结果
    emit('data', 'x'.repeat(2048));
    emit('end');
    assert.equal(await pending, undefined);
});
test('readJsonBody：恰好在上限内的负载正常解析', async () => {
    const { req, emit } = fakeStreamReq();
    const body = JSON.stringify({ data: 'y'.repeat(900) });
    const pending = readJsonBody(req, 1024);
    emit('data', body);
    emit('end');
    assert.deepEqual(await pending, { data: 'y'.repeat(900) });
});
test('readJsonBody：多字节 UTF-8 跨块不损坏（缓冲后一次解码）', async () => {
    const { req, emit } = fakeStreamReq();
    const raw = Buffer.from('{"msg":"额度提醒"}', 'utf8');
    const pending = readJsonBody(req);
    // 在多字节字符中间切开：逐块 String() 解码会产生 U+FFFD 乱码
    emit('data', raw.subarray(0, 12));
    emit('data', raw.subarray(12));
    emit('end');
    assert.deepEqual(await pending, { msg: '额度提醒' });
});
test('readJsonBody：上限按真实字节计，不是 UTF-16 字符数', async () => {
    const { req, emit } = fakeStreamReq();
    const pending = readJsonBody(req, 100);
    // 60 个中文 = 180 字节（UTF-16 计数只有 60）：按字符数会错误放行
    emit('data', Buffer.from('中'.repeat(60), 'utf8'));
    emit('end');
    assert.equal(await pending, undefined);
});
test('readJsonBody：合法 JSON null 解析为 null（路由须同时守卫 null 与 undefined）', async () => {
    const { req, emit } = fakeStreamReq();
    const pending = readJsonBody(req);
    emit('data', 'null');
    emit('end');
    assert.equal(await pending, null);
});
