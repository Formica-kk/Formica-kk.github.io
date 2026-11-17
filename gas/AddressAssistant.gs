/** Add these two files to the existing, spreadsheet-bound Apps Script project. */
const AA = Object.freeze({
  sheet: 'records', columns: ['国', '都道府県', '市区町村・町域', '住所補完_状態', '住所補完_座標'],
  batch: 30, budgetMs: 90000, trigger: 'addressAutoRun',
});

function onOpen() {
  SpreadsheetApp.getUi().createMenu('住所補完')
    .addItem('住所補完を開く', 'showAddressAssistant').addToUi();
}

function showAddressAssistant() {
  aaBook_();
  SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('AddressSidebar').setTitle('座標から住所補完'));
}

function aaBook_() {
  const props = PropertiesService.getScriptProperties();
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) { props.setProperty('AA_SPREADSHEET_ID', active.getId()); return active; }
  const id = props.getProperty('AA_SPREADSHEET_ID');
  if (!id) throw new Error('スプレッドシートから住所補完を一度開いてください。');
  return SpreadsheetApp.openById(id);
}

function aaSheet_() {
  const sheet = aaBook_().getSheetByName(AA.sheet);
  if (!sheet) throw new Error('records シートがありません。先に記録を同期してください。');
  return sheet;
}

function aaLayout_(sheet, create) {
  const names = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(x => String(x).trim());
  const relevant = ['lat', 'lon', 'sample_id'].concat(AA.columns);
  relevant.forEach(name => {
    if (names.filter(x => x === name).length > 1) throw new Error('同じ列名が複数あります: ' + name);
  });
  ['lat', 'lon'].forEach(name => {
    if (names.indexOf(name) < 0) throw new Error(name + ' 列が見つかりません。1行目の見出しを確認してください。');
  });
  if (create) {
    AA.columns.forEach(name => {
      if (names.indexOf(name) >= 0) return;
      const col = names.length + 1;
      if (col > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), col - sheet.getMaxColumns());
      sheet.getRange(1, col).setValue(name);
      names.push(name);
      if (name === '住所補完_座標') sheet.hideColumns(col);
    });
  }
  const map = {};
  names.forEach((name, i) => { map[name] = i; });
  return { names, map };
}

function aaCoordinate_(lat, lon) {
  function number(value) {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string' || !value.trim()) return NaN;
    return Number(value.trim());
  }
  const a = number(lat), b = number(lon);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: a, lon: b, key: a + ',' + b };
}

function aaEmpty_(value) { return value === '' || value == null; }

function aaState_(row, formulas, map) {
  const address = AA.columns.slice(0, 3).map(name => row[map[name]]);
  const occupied = AA.columns.slice(0, 3).map((name, i) => !aaEmpty_(address[i]) || !!formulas[map[name]]);
  const coordinate = aaCoordinate_(row[map.lat], row[map.lon]);
  const previous = row[map['住所補完_座標']] || '';
  const state = row[map['住所補完_状態']] || '';
  const changed = !!previous && previous !== (coordinate ? coordinate.key : 'invalid');
  // Filled cells (including formulas returning "") are never overwritten.
  if (occupied.every(Boolean)) return { eligible: false, changed, coordinate };
  if (changed && occupied.some(Boolean)) return { eligible: false, changed, coordinate };
  if (!changed && previous && /^(取得済|一部取得|住所なし|座標不正)/.test(state)) return { eligible: false, coordinate };
  return { eligible: true, coordinate };
}

