/**
 * integration_test.js
 * jsdom + fake-indexeddb を使い、実際の index.html/app.js/db.js/sync.js/idlogic.js を
 * ブラウザ相当の環境で読み込み、記録ボタン押下からIndexedDB保存までの
 * エンドツーエンドの流れを検証する。
 * 実行: node integration_test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// fake-indexeddb をグローバルに注入する前に、jsdom の window を作る
async function main() {
  const appDir = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');

  const dom = new JSDOM(html, {
    url: 'https://example.test/app/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // fake-indexeddb を window に紐付け
  const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
  window.indexedDB = indexedDB;
  window.IDBKeyRange = IDBKeyRange;

  // navigator.geolocation のモック（高精度な固定座標を返す）
  let watchCallback = null;
  window.navigator.geolocation = {
    watchPosition: (success) => {
      watchCallback = success;
      // 初回は少し遅れて位置を返す（実機のコールドスタートを模す）
      setTimeout(() => {
        success({
          coords: {
            latitude: 35.681236,
            longitude: 139.767125,
            accuracy: 8.5,
            altitude: 12.3,
            altitudeAccuracy: 5.0,
          },
        });
      }, 10);
      return 1;
    },
    clearWatch: () => {},
  };
  // navigator.vibrate のモック
  window.navigator.vibrate = () => true;
  // serviceWorker.register は本テストでは無視してよい（未定義なら分岐がスキップされる）
  Object.defineProperty(window.navigator, 'onLine', { value: true, writable: true });

  // fetch は今回のテストでは同期を発生させない設定にするため呼ばれない想定だが、
  // 念のためモックしておく
  window.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });

  // confirm は既定で「OK」を返すモック（個別テストで一時的に上書きする）
  window.confirm = () => true;

  // console をそのまま Node の console に橋渡し
  window.console = console;

  // グローバルエラー捕捉
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error || e.message));

  // スクリプトを順に評価（index.html の <script src> の順番と同じにする）
  const scripts = ['idlogic.js', 'db.js', 'sync.js', 'app.js'];
  for (const s of scripts) {
    const code = fs.readFileSync(path.join(appDir, s), 'utf8');
    window.eval(code);
  }

  // DOMContentLoaded を発火させて init() を走らせる
  const evt = new window.Event('DOMContentLoaded', { bubbles: true, cancelable: false });
  window.document.dispatchEvent(evt);

  // GPS取得(10ms遅延) + DB初期化(非同期)を待つ
  await sleep(300);

  const results = { pass: [], fail: [] };
  function check(name, cond, detail) {
    if (cond) results.pass.push(name);
    else results.fail.push(`${name} :: ${detail || ''}`);
  }

  // 1) 起動時エラーが出ていないこと
  check('no runtime errors on init', errors.length === 0, JSON.stringify(errors.map(String)));

  // 2) GPSパネルに座標が反映されていること
  const latText = window.document.querySelector('#gpsLat').textContent;
  check('gps lat rendered', latText === '35.681236', `got "${latText}"`);

  // 3) 精度バッジが「良好」になっていること（accuracy=8.5 <= 10）
  const badgeText = window.document.querySelector('#gpsBadge').textContent;
  check('accuracy badge good', badgeText === '良好', `got "${badgeText}"`);

  // 4) 次のIDプレビューが今日の日付+01になっていること
  const IdLogic = window.IdLogic;
  const todayStr = IdLogic.todayLocalDateStr();
  const expectedPrefix = IdLogic.dateToIdPrefix(todayStr);
  const previewText = window.document.querySelector('#nextIdPreview').textContent;
  check('next id preview format', previewText === `${expectedPrefix}-01`, `got "${previewText}" expected "${expectedPrefix}-01"`);

  // 5) コロニータグボタンが生成されていること
  const tagButtons = Array.from(window.document.querySelectorAll('#tagPanel .tag-toggle'));
  check('colony tag button exists', tagButtons.some(b => b.textContent.includes('コロニー')), tagButtons.map(b=>b.textContent).join(','));

  // 6) タグボタンを押すとID末尾にCが付くこと
  const colonyBtn = tagButtons.find(b => b.textContent.includes('コロニー'));
  colonyBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(50);
  const previewAfterTag = window.document.querySelector('#nextIdPreview').textContent;
  check('id preview updates with tag suffix', previewAfterTag === `${expectedPrefix}-01C`, `got "${previewAfterTag}"`);

  // タグをもう一度押して解除（後続の記録テストをタグなしで実施するため）
  colonyBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(50);

  // 7) メモを入力して記録ボタンを押す -> IndexedDBに1件保存される
  window.document.querySelector('#noteInput').value = 'テストメモ：オオシワアリ、朽木の下';
  window.document.querySelector('#recordBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(150);

  const DB = window.DB;
  const allRecords = await DB.getAllRecords();
  check('one record saved after clicking record button', allRecords.length === 1, `got ${allRecords.length}`);

  if (allRecords.length === 1) {
    const r = allRecords[0];
    check('saved record has correct sample_id', r.sample_id === `${expectedPrefix}-01`, r.sample_id);
    check('saved record has correct lat/lon', r.lat === 35.681236 && r.lon === 139.767125, `${r.lat},${r.lon}`);
    check('saved record has accuracy_m', r.accuracy_m === 8.5, String(r.accuracy_m));
    check('saved record has altitude', r.altitude === 12.3, String(r.altitude));
    check('saved record has note', r.note === 'テストメモ：オオシワアリ、朽木の下', r.note);
    check('saved record synced=false (no gas url set)', r.synced === false, String(r.synced));
  }

  // 8) 記録後、noteInput がクリアされていること
  check('note input cleared after record', window.document.querySelector('#noteInput').value === '', 'note not cleared');

  // 9) undoボタンが有効化されていること、確認ポップアップでキャンセルすると取り消されないこと
  const undoDisabled = window.document.querySelector('#undoBtn').disabled;
  check('undo button enabled after record', undoDisabled === false, String(undoDisabled));

  window.confirm = () => false; // 確認ポップアップで「キャンセル」を選んだ場合を模す
  window.document.querySelector('#undoBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(100);
  const afterCancelledUndo = await DB.getAllRecords();
  check('record NOT removed when undo confirmation is declined', afterCancelledUndo.length === 1, `got ${afterCancelledUndo.length}`);

  // 9b) 確認ポップアップで「OK」を選んだ場合は取り消されること
  window.confirm = () => true;
  window.document.querySelector('#undoBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(100);
  const afterUndo = await DB.getAllRecords();
  check('record removed after undo confirmation accepted', afterUndo.length === 0, `got ${afterUndo.length}`);

  // 10) 2回連続で記録した場合、seqが02まで進むこと（undo後なので再度01からのはず）
  window.document.querySelector('#recordBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(100);
  window.document.querySelector('#recordBtn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(100);
  const twoRecords = await DB.getAllRecords();
  twoRecords.sort((a,b)=>a.id-b.id);
  check('two sequential records get seq 01 and 02', 
    twoRecords.length === 2 && twoRecords[0].sample_id === `${expectedPrefix}-01` && twoRecords[1].sample_id === `${expectedPrefix}-02`,
    JSON.stringify(twoRecords.map(r=>r.sample_id)));

  // ---- 結果出力 ----
  console.log(`\n=== integration test results ===`);
  results.pass.forEach(p => console.log(`PASS: ${p}`));
  results.fail.forEach(f => console.error(`FAIL: ${f}`));
  console.log(`\n${results.pass.length} passed, ${results.fail.length} failed.`);
  // app.js 内の setInterval(renderGps, 1000) がイベントループを生かし続けるため、
  // テスト結果が出た時点で明示的に終了する。
  process.exit(results.fail.length > 0 ? 1 : 0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error(e); process.exit(1); });
