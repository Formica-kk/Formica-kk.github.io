/**
 * app.js
 * 画面制御・GPS取得・記録/一覧/設定のイベントハンドラをまとめる。
 */
(function () {
  'use strict';

  // ---------------- 状態 ----------------
  let currentPosition = null; // { lat, lon, accuracy_m, altitude, altitude_accuracy_m, updated_at }
  let watchId = null;
  let selectedTagKeys = new Set();
  let tagDefs = [];
  let lastRecordId = null; // undo用
  let editingRecordId = null;

  // ---------------- 共通ユーティリティ ----------------
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

  function toast(msg, ms = 2200) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  function vibrate(pattern) {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  async function getEffectiveDateStr() {
    const overrideEnabled = await DB.getSetting('date_override_enabled', false);
    if (overrideEnabled) {
      const val = await DB.getSetting('date_override_value', null);
      if (val) return val;
    }
    return IdLogic.todayLocalDateStr();
  }

  // ---------------- タブ切り替え ----------------
  function initTabs() {
    $all('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $all('.tab-btn').forEach(b => b.classList.remove('active'));
        $all('.view').forEach(v => v.classList.remove('active'));
        btn.classList.add('active');
        $('#' + btn.dataset.view).classList.add('active');
        if (btn.dataset.view === 'listView') refreshListView();
        if (btn.dataset.view === 'settingsView') refreshSettingsView();
        if (btn.dataset.view === 'recordView') refreshNextIdPreview();
      });
    });
  }

  // ---------------- GPS ----------------
  function classifyAccuracy(acc) {
    if (acc == null) return { cls: '', label: '--' };
    if (acc <= 10) return { cls: 'good', label: `±${acc.toFixed(0)}m (良好)` };
    if (acc <= 30) return { cls: 'fair', label: `±${acc.toFixed(0)}m (普通)` };
    return { cls: 'poor', label: `±${acc.toFixed(0)}m (低精度)` };
  }

  function renderGps() {
    const accEl = $('#gpsAccuracy');
    const badgeEl = $('#gpsBadge');
    const latEl = $('#gpsLat');
    const lonEl = $('#gpsLon');
    const altEl = $('#gpsAlt');
    const updEl = $('#gpsUpdated');

    if (!currentPosition) {
      accEl.textContent = '取得中…';
      badgeEl.textContent = '--';
      badgeEl.className = 'gps-badge';
      latEl.textContent = '--';
      lonEl.textContent = '--';
      altEl.textContent = '--';
      updEl.textContent = '最終更新: --';
      return;
    }
    const { cls, label } = classifyAccuracy(currentPosition.accuracy_m);
    accEl.textContent = label;
    badgeEl.textContent = cls === 'good' ? '良好' : cls === 'fair' ? '普通' : cls === 'poor' ? '低精度' : '--';
    badgeEl.className = 'gps-badge ' + cls;
    latEl.textContent = currentPosition.lat.toFixed(6);
    lonEl.textContent = currentPosition.lon.toFixed(6);
    altEl.textContent = currentPosition.altitude != null
      ? `${currentPosition.altitude.toFixed(1)} m (誤差±${(currentPosition.altitude_accuracy_m ?? 0).toFixed(0)}m)`
      : '取得不可';
    const secondsAgo = Math.round((Date.now() - currentPosition.updated_at) / 1000);
    updEl.textContent = `最終更新: ${secondsAgo}秒前`;
  }

  function startGpsWatch() {
    if (!('geolocation' in navigator)) {
      toast('この端末では位置情報が利用できません');
      return;
    }
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        currentPosition = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy,
          altitude: pos.coords.altitude,
          altitude_accuracy_m: pos.coords.altitudeAccuracy,
          updated_at: Date.now(),
        };
        renderGps();
      },
      (err) => {
        console.warn('geolocation error', err);
        toast('GPS取得エラー: ' + err.message);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
    // 経過表示を更新するための定期tick（何秒前かの表示のみ更新）
    setInterval(renderGps, 1000);
  }

  function stopGpsWatch() {
    if (watchId != null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  // ---------------- タグパネル ----------------
  async function loadTagDefs() {
    tagDefs = await DB.ensureDefaultTagDefs();
    tagDefs = await DB.getAllTagDefs();
  }

  function renderRecordTagPanelClean() {
    const container = $('#tagPanel');
    container.innerHTML = '';
    tagDefs.forEach(def => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag-toggle' + (selectedTagKeys.has(def.key) ? ' on' : '');
      btn.textContent = `${def.label} (${def.suffix})`;
      btn.addEventListener('click', () => {
        if (selectedTagKeys.has(def.key)) selectedTagKeys.delete(def.key);
        else selectedTagKeys.add(def.key);
        renderRecordTagPanelClean();
        refreshNextIdPreview();
      });
      container.appendChild(btn);
    });
  }

  // ---------------- ID プレビュー ----------------
  async function refreshNextIdPreview() {
    const dateStr = await getEffectiveDateStr();
    const records = await DB.getAllRecords();
    const seq = IdLogic.computeNextSeq(records, dateStr);
    const id = IdLogic.formatSampleId({ dateStr, seq, tagKeys: Array.from(selectedTagKeys), tagDefs });
    $('#nextIdPreview').textContent = id;
    return { dateStr, seq };
  }

  // ---------------- 記録 ----------------
  async function doRecord() {
    if (!currentPosition) {
      toast('GPS取得中です。少し待ってから押してください');
      return;
    }
    const dateStr = await getEffectiveDateStr();
    const records = await DB.getAllRecords();
    const seq = IdLogic.computeNextSeq(records, dateStr);
    const sampleId = IdLogic.formatSampleId({ dateStr, seq, tagKeys: Array.from(selectedTagKeys), tagDefs });
    const nowIso = new Date().toISOString();

    const record = {
      sample_id: sampleId,
      collection_date: dateStr,
      seq,
      tag_keys: Array.from(selectedTagKeys),
      lat: currentPosition.lat,
      lon: currentPosition.lon,
      accuracy_m: currentPosition.accuracy_m,
      altitude: currentPosition.altitude,
      altitude_accuracy_m: currentPosition.altitude_accuracy_m,
      timestamp_iso: nowIso,
      note: $('#noteInput').value.trim(),
      synced: false,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const newId = await DB.addRecord(record);
    lastRecordId = newId;
    vibrate(80);
    toast(`記録しました: ${sampleId}`);
    $('#noteInput').value = '';
    $('#lastRecordInfo').textContent = `直前の記録: ${sampleId}`;
    $('#undoBtn').disabled = false;
    await refreshNextIdPreview();
    maybeSyncInBackground();
  }

  async function doUndo() {
    if (lastRecordId == null) {
      toast('取り消せる記録がありません');
      return;
    }
    const rec = await DB.getRecord(lastRecordId);
    if (!rec) {
      toast('対象の記録が見つかりません（既に編集・削除された可能性があります）');
      lastRecordId = null;
      $('#undoBtn').disabled = true;
      return;
    }
    await DB.deleteRecord(lastRecordId);
    toast(`取り消しました: ${rec.sample_id}`);
    lastRecordId = null;
    $('#undoBtn').disabled = true;
    $('#lastRecordInfo').textContent = 'まだ今日の記録はありません';
    await refreshNextIdPreview();
  }

  async function refreshLastRecordLabel() {
    const last = await DB.getLastRecord();
    if (last) {
      $('#lastRecordInfo').textContent = `直前の記録: ${last.sample_id}`;
      lastRecordId = last.id;
      $('#undoBtn').disabled = false;
    }
  }

  // ---------------- ネットワーク状態 / 同期 ----------------
  function renderNetStatus() {
    const el = $('#netStatus');
    if (navigator.onLine) {
      el.textContent = 'オンライン';
      el.className = 'net-status online';
    } else {
      el.textContent = 'オフライン';
      el.className = 'net-status offline';
    }
  }

  async function maybeSyncInBackground() {
    if (!navigator.onLine) return;
    const gasUrl = await Sync.getGasUrl();
    if (!gasUrl) return;
    Sync.syncAll().then(res => {
      if (res.ok && (res.sent > 0 || res.failed > 0)) {
        console.log('background sync', res);
      }
    });
  }

  window.addEventListener('online', () => {
    renderNetStatus();
    toast('オンラインになりました。同期します…');
    maybeSyncInBackground();
  });
  window.addEventListener('offline', renderNetStatus);

  // ---------------- 一覧画面 ----------------
  async function refreshListView() {
    const dateFilter = $('#listDateFilter').value;
    const all = dateFilter ? await DB.getRecordsByDate(dateFilter) : await DB.getAllRecords();
    all.sort((a, b) => b.id - a.id);
    const ul = $('#recordList');
    ul.innerHTML = '';
    if (all.length === 0) {
      ul.innerHTML = '<li style="text-align:center;color:#999;">記録がありません</li>';
    }
    for (const r of all) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="sync-flag ${r.synced ? 'synced' : 'pending'}">${r.synced ? '同期済' : '未同期'}</span>
        <div class="rid">${escapeHtml(r.sample_id)}</div>
        <div class="rmeta">${r.timestamp_iso ? new Date(r.timestamp_iso).toLocaleString('ja-JP') : ''} ・
          ${r.lat != null ? r.lat.toFixed(5) : '?'}, ${r.lon != null ? r.lon.toFixed(5) : '?'}
          ${r.accuracy_m != null ? `(±${r.accuracy_m.toFixed(0)}m)` : ''}
        </div>
        ${r.note ? `<div class="rnote">${escapeHtml(r.note)}</div>` : ''}
      `;
      li.addEventListener('click', () => openEditModal(r.id));
      ul.appendChild(li);
    }
    const pendingCount = (await DB.getUnsyncedRecords()).length;
    $('#syncStatusLine').textContent = `未同期: ${pendingCount}件`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function openEditModal(id) {
    const rec = await DB.getRecord(id);
    if (!rec) return;
    editingRecordId = id;
    $('#editId').value = rec.sample_id;
    $('#editDate').value = rec.collection_date;
    $('#editLat').value = rec.lat ?? '';
    $('#editLon').value = rec.lon ?? '';
    $('#editAlt').value = rec.altitude ?? '';
    $('#editNote').value = rec.note ?? '';
    const editSelected = new Set(rec.tag_keys || []);
    renderEditTagPanel(editSelected);
    $('#editMeta').textContent =
      `内部ID: ${rec.id} / 作成: ${new Date(rec.created_at).toLocaleString('ja-JP')} / ` +
      `更新: ${new Date(rec.updated_at).toLocaleString('ja-JP')} / ${rec.synced ? '同期済み' : '未同期'}`;
    $('#editModal').dataset.tagSelection = JSON.stringify(Array.from(editSelected));
    $('#editModal').classList.remove('hidden');
  }

  function renderEditTagPanel(selectedSet) {
    const container = $('#editTagPanel');
    container.innerHTML = '';
    tagDefs.forEach(def => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag-toggle' + (selectedSet.has(def.key) ? ' on' : '');
      btn.textContent = `${def.label} (${def.suffix})`;
      btn.addEventListener('click', () => {
        if (selectedSet.has(def.key)) selectedSet.delete(def.key);
        else selectedSet.add(def.key);
        renderEditTagPanel(selectedSet);
        $('#editModal').dataset.tagSelection = JSON.stringify(Array.from(selectedSet));
      });
      container.appendChild(btn);
    });
  }

  function closeEditModal() {
    $('#editModal').classList.add('hidden');
    editingRecordId = null;
  }

  async function saveEditModal() {
    if (editingRecordId == null) return;
    const rec = await DB.getRecord(editingRecordId);
    if (!rec) return;
    rec.sample_id = $('#editId').value.trim();
    rec.collection_date = $('#editDate').value;
    rec.lat = $('#editLat').value === '' ? null : parseFloat($('#editLat').value);
    rec.lon = $('#editLon').value === '' ? null : parseFloat($('#editLon').value);
    rec.altitude = $('#editAlt').value === '' ? null : parseFloat($('#editAlt').value);
    rec.note = $('#editNote').value;
    rec.tag_keys = JSON.parse($('#editModal').dataset.tagSelection || '[]');
    rec.updated_at = new Date().toISOString();
    // 手動編集されたレコードは、再同期して整合を取るため未同期に戻す
    rec.synced = false;
    await DB.updateRecord(rec);
    toast('保存しました');
    closeEditModal();
    refreshListView();
  }

  async function deleteEditModal() {
    if (editingRecordId == null) return;
    if (!confirm('この記録を削除しますか？')) return;
    await DB.deleteRecord(editingRecordId);
    toast('削除しました');
    closeEditModal();
    refreshListView();
  }

  // ---------------- CSV / JSON エクスポート ----------------
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function toCsv(records) {
    const cols = ['sample_id', 'collection_date', 'seq', 'tag_keys', 'lat', 'lon', 'accuracy_m',
      'altitude', 'altitude_accuracy_m', 'timestamp_iso', 'note', 'synced', 'created_at', 'updated_at'];
    const lines = [cols.join(',')];
    for (const r of records) {
      const row = cols.map(c => {
        let v = r[c];
        if (Array.isArray(v)) v = v.join('|');
        if (v == null) v = '';
        v = String(v).replace(/"/g, '""');
        if (/[",\n]/.test(v)) v = `"${v}"`;
        return v;
      });
      lines.push(row.join(','));
    }
    return lines.join('\n');
  }

  async function exportCsv() {
    const all = await DB.getAllRecords();
    all.sort((a, b) => a.id - b.id);
    const csv = toCsv(all);
    const ts = new Date().toISOString().slice(0, 10);
    download(`collector_records_${ts}.csv`, '\uFEFF' + csv, 'text/csv;charset=utf-8');
  }

  async function exportAllJson() {
    const records = await DB.getAllRecords();
    const defs = await DB.getAllTagDefs();
    const dump = { exported_at: new Date().toISOString(), records, tag_definitions: defs };
    const ts = new Date().toISOString().slice(0, 10);
    download(`collector_backup_${ts}.json`, JSON.stringify(dump, null, 2), 'application/json');
  }

  async function importJson(file) {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      toast('JSONの解析に失敗しました');
      return;
    }
    if (!data.records) {
      toast('records が見つかりません');
      return;
    }
    let imported = 0;
    for (const r of data.records) {
      const clone = Object.assign({}, r);
      delete clone.id; // 内部主キーは再採番させる（重複防止）
      await DB.addRecord(clone);
      imported++;
    }
    if (data.tag_definitions) {
      for (const d of data.tag_definitions) await DB.putTagDef(d);
      await loadTagDefs();
    }
    toast(`${imported}件インポートしました`);
    refreshListView();
  }

  // ---------------- 設定画面 ----------------
  async function refreshSettingsView() {
    const overrideEnabled = await DB.getSetting('date_override_enabled', false);
    const overrideValue = await DB.getSetting('date_override_value', '');
    $('#dateOverrideEnabled').checked = !!overrideEnabled;
    $('#dateOverrideValue').disabled = !overrideEnabled;
    $('#dateOverrideValue').value = overrideValue || '';

    const gasUrl = await Sync.getGasUrl();
    $('#gasUrlInput').value = gasUrl || '';

    renderTagDefList();
  }

  function renderTagDefList() {
    const ul = $('#tagDefList');
    ul.innerHTML = '';
    tagDefs.forEach(def => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(def.label)} → 末尾「${escapeHtml(def.suffix)}」 (key: ${escapeHtml(def.key)})</span>`;
      const delBtn = document.createElement('button');
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`タグ「${def.label}」を削除しますか？`)) return;
        await DB.deleteTagDef(def.key);
        await loadTagDefs();
        renderTagDefList();
        renderRecordTagPanelClean();
      });
      li.appendChild(delBtn);
      ul.appendChild(li);
    });
  }

  // ---------------- 初期化 ----------------
  async function init() {
    initTabs();
    renderNetStatus();
    renderGps();
    startGpsWatch();

    await loadTagDefs();
    renderRecordTagPanelClean();
    await refreshNextIdPreview();
    await refreshLastRecordLabel();

    $('#recordBtn').addEventListener('click', doRecord);
    $('#undoBtn').addEventListener('click', doUndo);

    $('#listDateFilter').addEventListener('change', refreshListView);
    $('#clearFilterBtn').addEventListener('click', () => { $('#listDateFilter').value = ''; refreshListView(); });
    $('#exportCsvBtn').addEventListener('click', exportCsv);
    $('#syncNowBtn').addEventListener('click', async () => {
      const res = await Sync.syncAll();
      if (res.reason === 'no_url') toast('設定画面でGASのURLを登録してください');
      else if (res.reason === 'offline') toast('オフラインです');
      else toast(`同期完了: 成功${res.sent}件 / 失敗${res.failed}件`);
      refreshListView();
    });

    $('#editSaveBtn').addEventListener('click', saveEditModal);
    $('#editDeleteBtn').addEventListener('click', deleteEditModal);
    $('#editCancelBtn').addEventListener('click', closeEditModal);

    $('#dateOverrideEnabled').addEventListener('change', async (e) => {
      await DB.setSetting('date_override_enabled', e.target.checked);
      $('#dateOverrideValue').disabled = !e.target.checked;
      refreshNextIdPreview();
    });
    $('#dateOverrideValue').addEventListener('change', async (e) => {
      await DB.setSetting('date_override_value', e.target.value);
      refreshNextIdPreview();
    });

    $('#addTagBtn').addEventListener('click', async () => {
      const label = $('#newTagLabel').value.trim();
      const key = $('#newTagKey').value.trim();
      const suffix = $('#newTagSuffix').value.trim();
      if (!label || !key || !suffix) { toast('表示名・キー・サフィックスを全て入力してください'); return; }
      if (tagDefs.some(t => t.key === key)) { toast('そのキーは既に使われています'); return; }
      const order = tagDefs.length + 1;
      await DB.putTagDef({ key, label, suffix, order });
      await loadTagDefs();
      renderTagDefList();
      renderRecordTagPanelClean();
      $('#newTagLabel').value = '';
      $('#newTagKey').value = '';
      $('#newTagSuffix').value = '';
      toast('タグを追加しました');
    });

    $('#saveGasUrlBtn').addEventListener('click', async () => {
      await DB.setSetting('gas_url', $('#gasUrlInput').value.trim());
      toast('保存しました');
    });

    $('#exportAllJsonBtn').addEventListener('click', exportAllJson);
    $('#importJsonBtn').addEventListener('click', () => $('#importJsonFile').click());
    $('#importJsonFile').addEventListener('change', (e) => {
      if (e.target.files[0]) importJson(e.target.files[0]);
      e.target.value = '';
    });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(err => console.warn('SW registration failed', err));
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
