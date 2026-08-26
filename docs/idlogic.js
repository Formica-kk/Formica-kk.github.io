/**
 * idlogic.js
 * サンプルID採番・整形ロジック（純粋関数のみ・DB非依存）
 * ブラウザでは <script src="idlogic.js"></script> でグローバルに公開し、
 * Node.js のテストでは module.exports 経由で読み込む（UMD風の最小実装）。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.IdLogic = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * 日付文字列 "YYYY-MM-DD" を ID 用の "YYYYMMDD" に変換する。
   */
  function dateToIdPrefix(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error(`Invalid date string: ${dateStr}. Expected YYYY-MM-DD.`);
    }
    return dateStr.replace(/-/g, '');
  }

  /**
   * 指定した採集日 (dateStr, "YYYY-MM-DD") について、既存レコード群から
   * 次に使うべき連番 (1始まり) を計算する。
   * records: [{ collection_date: "YYYY-MM-DD", seq: number, ... }, ...]
   */
  function computeNextSeq(records, dateStr) {
    const sameDay = records.filter(r => r.collection_date === dateStr);
    if (sameDay.length === 0) return 1;
    const maxSeq = sameDay.reduce((m, r) => Math.max(m, r.seq || 0), 0);
    return maxSeq + 1;
  }

  /**
   * 連番を ID 表記用にゼロ埋めする。通常は2桁だが、99を超えたら桁を増やす
   * （情報を絶対に失わない。3桁目以降が発生しても切り捨てない）。
   */
  function padSeq(seq, minDigits = 2) {
    const s = String(seq);
    return s.length >= minDigits ? s : s.padStart(minDigits, '0');
  }

  /**
   * 選択中のタグキー配列を tag_definitions の並び順に正規化してから
   * suffix を連結する。呼び出し側のタップ順に依存させず、常に同じ順序で
   * 同じIDになるようにするため。
   * tagDefs: [{ key, suffix, order }, ...]
   * selectedKeys: string[]  (順不同でよい)
   */
  function buildSuffix(selectedKeys, tagDefs) {
    if (!selectedKeys || selectedKeys.length === 0) return '';
    const ordered = tagDefs
      .filter(t => selectedKeys.includes(t.key))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return ordered.map(t => t.suffix).join('');
  }

  /**
   * サンプルIDを組み立てる。
   * 例: date=2026-08-25, seq=1, tags=['colony'] (suffix 'C')
   *     -> "20260825-01C"
   */
  function formatSampleId({ dateStr, seq, tagKeys = [], tagDefs = [] }) {
    const prefix = dateToIdPrefix(dateStr);
    const seqStr = padSeq(seq);
    const suffix = buildSuffix(tagKeys, tagDefs);
    return `${prefix}-${seqStr}${suffix}`;
  }

  /**
   * 今日の日付を "YYYY-MM-DD" 形式（端末ローカルタイム基準）で返す。
   * 深夜またぎ対策として、呼び出し側は settings.collection_date_override が
   * あればそちらを優先して使うこと（このモジュールは関与しない）。
   */
  function todayLocalDateStr(now = new Date()) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return {
    dateToIdPrefix,
    computeNextSeq,
    padSeq,
    buildSuffix,
    formatSampleId,
    todayLocalDateStr,
  };
});
