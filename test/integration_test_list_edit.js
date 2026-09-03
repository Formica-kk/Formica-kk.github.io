/**
 * integration_test_list_edit.js
 * 一覧画面・編集モーダル・タグ設定画面の動作をjsdom上で検証する。
 * 実行: node integration_test_list_edit.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

async function main() {
  const appDir = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');

  const dom = new JSDOM(html, {
    url: 'https://example.test/app/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
  window.indexedDB = indexedDB;
  window.IDBKeyRange = IDBKeyRange;

  window.navigator.geolocation = {
    watchPosition: (success) => {
      setTimeout(() => success({
        coords: { latitude: 35.0, longitude: 139.0, accuracy: 5.0, altitude: 10, altitudeAccuracy: 3 },
      }), 5);
      return 1;
    },
    clearWatch: () => {},
  };
  window.navigator.vibrate = () => true;
  Object.defineProperty(window.navigator, 'onLine', { value: true, writable: true });
  window.fetch = async () => ({ ok: true, json: async () => ({ status: 'ok' }) });
  window.confirm = () => true; // 削除確認を常にOKにする
  window.console = console;

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error || e.message));

  const scripts = ['idlogic.js', 'db.js', 'sync.js', 'app.js'];
  for (const s of scripts) {
    window.eval(fs.readFileSync(path.join(appDir, s), 'utf8'));
  }
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  await sleep(200);

  const results = { pass: [], fail: [] };
  function check(name, cond, detail) {
    if (cond) results.pass.push(name);
    else results.fail.push(`${name} :: ${detail || ''}`);
  }
  const $ = (sel) => window.document.querySelector(sel);
  const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true }));

  check('no runtime errors on init', errors.length === 0, JSON.stringify(errors.map(String)));

  // ---- 新しいタグを設定画面から追加する ----
  // 設定タブへ切り替え
  click(window.document.querySelector('[data-view="settingsView"]'));
  await sleep(20);
  check('settings view becomes active', $('#settingsView').classList.contains('active'), '');

  $('#newTagLabel').value = '女王';
  $('#newTagSuffix').value = 'Q';
  click($('#addTagBtn'));
  await sleep(50);

  const tagDefRows = Array.from(window.document.querySelectorAll('#tagDefList li'));
  check('new tag appears in settings list', tagDefRows.some(li => li.textContent.includes('女王')), tagDefRows.map(r=>r.textContent).join('|'));

  // 記録タブに戻り、新タグボタンが選択できることを確認
  click(window.document.querySelector('[data-view="recordView"]'));
  await sleep(20);
  const tagButtons = Array.from(window.document.querySelectorAll('#tagPanel .tag-toggle'));
  const queenBtn = tagButtons.find(b => b.textContent.includes('女王'));
  check('queen tag button available on record view', !!queenBtn, tagButtons.map(b=>b.textContent).join('|'));

  // colony + queen both selected -> suffix should combine in tagDefs order (colony order=1, queen order=2 -> "CQ")
  const colonyBtn = tagButtons.find(b => b.textContent.includes('コロニー'));
  click(colonyBtn);
  click(queenBtn);
  await sleep(30);
  const DB = window.DB;
  const IdLogic = window.IdLogic;
  const todayStr = IdLogic.todayLocalDateStr();
  const prefix = IdLogic.dateToIdPrefix(todayStr);
  const preview = $('#nextIdPreview').textContent;
  check('combined tag suffix order is deterministic (CQ)', preview === `${prefix}-01CQ`, `got "${preview}"`);

  // ---- 記録して一覧に表示されることを確認 ----
  $('#noteInput').value = '初期メモ';
  click($('#recordBtn'));
  await sleep(100);

  click(window.document.querySelector('[data-view="listView"]'));
  await sleep(50);
  check('list view becomes active', $('#listView').classList.contains('active'), '');

  const listItems = Array.from(window.document.querySelectorAll('#recordList li'));
  check('one record shown in list', listItems.length === 1, `got ${listItems.length}`);
  check('list item shows correct sample_id', listItems[0].textContent.includes(`${prefix}-01CQ`), listItems[0].textContent);
  check('list item shows pending sync flag', listItems[0].textContent.includes('未同期'), listItems[0].textContent);

  // ---- 編集モーダルを開いて内容を確認・変更・保存する ----
  click(listItems[0]);
  await sleep(50);
  check('edit modal opens', !$('#editModal').classList.contains('hidden'), '');
  check('edit modal prefilled with correct id', $('#editId').value === `${prefix}-01CQ`, $('#editId').value);
  check('edit modal prefilled with correct note', $('#editNote').value === '初期メモ', $('#editNote').value);

  // メモを追記し、IDを手動変更
  $('#editNote').value = '初期メモ / 後から追記';
  $('#editId').value = `${prefix}-01CQ-relabel`;
  click($('#editSaveBtn'));
  await sleep(80);

  const allAfterEdit = await DB.getAllRecords();
  check('record count unchanged after edit', allAfterEdit.length === 1, `got ${allAfterEdit.length}`);
  check('note was appended', allAfterEdit[0].note === '初期メモ / 後から追記', allAfterEdit[0].note);
  check('id was manually changed', allAfterEdit[0].sample_id === `${prefix}-01CQ-relabel`, allAfterEdit[0].sample_id);
  check('edited record marked unsynced again', allAfterEdit[0].synced === false, String(allAfterEdit[0].synced));

  // ---- 一覧から削除できることを確認 ----
  await sleep(50);
  const listItems2 = Array.from(window.document.querySelectorAll('#recordList li'));
  click(listItems2[0]);
  await sleep(50);
  click($('#editDeleteBtn'));
  await sleep(80);
  const allAfterDelete = await DB.getAllRecords();
  check('record deleted from list/edit modal', allAfterDelete.length === 0, `got ${allAfterDelete.length}`);

  // ---- CSV エクスポートが呼び出し可能であること（例外が出ないこと）----
  let csvExportError = null;
  window.URL.createObjectURL = () => 'blob:mock';
  window.URL.revokeObjectURL = () => {};
  try {
    click($('#exportCsvBtn'));
    await sleep(30);
  } catch (e) {
    csvExportError = e;
  }
  check('csv export does not throw', csvExportError === null, String(csvExportError));

  console.log(`\n=== list/edit integration test results ===`);
  results.pass.forEach(p => console.log(`PASS: ${p}`));
  results.fail.forEach(f => console.error(`FAIL: ${f}`));
  console.log(`\n${results.pass.length} passed, ${results.fail.length} failed.`);
  process.exit(results.fail.length > 0 ? 1 : 0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error(e); process.exit(1); });
