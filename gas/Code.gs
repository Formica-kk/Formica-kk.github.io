/**
 * Code.gs
 * 採集記録アプリ用 Google Apps Script。
 * PWA から POST された1レコードを、紐づいたスプレッドシートの
 * 「records」シートに1行として追記する。
 *
 * セットアップ手順は gas/README.md を参照。
 */

const SHEET_NAME = 'records';
const HEADER = [
  'received_at',       // サーバー側で受信した時刻（重複検知の補助情報）
  'sample_id',
  'collection_date',
  'seq',
  'tag_keys',
  'lat',
  'lon',
  'accuracy_m',
  'altitude',
  'altitude_accuracy_m',
  'timestamp_iso',
  'note',
];

function getOrCreateSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getRange(1, 1).getValue() !== HEADER[0]) {
    sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 同じ sample_id が既に存在するか調べる（同期リトライ等での重複追記を防ぐ）。
 * sample_id 列 (HEADER中のインデックス1 = B列) を対象に検索する。
 */
function findExistingRow_(sheet, sampleId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const idCol = HEADER.indexOf('sample_id') + 1; // 1-indexed
  const values = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === sampleId) return i + 2; // シート上の行番号
  }
  return -1;
}

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ status: 'error', message: 'invalid_json' });
  }

  if (!payload.sample_id) {
    return jsonResponse_({ status: 'error', message: 'missing_sample_id' });
  }

  const sheet = getOrCreateSheet_();

  // 同じsample_idの行が既にあれば上書き更新（編集後の再送信に対応）、
  // なければ新規追加する。
  const existingRow = findExistingRow_(sheet, payload.sample_id);
  const row = [
    new Date(),
    payload.sample_id || '',
    payload.collection_date || '',
    payload.seq || '',
    payload.tag_keys || '',
    payload.lat != null ? payload.lat : '',
    payload.lon != null ? payload.lon : '',
    payload.accuracy_m != null ? payload.accuracy_m : '',
    payload.altitude != null ? payload.altitude : '',
    payload.altitude_accuracy_m != null ? payload.altitude_accuracy_m : '',
    payload.timestamp_iso || '',
    payload.note || '',
  ];

  if (existingRow > 0) {
    sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }

  return jsonResponse_({ status: 'ok' });
}

function doGet(e) {
  // ヘルスチェック用。ブラウザでURLを直接開いたときの動作確認に使う。
  return jsonResponse_({ status: 'ok', message: 'collector-app sync endpoint is running' });
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
