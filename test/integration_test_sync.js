/**
 * integration_test_sync.js
 * sync.js の同期キュー処理を、実際のローカルHTTPサーバー（GASのdoPostを模す）に
 * 対してテストする。オフライン検知、URL未設定時の挙動、部分失敗時の挙動を検証する。
 * 実行: node integration_test_sync.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { JSDOM } = require('jsdom');

function startMockServer(behavior) {
  // behavior(payload) -> { ok: bool, status: number }
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { payload = null; }
      const result = behavior(payload);
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: result.ok ? 'ok' : 'error' }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const appDir = path.join(__dirname, '..');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
  window.indexedDB = indexedDB;
  window.IDBKeyRange = IDBKeyRange;
  Object.defineProperty(window.navigator, 'onLine', { value: true, writable: true });

  window.fetch = (...args) => fetch(...args); // Node18+ グローバルfetchを橋渡し

  window.eval(fs.readFileSync(path.join(appDir, 'idlogic.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(appDir, 'db.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(appDir, 'sync.js'), 'utf8'));

  const DB = window.DB;
  const Sync = window.Sync;
  const results = { pass: [], fail: [] };
  function check(name, cond, detail) {
    if (cond) results.pass.push(name);
    else results.fail.push(`${name} :: ${detail || ''}`);
  }

  // ---- ケース1: GAS URL未設定 -> reason: no_url ----
  await seedRecords(DB, 2);
  let res = await Sync.syncAll();
  check('no gas url -> reason no_url', res.reason === 'no_url', JSON.stringify(res));

  // ---- ケース2: オフライン -> reason: offline ----
  await DB.setSetting('gas_url', 'http://127.0.0.1:9/dummy');
  Object.defineProperty(window.navigator, 'onLine', { value: false, writable: true });
  res = await Sync.syncAll();
  check('offline -> reason offline', res.reason === 'offline', JSON.stringify(res));
  Object.defineProperty(window.navigator, 'onLine', { value: true, writable: true });

  // ---- ケース3: 全件成功 ----
  let received = [];
  const server1 = await startMockServer((payload) => { received.push(payload); return { ok: true }; });
  const port1 = server1.address().port;
  await DB.setSetting('gas_url', `http://127.0.0.1:${port1}/`);

  res = await Sync.syncAll();
  check('all succeed -> sent=2, failed=0', res.sent === 2 && res.failed === 0, JSON.stringify(res));
  check('server received 2 payloads', received.length === 2, String(received.length));
  check('payload contains sample_id field', received.every(p => !!p.sample_id), JSON.stringify(received));

  const allRecords = await DB.getAllRecords();
  check('all records marked synced=true after success', allRecords.every(r => r.synced === true), JSON.stringify(allRecords.map(r=>r.synced)));
  server1.close();

  // ---- ケース4: 部分失敗（サーバーが1件だけ失敗を返す）----
  await clearAllRecords(DB);
  await seedRecords(DB, 3);
  let callCount = 0;
  const server2 = await startMockServer(() => {
    callCount++;
    return { ok: callCount !== 2 }; // 2回目の呼び出しだけ失敗させる
  });
  const port2 = server2.address().port;
  await DB.setSetting('gas_url', `http://127.0.0.1:${port2}/`);

  res = await Sync.syncAll();
  check('partial failure -> sent=2, failed=1', res.sent === 2 && res.failed === 1, JSON.stringify(res));

  const afterPartial = await DB.getAllRecords();
  const syncedCount = afterPartial.filter(r => r.synced).length;
  const unsyncedCount = afterPartial.filter(r => !r.synced).length;
  check('2 records synced, 1 remains unsynced', syncedCount === 2 && unsyncedCount === 1, `synced=${syncedCount} unsynced=${unsyncedCount}`);
  server2.close();

  // ---- ケース5: 再同期で残りの1件も成功する ----
  const server3 = await startMockServer(() => ({ ok: true }));
  const port3 = server3.address().port;
  await DB.setSetting('gas_url', `http://127.0.0.1:${port3}/`);
  res = await Sync.syncAll();
  check('retry syncs remaining unsynced record', res.sent === 1 && res.failed === 0, JSON.stringify(res));
  const finalRecords = await DB.getAllRecords();
  check('all records synced after retry', finalRecords.every(r => r.synced === true), JSON.stringify(finalRecords.map(r=>r.synced)));
  server3.close();

  console.log(`\n=== sync integration test results ===`);
  results.pass.forEach(p => console.log(`PASS: ${p}`));
  results.fail.forEach(f => console.error(`FAIL: ${f}`));
  console.log(`\n${results.pass.length} passed, ${results.fail.length} failed.`);
  process.exit(results.fail.length > 0 ? 1 : 0);
}

async function seedRecords(DB, n) {
  for (let i = 0; i < n; i++) {
    await DB.addRecord({
      sample_id: `20260825-${String(i + 1).padStart(2, '0')}`,
      collection_date: '2026-08-25',
      seq: i + 1,
      tag_keys: [],
      lat: 35.0 + i * 0.001,
      lon: 139.0,
      accuracy_m: 5,
      altitude: 10,
      altitude_accuracy_m: 3,
      timestamp_iso: new Date().toISOString(),
      note: '',
      synced: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
}

async function clearAllRecords(DB) {
  const all = await DB.getAllRecords();
  for (const r of all) await DB.deleteRecord(r.id);
}

main().catch(e => { console.error(e); process.exit(1); });
