// Local-first IndexedDB persistence for CloudDrop
// Stores: events (append-only CRDT ops), blobs (file cache), outbox (pending cloud uploads), kv (cursors/meta)

const DB_NAME = 'clouddrop_v1';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('events')) {
        const s = db.createObjectStore('events', { keyPath: 'opId' });
        s.createIndex('createdAt', 'createdAt', { unique: false });
        s.createIndex('targetId', 'targetId', { unique: false });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'fileId' });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        const o = db.createObjectStore('outbox', { keyPath: 'id' });
        o.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function runTx(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
        tx.onerror = () => reject(tx.error);
      })
  );
}

export const db = {
  // Events
  async putEvent(ev) {
    return runTx('events', 'readwrite', (s) => s.put(ev));
  },
  async putEvents(list) {
    if (!list || !list.length) return;
    return runTx('events', 'readwrite', (s) => {
      for (const ev of list) s.put(ev);
    });
  },
  async getAllEvents() {
    return runTx('events', 'readonly', (s) => s.getAll());
  },
  async hasEvent(opId) {
    const found = await runTx('events', 'readonly', (s) => s.get(opId));
    return Boolean(found);
  },
  async clearEvents() {
    return runTx('events', 'readwrite', (s) => s.clear());
  },

  // Blobs (local cache of uploaded/downloaded files)
  async putBlob(fileId, blob, meta = {}) {
    return runTx('blobs', 'readwrite', (s) =>
      s.put({ fileId, blob, mimeType: blob.type || meta.mimeType || 'application/octet-stream', size: blob.size, savedAt: Date.now() })
    );
  },
  async getBlob(fileId) {
    const rec = await runTx('blobs', 'readonly', (s) => s.get(fileId));
    return rec ? rec.blob : null;
  },
  async deleteBlob(fileId) {
    return runTx('blobs', 'readwrite', (s) => s.delete(fileId));
  },
  async clearBlobs() {
    return runTx('blobs', 'readwrite', (s) => s.clear());
  },

  // Outbox (pending events waiting to push to remote provider)
  async enqueueOutbox(entry) {
    return runTx('outbox', 'readwrite', (s) => s.put(entry));
  },
  async getAllOutbox() {
    const list = await runTx('outbox', 'readonly', (s) => s.getAll());
    return (list || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  },
  async removeOutbox(id) {
    return runTx('outbox', 'readwrite', (s) => s.delete(id));
  },
  async clearOutbox() {
    return runTx('outbox', 'readwrite', (s) => s.clear());
  },

  // Key-Value
  async getKv(key, fallback = null) {
    const rec = await runTx('kv', 'readonly', (s) => s.get(key));
    return rec ? rec.value : fallback;
  },
  async setKv(key, value) {
    return runTx('kv', 'readwrite', (s) => s.put({ key, value }));
  },
  async deleteKv(key) {
    return runTx('kv', 'readwrite', (s) => s.delete(key));
  }
};