/** Only explicit geographic components; never formatted_address, building or street numbers. */
function aaExtract_(response) {
  if (response.status === 'ZERO_RESULTS') return { values: ['', '', ''], state: '住所なし' };
  if (response.status !== 'OK') throw new Error('住所サービス: ' + (response.status || '応答不正'));
  const candidates = (response.results || []).map(result => {
    const components = result.address_components || [];
    const find = type => components.find(c => (c.types || []).includes(type));
    const get = type => (find(type) || {}).long_name || '';
    const country = get('country');
    const jp = ((find('country') || {}).short_name === 'JP');
    const prefecture = get('administrative_area_level_1');
    const types = ['administrative_area_level_2', 'administrative_area_level_3', 'administrative_area_level_4',
      'locality', 'postal_town', 'sublocality_level_1', 'sublocality_level_2', 'sublocality_level_3', 'sublocality', 'neighborhood'];
    const parts = [];
    types.forEach(type => {
      let name = get(type).trim();
      if (jp) name = name.replace(/[0-9０-９一二三四五六七八九十百]+丁目.*$/, '').trim();
      if (!name || name === country || name === prefecture || parts.includes(name)) return;
      // Numbered blocks returned as sublocality are not town names.
      if (jp && (/^[0-9０-９一二三四五六七八九十百ー−－―\-]+(?:番地?|号)?$/.test(name) || /[0-9０-９]+[-－][0-9０-９]+/.test(name))) return;
      parts.push(name);
    });
    const values = [country, prefecture, parts.join(jp ? '' : ', ')];
    return { values, score: (country ? 100 : 0) + (prefecture ? 10 : 0) + parts.length };
  });
  candidates.sort((a, b) => b.score - a.score);
  const values = candidates.length ? candidates[0].values : ['', '', ''];
  return { values, state: values.every(Boolean) ? '取得済' : values.some(Boolean) ? '一部取得（要確認）' : '住所なし' };
}

function aaLookup_(coordinate, memo) {
  if (memo[coordinate.key]) return memo[coordinate.key];
  const result = aaExtract_(Maps.newGeocoder().setLanguage('ja').reverseGeocode(coordinate.lat, coordinate.lon));
  memo[coordinate.key] = result;
  Utilities.sleep(150);
  return result;
}

function addressGetStatus() {
  const sheet = aaSheet_(), { names, map } = aaLayout_(sheet, false);
  const count = Math.max(0, sheet.getLastRow() - 1);
  let pending = 0, review = 0;
  if (count) {
    const range = sheet.getRange(2, 1, count, names.length), rows = range.getValues(), formulas = range.getFormulas();
    rows.forEach((row, i) => {
      if (row.every(aaEmpty_) && !formulas[i].some(Boolean)) return;
      const state = aaState_(row, formulas[i], map);
      if (state.eligible) pending++;
      if (state.changed || /要確認|住所なし|座標不正/.test(row[map['住所補完_状態']] || '')) review++;
    });
  }
  return { total: count, pending, review, automatic: ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === AA.trigger) };
}

function addressPreview() {
  const sheet = aaSheet_(), { names, map } = aaLayout_(sheet, false);
  if (sheet.getLastRow() < 2) return [];
  const range = sheet.getRange(2, 1, sheet.getLastRow() - 1, names.length), rows = range.getValues(), formulas = range.getFormulas();
  const preview = [], memo = {};
  for (let i = 0; i < rows.length && preview.length < 5; i++) {
    const row = rows[i];
    if (row.every(aaEmpty_) && !formulas[i].some(Boolean)) continue;
    const state = aaState_(row, formulas[i], map);
    if (!state.eligible) continue;
    const found = state.coordinate ? aaLookup_(state.coordinate, memo) : { values: ['', '', ''], state: '座標不正' };
    preview.push({ row: i + 2, id: String(row[map.sample_id] || ''), values: found.values, state: found.state });
  }
  return preview;
}

