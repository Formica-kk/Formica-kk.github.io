/**
 * db.js
 * IndexedDB ラッパー。全操作は Promise ベース。
 *
 * DB名: collector-db  (version 1)
 * ストア:
 *   records          - keyPath: 'id' (自動採番のDB内部連番、Number)
 *     フィールド:
 *       id                 : number (autoIncrement, 内部主キー。サンプルIDとは別物)
 *       sample_id          : string  例 "20260825-01C"
 *       collection_date    : string  "YYYY-MM-DD" (ID採番の基準日)
 *       seq                : number  その日の連番 (タグ付与前の素の番号)
 *       tag_keys           : string[] 選択されていたタグキー
 *       lat                : number | null
 *       lon                : number | null
 *       accuracy_m         : number | null  (Geolocation の accuracy)
 *       altitude           : number | null
 *       altitude_accuracy_m: number | null
 *       timestamp_iso      : string  記録した瞬間のISO時刻
 *       note               : string
 *       synced             : boolean
 *       created_at         : string ISO
 *       updated_at         : string ISO
 *     インデックス: by_date (collection_date), by_synced (synced)
 *
 *   tag_definitions  - keyPath: 'key' (string, ユーザー定義の一意キー)
 *     フィールド: key, label, suffix, order, color
 *
 *   settings         - keyPath: 'key' (string)
 *     フィールド: key, value  (単純な key-value ストア。gas_url, date_override 等)
 */
(function (root) {
  const DB_NAME = 'collector-db';
  const DB_VERSION = 1;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains('records')) {
          const store = db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
          store.createIndex('by_date', 'collection_date', { unique: false });
          store.createIndex('by_synced', 'synced', { unique: false });
        }
        if (!db.objectStoreNames.contains('tag_definitions')) {
          db.createObjectStore('tag_definitions', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, storeNames, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      const stores = Array.isArray(storeNames)
        ? storeNames.map(n => t.objectStore(n))
        : t.objectStore(storeNames);
      let result;
      Promise.resolve(fn(stores, t))
        .then(r => { result = r; })
        .catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const DB = {
    _dbPromise: null,

    async db() {
      if (!this._dbPromise) this._dbPromise = openDb();
      return this._dbPromise;
    },

    // ---------- records ----------
    async addRecord(record) {
      const db = await this.db();
      return tx(db, 'records', 'readwrite', (store) => reqToPromise(store.add(record)));
    },

    async updateRecord(record) {
      const db = await this.db();
      return tx(db, 'records', 'readwrite', (store) => reqToPromise(store.put(record)));
    },

    async deleteRecord(id) {
      const db = await this.db();
      return tx(db, 'records', 'readwrite', (store) => reqToPromise(store.delete(id)));
    },

    async getRecord(id) {
      const db = await this.db();
      return tx(db, 'records', 'readonly', (store) => reqToPromise(store.get(id)));
    },

    async getAllRecords() {
      const db = await this.db();
      return tx(db, 'records', 'readonly', (store) => reqToPromise(store.getAll()));
    },

    async getRecordsByDate(dateStr) {
      const db = await this.db();
      return tx(db, 'records', 'readonly', (store) => {
        const idx = store.index('by_date');
        return reqToPromise(idx.getAll(IDBKeyRange.only(dateStr)));
      });
    },

    async getUnsyncedRecords() {
      const all = await this.getAllRecords();
      return all.filter(r => !r.synced);
    },

    async getLastRecord() {
      const all = await this.getAllRecords();
      if (all.length === 0) return null;
      return all.reduce((a, b) => (a.id > b.id ? a : b));
    },

    // ---------- tag_definitions ----------
    async getAllTagDefs() {
      const db = await this.db();
      const defs = await tx(db, 'tag_definitions', 'readonly', (store) => reqToPromise(store.getAll()));
      return defs.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },

    async putTagDef(def) {
      const db = await this.db();
      return tx(db, 'tag_definitions', 'readwrite', (store) => reqToPromise(store.put(def)));
    },

    async deleteTagDef(key) {
      const db = await this.db();
      return tx(db, 'tag_definitions', 'readwrite', (store) => reqToPromise(store.delete(key)));
    },

    async ensureDefaultTagDefs() {
      const existing = await this.getAllTagDefs();
      if (existing.length > 0) return existing;
      const defaults = [
        { key: 'colony', label: 'コロニー', suffix: 'C', order: 1 },
      ];
      for (const d of defaults) await this.putTagDef(d);
      return defaults;
    },

    // ---------- settings ----------
    async getSetting(key, fallback = null) {
      const db = await this.db();
      const row = await tx(db, 'settings', 'readonly', (store) => reqToPromise(store.get(key)));
      return row ? row.value : fallback;
    },

    async setSetting(key, value) {
      const db = await this.db();
      return tx(db, 'settings', 'readwrite', (store) => reqToPromise(store.put({ key, value })));
    },
  };

  root.DB = DB;
})(typeof self !== 'undefined' ? self : this);
