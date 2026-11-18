/**
 * sync.js
 * オンライン復帰時 / 手動操作時に、未同期レコード(synced=false)を
 * Google Apps Script のウェブアプリへ順次POSTする。
 * 成功したレコードのみ synced=true に更新する（部分失敗を許容）。
 */
(function (root) {
  const Sync = {
    _running: false,

    async getGasUrl() {
      return await root.DB.getSetting('gas_url', '');
    },

    async syncAll(onProgress) {
      if (this._running) return { skipped: true, reason: 'already running' };
      this._running = true;
      let sent = 0, failed = 0;
      try {
      const gasUrl = await this.getGasUrl();
      if (!gasUrl) return { ok: false, reason: 'no_url', sent: 0, failed: 0 };
      if (!navigator.onLine) return { ok: false, reason: 'offline', sent: 0, failed: 0 };

        const pending = await root.DB.getUnsyncedRecords();
        for (const record of pending) {
          try {
            const ok = await this._postOne(gasUrl, record);
            if (ok) {
              await root.DB.markSyncedIfUnchanged(record);
              sent++;
            } else {
              failed++;
            }
          } catch (e) {
            failed++;
          }
          if (onProgress) onProgress({ sent, failed, total: pending.length });
        }
      } finally {
        this._running = false;
      }
      return { ok: true, sent, failed };
    },

    async _postOne(gasUrl, record) {
      // GAS の doPost は text/plain として受け取り JSON.parse する運用が
      // 一番トラブルが少ない（CORSのプリフライトを避けるため）。
      const payload = {
        sample_id: record.sample_id,
        collection_date: record.collection_date,
        seq: record.seq,
        tag_keys: (record.tag_keys || []).join(','),
        lat: record.lat,
        lon: record.lon,
        accuracy_m: record.accuracy_m,
        altitude: record.altitude,
        altitude_accuracy_m: record.altitude_accuracy_m,
        timestamp_iso: record.timestamp_iso,
        note: record.note || '',
      };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
      const res = await fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      return !!(data && data.status === 'ok');
      } finally { clearTimeout(timeout); }
    },
  };

  root.Sync = Sync;
})(typeof self !== 'undefined' ? self : this);