function addressFillBatch(startRow) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('別の住所補完・同期が実行中です。少し待って再実行してください。');
  try {
    const sheet = aaSheet_(), { names, map } = aaLayout_(sheet, true);
    const last = sheet.getLastRow();
    let start = Number.isInteger(Number(startRow)) && Number(startRow) >= 2 ? Number(startRow) : 2;
    if (start > last) return { processed: 0, filled: 0, invalid: 0, review: 0, nextRow: 2, done: true };
    const range = sheet.getRange(start, 1, last - start + 1, names.length);
    const rows = range.getValues(), formulas = range.getFormulas(), memo = {}, began = Date.now();
    const report = { processed: 0, filled: 0, invalid: 0, review: 0, nextRow: start, done: false };
    for (let i = 0; i < rows.length; i++) {
      if (report.processed >= AA.batch || Date.now() - began >= AA.budgetMs) break;
      const rowNumber = start + i, row = rows[i];
      report.nextRow = rowNumber + 1;
      if (row.every(aaEmpty_) && !formulas[i].some(Boolean)) continue;
      const state = aaState_(row, formulas[i], map);
      if (state.changed && !state.eligible) {
        sheet.getRange(rowNumber, map['住所補完_状態'] + 1).setValue('座標変更・要確認（住所は保持）');
        report.review++; continue;
      }
      if (!state.eligible) continue;
      report.processed++;
      let found;
      try {
        found = state.coordinate ? aaLookup_(state.coordinate, memo) : { values: ['', '', ''], state: '座標不正' };
      } catch (error) {
        // Stop on quota/service errors instead of burning the remaining requests.
        sheet.getRange(rowNumber, map['住所補完_状態'] + 1).setValue('取得エラー・再実行可');
        report.nextRow = rowNumber;
        report.error = String(error.message || error);
        return report;
      }
      // Re-read after the network call: avoid writing an address to a moved/edited record.
      const liveRange = sheet.getRange(rowNumber, 1, 1, names.length);
      const live = liveRange.getValues()[0], liveFormulas = liveRange.getFormulas()[0];
      if (JSON.stringify(live) !== JSON.stringify(row) || JSON.stringify(liveFormulas) !== JSON.stringify(formulas[i])) {
        report.review++; continue;
      }
      // Abort on concurrent column changes, before any address is written.
      const headersNow = sheet.getRange(1, 1, 1, names.length).getValues()[0].map(x => String(x).trim());
      if (JSON.stringify(headersNow) !== JSON.stringify(names)) throw new Error('処理中に列が変更されました。再実行してください。');
      let writes = 0;
      AA.columns.slice(0, 3).forEach((name, j) => {
        if (aaEmpty_(live[map[name]]) && !liveFormulas[map[name]] && found.values[j]) {
          // Guard the spreadsheet formula prefix in service-provided labels.
          sheet.getRange(rowNumber, map[name] + 1).setValue(aaLiteral_(found.values[j])); writes++;
        }
      });
      sheet.getRange(rowNumber, map['住所補完_状態'] + 1).setValue(found.state);
      sheet.getRange(rowNumber, map['住所補完_座標'] + 1).setValue(state.coordinate ? state.coordinate.key : 'invalid');
      if (writes) report.filled++;
      if (!state.coordinate) report.invalid++;
      if (found.state !== '取得済') report.review++;
    }
    report.done = report.nextRow > last;
    if (report.done) report.nextRow = 2;
    SpreadsheetApp.flush();
    return report;
  } finally { lock.releaseLock(); }
}

function aaLiteral_(value) { return /^[=+@-]/.test(String(value)) ? "'" + value : value; }

function addressEnableAuto() {
  aaBook_(); aaSheet_();
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === AA.trigger)) {
      ScriptApp.newTrigger(AA.trigger).timeBased().everyHours(1).create();
    }
  } finally { lock.releaseLock(); }
  return addressGetStatus();
}

function addressDisableAuto() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === AA.trigger).forEach(t => ScriptApp.deleteTrigger(t));
  return addressGetStatus();
}

function addressAutoRun() {
  const props = PropertiesService.getScriptProperties();
  const result = addressFillBatch(Number(props.getProperty('AA_NEXT_ROW') || 2));
  props.setProperty('AA_NEXT_ROW', String(result.nextRow));
  // Limit to 30 lookups/hour (720/day) and leave room for manual runs.
}
