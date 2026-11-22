import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { davRequest, loadSyncConnection, saveSyncConnection, summarizeBundle, validateSyncBundle, validateSyncConnection, type SyncBundle } from './sync.js';

async function main(): Promise<void> {
  // ---- validateSyncConnection：归一（trim/去尾斜杠/默认路径）与逐项拒绝 ----
  {
    const conn = validateSyncConnection({
      server: 'https://dav.jianguoyun.com/dav///',
      username: ' user@example.com ',
      password: ' app-pass ',
      remotePath: '',
    });
    assert.equal(conn.server, 'https://dav.jianguoyun.com/dav');
    assert.equal(conn.username, 'user@example.com');
    assert.equal(conn.password, 'app-pass');
    assert.equal(conn.remotePath, '/dsh-maze/config.json'); // 缺省远程路径
    assert.throws(() => validateSyncConnection({ server: 'ftp://x', username: 'u', password: 'p', remotePath: '/a' }), /http\(s\) URL/);
    assert.throws(() => validateSyncConnection({ server: 'https://dav', username: '', password: 'p', remotePath: '/a' }), /用户名/);
    assert.throws(() => validateSyncConnection({ server: 'https://dav', username: 'u', password: '', remotePath: '/a' }), /应用密码/);
    assert.throws(() => validateSyncConnection({ server: 'https://dav', username: 'u', password: 'p', remotePath: 'no-slash' }), /\/ 开头/);
    assert.throws(() => validateSyncConnection('x'), /对象/);
  }

  // ---- 连接配置持久化：缺省 null、往返、损坏 throw、0600 权限 ----
  {
    const dir = mkdtempSync(join(tmpdir(), 'maze-sync-'));
    try {
      assert.equal(loadSyncConnection(dir), null);
      const conn = validateSyncConnection({ server: 'https://dav.jianguoyun.com/dav', username: 'u', password: 'p', remotePath: '/maze.json' });
      saveSyncConnection(dir, conn);
      assert.deepEqual(loadSyncConnection(dir), conn);
      assert.equal(statSync(join(dir, 'sync.json')).mode & 0o777, 0o600);
      writeFileSync(join(dir, 'sync.json'), '{broken', 'utf8');
      assert.throws(() => loadSyncConnection(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- validateSyncBundle：外壳门禁（kind/version/uploadedAt/machine/section 形状）----
  {
    const good: SyncBundle = {
      kind: 'dsh-maze-config', version: 1, uploadedAt: 123, machine: 'mac',
      rules: { version: 1, rules: [], deletedIds: [] }, appearance: null, narratives: null,
    };
    assert.deepEqual(validateSyncBundle(good), good);
    assert.throws(() => validateSyncBundle({ ...good, kind: 'other' }), /kind/);
    assert.throws(() => validateSyncBundle({ ...good, version: 2 }), /版本/);
    assert.throws(() => validateSyncBundle({ ...good, uploadedAt: 'x' }), /uploadedAt/);
    assert.throws(() => validateSyncBundle({ ...good, rules: 'x' }), /rules/);
    // null 段合法（=上传机上没有该项）
    assert.equal(validateSyncBundle({ ...good, rules: null }).rules, null);
  }

  // ---- summarizeBundle：摘要不含大字段，规则/外观/故事线要点齐全 ----
  {
    const summary = summarizeBundle({
      kind: 'dsh-maze-config', version: 1, uploadedAt: 456, machine: 'mbp',
      rules: { version: 1, rules: [{ id: 'r1', name: 'glm 高峰', trigger: 'model-call' }], deletedIds: ['x', 'y'] },
      appearance: { background: { image: 'data:image/webp;base64,AAA', enabled: true }, hosts: [{}, {}, {}] },
      narratives: { templates: [{ id: 't1', name: '功能线' }], deletedIds: [], selectedTemplateId: 't1' },
    });
    assert.equal(summary.machine, 'mbp');
    assert.deepEqual(summary.rules, [{ id: 'r1', name: 'glm 高峰', trigger: 'model-call' }]);
    assert.equal(summary.ruleDeletedCount, 2);
    assert.deepEqual(summary.appearance, { hasBackground: true, backgroundEnabled: true, hostCount: 3 });
    assert.deepEqual(summary.narratives, { templates: [{ id: 't1', name: '功能线' }], selectedTemplateId: 't1' });
  }

  // ---- davRequest：对本地 mock WebDAV 的 PUT/GET 往返 + Basic 认证头 + 404 透传 ----
  {
    let stored = '';
    let lastAuth = '';
    const server: Server = await new Promise<Server>(resolve => {
      const s = createServer((req, res) => {
        lastAuth = req.headers.authorization ?? '';
        if (req.method === 'PUT') {
          let body = '';
          req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
          req.on('end', () => { stored = body; res.writeHead(201); res.end(); });
          return;
        }
        if (stored === '') { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(stored);
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = server.address();
      assert.ok(typeof addr === 'object' && addr !== null);
      const conn = validateSyncConnection({
        server: `http://127.0.0.1:${addr.port}/dav`, username: 'u', password: 'p', remotePath: '/maze.json',
      });
      // 未上传过：404（调用方解释为"云端为空"）
      assert.equal((await davRequest(conn, 'GET')).status, 404);
      const put = await davRequest(conn, 'PUT', JSON.stringify({ hello: 1 }));
      assert.equal(put.status, 201);
      assert.match(lastAuth, /^Basic /); // Basic 认证头随请求带上
      const got = await davRequest(conn, 'GET');
      assert.equal(got.status, 200);
      assert.equal(JSON.parse(got.text).hello, 1);
      // 网络层错误（连不上的端口）转为可读 Error 而非裸 fetch 异常
      const bad = validateSyncConnection({ server: 'http://127.0.0.1:1/', username: 'u', password: 'p', remotePath: '/x' });
      await assert.rejects(() => davRequest(bad, 'GET'), /WebDAV 连接失败/);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  console.log('sync.test: all passed');
}

await main();
