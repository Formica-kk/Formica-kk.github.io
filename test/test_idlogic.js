/**
 * test_idlogic.js
 * Node.js の assert のみで動く簡易テスト（外部依存なし）。
 * 実行: node test/test_idlogic.js
 */
const assert = require('assert');
const {
  dateToIdPrefix,
  computeNextSeq,
  padSeq,
  buildSuffix,
  formatSampleId,
  todayLocalDateStr,
} = require('../idlogic.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

test('dateToIdPrefix converts hyphenated date', () => {
  assert.strictEqual(dateToIdPrefix('2026-08-25'), '20260825');
});

test('dateToIdPrefix rejects malformed date', () => {
  assert.throws(() => dateToIdPrefix('20260825'));
  assert.throws(() => dateToIdPrefix('2026/08/25'));
});

test('computeNextSeq returns 1 when no records for the day', () => {
  const records = [{ collection_date: '2026-08-24', seq: 5 }];
  assert.strictEqual(computeNextSeq(records, '2026-08-25'), 1);
});

test('computeNextSeq returns max+1 ignoring other days', () => {
  const records = [
    { collection_date: '2026-08-25', seq: 1 },
    { collection_date: '2026-08-25', seq: 2 },
    { collection_date: '2026-08-24', seq: 99 }, // different day, must be ignored
  ];
  assert.strictEqual(computeNextSeq(records, '2026-08-25'), 3);
});

test('computeNextSeq is robust to out-of-order / gapped seqs (deleted record)', () => {
  // e.g. record #2 was deleted by the user; next should still be max+1, not fill the gap
  const records = [
    { collection_date: '2026-08-25', seq: 1 },
    { collection_date: '2026-08-25', seq: 3 },
  ];
  assert.strictEqual(computeNextSeq(records, '2026-08-25'), 4);
});

test('padSeq zero-pads to 2 digits by default', () => {
  assert.strictEqual(padSeq(1), '01');
  assert.strictEqual(padSeq(9), '09');
  assert.strictEqual(padSeq(10), '10');
});

test('padSeq does not truncate when seq exceeds 99 (no data loss)', () => {
  assert.strictEqual(padSeq(100), '100');
  assert.strictEqual(padSeq(999), '999');
});

test('buildSuffix returns empty string when no tags selected', () => {
  const tagDefs = [{ key: 'colony', suffix: 'C', order: 1 }];
  assert.strictEqual(buildSuffix([], tagDefs), '');
  assert.strictEqual(buildSuffix(undefined, tagDefs), '');
});

test('buildSuffix concatenates in tagDefs order regardless of selection order', () => {
  const tagDefs = [
    { key: 'colony', suffix: 'C', order: 1 },
    { key: 'queen', suffix: 'Q', order: 2 },
  ];
  // selection order reversed on purpose
  assert.strictEqual(buildSuffix(['queen', 'colony'], tagDefs), 'CQ');
});

test('buildSuffix ignores unknown keys gracefully', () => {
  const tagDefs = [{ key: 'colony', suffix: 'C', order: 1 }];
  assert.strictEqual(buildSuffix(['colony', 'nonexistent'], tagDefs), 'C');
});

test('formatSampleId builds full ID with tag suffix', () => {
  const tagDefs = [{ key: 'colony', suffix: 'C', order: 1 }];
  const id = formatSampleId({ dateStr: '2026-08-25', seq: 1, tagKeys: ['colony'], tagDefs });
  assert.strictEqual(id, '20260825-01C');
});

test('formatSampleId builds full ID without tags', () => {
  const id = formatSampleId({ dateStr: '2026-08-25', seq: 12, tagKeys: [], tagDefs: [] });
  assert.strictEqual(id, '20260825-12');
});

test('formatSampleId handles multiple tags combined', () => {
  const tagDefs = [
    { key: 'colony', suffix: 'C', order: 1 },
    { key: 'queen', suffix: 'Q', order: 2 },
  ];
  const id = formatSampleId({ dateStr: '2026-08-25', seq: 3, tagKeys: ['colony', 'queen'], tagDefs });
  assert.strictEqual(id, '20260825-03CQ');
});

test('formatSampleId handles seq beyond 99 without truncation', () => {
  const id = formatSampleId({ dateStr: '2026-08-25', seq: 100, tagKeys: [], tagDefs: [] });
  assert.strictEqual(id, '20260825-100');
});

test('todayLocalDateStr formats a given Date correctly', () => {
  const d = new Date(2026, 7, 25); // month is 0-indexed: 7 = August
  assert.strictEqual(todayLocalDateStr(d), '2026-08-25');
});

test('todayLocalDateStr pads single-digit month/day', () => {
  const d = new Date(2026, 0, 5); // Jan 5
  assert.strictEqual(todayLocalDateStr(d), '2026-01-05');
});

console.log(`\n${passed} tests passed.`);
