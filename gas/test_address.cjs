const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/AddressAssistant.gs', 'utf8');
const component = (name, type, short = name) => ({ long_name: name, short_name: short, types: [type, 'political'] });
const result = (...components) => ({ status: 'OK', results: [{ address_components: components }] });
const japan = result(component('日本', 'country', 'JP'), component('東京都', 'administrative_area_level_1'),
  component('千代田区', 'locality'), component('丸の内', 'sublocality_level_1'),
  component('一丁目', 'sublocality_level_2'), component('9', 'sublocality_level_3'),
  component('1', 'street_number'), component('駅ビル', 'premise'), component('100-0005', 'postal_code'));
function env(data = [['sample_id', 'lat', 'lon'], ['a', 35, 139]], response = japan) {
  const formulas = [], props = {}, requests = [], triggers = [];
  let locked = false, duringLookup = () => {};
  const sheet = {
    getLastRow: () => data.length,
    getLastColumn: () => Math.max(...data.map(r => r.length)),
    getMaxColumns: () => 30, hideColumns() {}, insertColumnsAfter() {},
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => data[r - 1 + i]?.[c - 1 + j] ?? '')),
        getFormulas: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => formulas[r - 1 + i]?.[c - 1 + j] ?? '')),
        setValue(value) { data[r - 1] ||= []; data[r - 1][c - 1] = value; return this; },
      };
    },
  };
  const book = { getSheetByName: name => name === 'records' ? sheet : null, getId: () => 'test' };
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => book, openById: () => book, flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k], setProperty(k, v) { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (locked) return false; locked = true; return true; }, releaseLock() { locked = false; } }) },
    Maps: { newGeocoder: () => ({ setLanguage() { return this; }, reverseGeocode(lat, lon) { requests.push([lat, lon]); duringLookup(); return response; } }) },
    Utilities: { sleep() {} },
    ScriptApp: { getProjectTriggers: () => triggers },
  });
  vm.runInContext(source, context);
  return { c: context, data, formulas, requests, duringLookup: fn => { duringLookup = fn; } };
}
const plain = value => JSON.parse(JSON.stringify(value));
test('Japanese country/prefecture/town excludes chome, numbers, postal code and building', () => {
  const { c } = env(); assert.deepEqual(plain(c.aaExtract_(japan).values), ['日本', '東京都', '千代田区丸の内']);
});
test('City, ward and town hierarchy; preserve numerals in town names', () => {
  const { c } = env(); const r = result(component('日本', 'country', 'JP'), component('大阪府', 'administrative_area_level_1'),
    component('大阪市', 'locality'), component('北区', 'sublocality_level_1'), component('西天満四丁目', 'sublocality_level_2'));
  assert.equal(c.aaExtract_(r).values[2], '大阪市北区西天満');
  r.results[0].address_components[4].long_name = '四谷三栄町';
  assert.equal(c.aaExtract_(r).values[2], '大阪市北区四谷三栄町');
});
test('International address excludes street and street number', () => {
  const { c } = env(); const r = result(component('アメリカ合衆国', 'country', 'US'), component('カリフォルニア州', 'administrative_area_level_1'),
    component('Mountain View', 'locality'), component('1600', 'street_number'), component('Amphitheatre Parkway', 'route'));
  assert.deepEqual(plain(c.aaExtract_(r).values), ['アメリカ合衆国', 'カリフォルニア州', 'Mountain View']);
});
test('Missing components are explicit and never invented', () => {
  const { c } = env(); assert.equal(c.aaExtract_(result(component('日本', 'country', 'JP'))).state, '一部取得（要確認）');
  assert.equal(c.aaExtract_({ status: 'ZERO_RESULTS' }).state, '住所なし');
  assert.throws(() => c.aaExtract_({ status: 'OVER_QUERY_LIMIT' }), /OVER_QUERY_LIMIT/);
});
test('Blank, boolean, malformed and out of range coordinates rejected; zero valid', () => {
  const { c } = env();
  for (const pair of [['', 1], [' ', 1], [null, 1], [true, 1], ['NaN', 1], [91, 1], [1, -181], [Infinity, 0]]) assert.equal(c.aaCoordinate_(...pair), null);
  assert.deepEqual(plain(c.aaCoordinate_('0', ' 0 ')), { lat: 0, lon: 0, key: '0,0' });
});
test('Preview does not add columns or change cells', () => {
  const e = env(), before = JSON.stringify(e.data); assert.equal(e.c.addressPreview().length, 1); assert.equal(JSON.stringify(e.data), before);
});
test('Fill appends columns and idempotently fills exact correct row', () => {
  const e = env(); assert.equal(e.c.addressFillBatch(2).filled, 1);
  assert.deepEqual(e.data[1].slice(3, 6), ['日本', '東京都', '千代田区丸の内']);
  assert.equal(e.c.addressFillBatch(2).processed, 0); assert.equal(e.requests.length, 1);
});
test('Preserves user text and formulas, even formulas returning empty text', () => {
  const e = env([['sample_id','lat','lon','国','都道府県','市区町村・町域'], ['a',35,139,'手入力','','']]);
  e.formulas[1] = ['', '', '', '', '=IF(TRUE,"","")', ''];
  e.c.addressFillBatch(2);
  assert.equal(e.data[1][3], '手入力'); assert.equal(e.data[1][4], ''); assert.equal(e.data[1][5], '千代田区丸の内');
});
test('Coordinate changes preserve existing addresses and flag review', () => {
  const e = env(); e.c.addressFillBatch(2); e.data[1][1] = 34;
  const r = e.c.addressFillBatch(2); assert.equal(r.review, 1); assert.equal(e.requests.length, 1); assert.match(e.data[1][6], /座標変更/);
  e.data[1][3] = e.data[1][4] = e.data[1][5] = e.data[1][6] = '';
  assert.equal(e.c.addressFillBatch(2).filled, 1); assert.equal(e.requests.length, 2);
});
test('Invalid coordinate is not sent to Google and does not stall later valid rows', () => {
  const e = env([['sample_id','lat','lon'],['a','',139],['b',35,139]]);
  const r = e.c.addressFillBatch(2); assert.equal(r.invalid, 1); assert.equal(r.filled, 1); assert.equal(e.requests.length, 1);
  assert.equal(e.c.addressFillBatch(2).processed, 0);
});
test('Reordered columns are mapped by header; unrelated data unchanged', () => {
  const e = env([['note','lon','国','sample_id','lat'],['original',139,'','a',35]]); e.c.addressFillBatch(2);
  assert.equal(e.data[1][0], 'original'); assert.equal(e.data[1][2], '日本'); assert.equal(e.data[1][4], 35);
});
test('Duplicate or missing required headers stop before modifying data', () => {
  for (const headers of [['lat','lat','lon'],['sample_id','latitude','lon']]) {
    const e = env([headers,['a',35,139]]); const before = JSON.stringify(e.data);
    assert.throws(() => e.c.addressFillBatch(2)); assert.equal(JSON.stringify(e.data), before);
  }
});
test('Concurrent record edit is rechecked after lookup', () => {
  const e = env(); e.duringLookup(() => { e.data[1][1] = 36; });
  assert.equal(e.c.addressFillBatch(2).filled, 0); assert.equal(e.data[1][3], undefined);
});
test('Batch resumes after 30 rows; duplicate coordinates share a lookup per batch', () => {
  const e = env([['sample_id','lat','lon'], ...Array.from({ length: 35 }, (_, i) => ['a'+i,35,139])]);
  const r = e.c.addressFillBatch(2); assert.equal(r.filled, 30); assert.equal(r.done, false); assert.equal(r.nextRow, 32);
  const r2 = e.c.addressFillBatch(r.nextRow); assert.equal(r2.filled, 5); assert.equal(r2.done, true); assert.equal(e.requests.length, 2);
});
test('Quota error stops at failed row and releases lock for retry', () => {
  const e = env(undefined, { status: 'OVER_QUERY_LIMIT' }); const r = e.c.addressFillBatch(2);
  assert.match(r.error, /OVER_QUERY_LIMIT/); assert.equal(r.nextRow, 2); assert.equal(r.done, false);
  assert.doesNotThrow(() => e.c.addressFillBatch(2));
});
test('ZERO_RESULTS and partial results not retried forever', () => {
  for (const response of [{status:'ZERO_RESULTS'},result(component('日本','country','JP'))]) {
    const e = env(undefined, response); e.c.addressFillBatch(2); e.c.addressFillBatch(2); assert.equal(e.requests.length, 1);
  }
});
test('Auto run stores cursor; status and blank rows are handled', () => {
  const e = env([['sample_id','lat','lon'],['','',''],['a',35,139]]);
  assert.equal(e.c.addressGetStatus().pending, 1); e.c.addressAutoRun(); assert.equal(e.c.addressGetStatus().pending, 0);
});
