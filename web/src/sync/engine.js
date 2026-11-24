// Conflict-Free Append-Only Sync Coordinator
// Coordinates IndexedDB local store, E2EE encryption, Outbox push, Remote pull, and Blob transfers

import { db } from '../state/db.js';
import { makeId, store } from '../state/store.js';
import {
  bytesToBase64,
  createCanary,
  decryptBlob,
  decryptJson,
  deriveKey,
  encryptBlob,
  encryptJson,
  generateSaltBase64,
  verifyCanary
} from '../crypto/e2ee.js';
import { sanitizeFileName } from '../providers/base.js';
import { LocalProvider } from '../providers/local.js';
import { GoogleDriveProvider } from '../providers/gdrive.js';
import { OneDriveProvider } from '../providers/onedrive.js';
import { extractTags } from '../ui/markdown.js';
import { appLog } from '../ui/logger.js';

export class SyncEngine {
  constructor() {
    this.providers = {
      local: new LocalProvider(),
      gdrive: new GoogleDriveProvider(),
      onedrive: new OneDriveProvider()
    };
    this.e2eeKey = null;
    this.e2eeSalt = null;
    this.syncing = false;
    this.syncStartedAt = 0;
    this.pollTimer = null;
    this.seenRemoteNames = new Set();
    this.blobUrlCache = new Map(); // fileId -> objectURL
    this.inflightBlobs = new Map(); // fileId -> Promise<Blob>
  }

  getActiveProvider() {
    const id = store.settings.provider || 'local';
    return this.providers[id] || this.providers.local;
  }

  async init() {
    // 1. Hydrate local IndexedDB + probe desktop companion in parallel (<20ms)
    //    so existing messages render immediately and never turn blank during OAuth callbacks!
    const [salt, , lanOk] = await Promise.all([
      db.getKv('e2ee_salt', null),
      this.reloadFromDb(),
      this.providers.local.probeServer()
    ]);
    this.e2eeSalt = salt;
    store.setSyncState({ lanAvailable: lanOk });
    this._refreshSyncBanner();

    // 3. Complete any OAuth redirect callbacks (Google Drive / OneDrive)
    const gdriveCb = this.providers.gdrive.handleRedirectCallback();
    let onedriveCb = false;
    try {
      onedriveCb = await this.providers.onedrive.handleRedirectCallback();
    } catch (err) {
      appLog.error('Auth', `OneDrive 回调失败: ${err?.message || err}`);
      store.setSyncState({ status: 'error', errorMessage: err.message });
    }

    if (gdriveCb) store.updateSettings({ provider: 'gdrive' });
    if (onedriveCb) store.updateSettings({ provider: 'onedrive' });

    appLog.info('Init', `启动完成 | 后端=${store.settings.provider} | 本地伴侣=${lanOk ? '在线' : '离线'} | 平台=${store.settings.platform}`);
    this._refreshSyncBanner();

    // 4. Kick off initial sync if connected (with one automatic retry on cold-start network hiccup)
    const provider = this.getActiveProvider();
    if (provider.isConnected()) {
      this.syncNow({ silent: true }).then((res) => {
        if (res && !res.ok && res.reason !== 'not_connected') {
          setTimeout(() => {
            if (navigator.onLine && this.getActiveProvider().isConnected()) {
              appLog.info('Init', '启动首次同步受网络波动影响，正在自动重试...');
              this.syncNow({ silent: true });
            }
          }, 3500);
        }
      });
    }

    this.restartAutoPoll();

    window.addEventListener('online', () => {
      if (this.getActiveProvider().isConnected()) this.syncNow({ silent: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.getActiveProvider().isConnected()) {
        this.syncNow({ silent: true });
      }
    });
  }

  restartAutoPoll() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    const sec = Number(store.settings.autoSyncSec || 0);
    if (sec >= 5) {
      this.pollTimer = setInterval(() => {
        if (!document.hidden && navigator.onLine && this.getActiveProvider().isConnected()) {
          this.syncNow({ silent: true });
        }
      }, sec * 1000);
    }
  }

  async reloadFromDb() {
    const [events, outbox] = await Promise.all([db.getAllEvents(), db.getAllOutbox()]);
    const pendingIds = new Set(outbox.map((o) => o.opId));
    for (const ev of events) {
      if (ev.remoteFileName) this.seenRemoteNames.add(ev.remoteFileName);
    }
    store.setEvents(events, pendingIds);
  }

  _refreshSyncBanner(extra = {}) {
    const p = this.getActiveProvider();
    const info = p.getAccountInfo();
    let status = 'local';
    if (this.syncing) status = 'syncing';
    else if (extra.errorMessage) status = 'error';
    else if (p.isConnected()) status = 'connected';
    else if (p.id !== 'local') status = 'error';

    store.setSyncState({
      status,
      providerName: info.providerName,
      accountLabel: info.accountLabel,
      ...extra
    });
  }

  async switchProvider(providerId) {
    if (!this.providers[providerId]) return;
    store.updateSettings({ provider: providerId });
    this.seenRemoteNames.clear();
    if (providerId === 'local') {
      await this.providers.local.probeServer();
    }
    this._refreshSyncBanner({ errorMessage: '' });
    if (this.getActiveProvider().isConnected()) {
      await this.syncNow({ silent: true });
    }
  }

  // ---- E2EE Passphrase Management ----

  async enableOrUnlockE2ee(passphrase) {
    if (!passphrase || passphrase.length < 4) {
      throw new Error('加密口令至少需要 4 个字符');
    }
    const provider = this.getActiveProvider();
    let remoteMeta = null;
    if (provider.isConnected()) {
      try {
        remoteMeta = await provider.readMeta();
      } catch {
        remoteMeta = null;
      }
    }

    let salt = remoteMeta?.e2ee?.salt || (await db.getKv('e2ee_salt', null));
    let canary = remoteMeta?.e2ee?.canary || (await db.getKv('e2ee_canary', null));

    if (salt && canary) {
      const key = await deriveKey(passphrase, salt);
      const ok = await verifyCanary(canary, key);
      if (!ok) {
        throw new Error('加密口令不正确，无法解锁云端密文');
      }
      this.e2eeKey = key;
      this.e2eeSalt = salt;
      await db.setKv('e2ee_salt', salt);
      await db.setKv('e2ee_canary', canary);
    } else {
      salt = generateSaltBase64();
      const key = await deriveKey(passphrase, salt);
      canary = await createCanary(key);
      this.e2eeKey = key;
      this.e2eeSalt = salt;
      await db.setKv('e2ee_salt', salt);
      await db.setKv('e2ee_canary', canary);
      if (provider.isConnected()) {
        await provider.writeMeta({
          version: 1,
          updatedAt: Date.now(),
          e2ee: { enabled: true, salt, canary }
        });
      }
    }

    store.e2eeUnlocked = true;
    store.updateSettings({ e2eeEnabled: true });

    // Decrypt any previously stored locked events
    await this._decryptLockedLocalEvents();
    return true;
  }

  disableE2eeSession() {
    this.e2eeKey = null;
    store.e2eeUnlocked = false;
    store.updateSettings({ e2eeEnabled: false });
  }

  async _decryptLockedLocalEvents() {
    if (!this.e2eeKey) return;
    const events = await db.getAllEvents();
    let changed = false;
    for (const ev of events) {
      if (ev.__lockedEnvelope) {
        try {
          const plain = await decryptJson(ev.__lockedEnvelope, this.e2eeKey);
          plain.encrypted = true;
          plain.remoteFileName = ev.remoteFileName;
          await db.putEvent(plain);
          changed = true;
        } catch {
          // leave locked
        }
      }
    }
    if (changed) await this.reloadFromDb();
  }

  // ---- Local Drop Mutations (Optimistic Local-First) ----

  async createDrop({ text = '', files = [] }) {
    const cleanText = String(text || '').trim();
    if (!cleanText && (!files || files.length === 0)) return null;

    const itemId = makeId('drop');
    const opId = makeId('op');
    const now = Date.now();
    const attachments = [];

    for (const file of files || []) {
      const fileId = makeId('file');
      const safeName = sanitizeFileName(file.name || `paste_${now}.bin`);
      const mimeType = file.type || 'application/octet-stream';
      const remoteName = `${fileId}_${safeName}`;
      await db.putBlob(fileId, file, { mimeType });
      attachments.push({
        fileId,
        name: file.name || safeName,
        remoteName,
        remoteId: null,
        mimeType,
        size: file.size || 0,
        encrypted: Boolean(store.settings.e2eeEnabled && this.e2eeKey)
      });
    }

    const ev = {
      opId,
      itemId,
      type: 'create',
      createdAt: now,
      deviceId: store.settings.deviceId,
      deviceName: store.settings.deviceName,
      platform: store.settings.platform,
      encrypted: Boolean(store.settings.e2eeEnabled && this.e2eeKey),
      payload: {
        text: cleanText,
        tags: extractTags(cleanText),
        pinned: false,
        attachments
      }
    };

    const remoteFileName = `${String(now).padStart(14, '0')}_${opId}.json`;
    ev.remoteFileName = remoteFileName;

    await db.putEvent(ev);
    await db.enqueueOutbox({
      id: opId,
      opId,
      remoteFileName,
      createdAt: now,
      event: ev
    });

    await this.reloadFromDb();
    if (this.getActiveProvider().isConnected()) {
      this.syncNow({ silent: true });
    }
    return itemId;
  }

  async patchDrop(targetId, patch) {
    const opId = makeId('op');
    const now = Date.now();
    const ev = {
      opId,
      targetId,
      type: 'patch',
      createdAt: now,
      deviceId: store.settings.deviceId,
      deviceName: store.settings.deviceName,
      platform: store.settings.platform,
      encrypted: Boolean(store.settings.e2eeEnabled && this.e2eeKey),
      payload: patch
    };
    const remoteFileName = `${String(now).padStart(14, '0')}_${opId}.json`;
    ev.remoteFileName = remoteFileName;

    await db.putEvent(ev);
    await db.enqueueOutbox({
      id: opId,
      opId,
      remoteFileName,
      createdAt: now,
      event: ev
    });
    await this.reloadFromDb();
    if (this.getActiveProvider().isConnected()) {
      this.syncNow({ silent: true });
    }
  }

  async deleteDrop(item) {
    const opId = makeId('op');
    const now = Date.now();
    const ev = {
      opId,
      targetId: item.id,
      type: 'delete',
      createdAt: now,
      deviceId: store.settings.deviceId,
      deviceName: store.settings.deviceName,
      platform: store.settings.platform,
      payload: {}
    };
    const remoteFileName = `${String(now).padStart(14, '0')}_${opId}.json`;
    ev.remoteFileName = remoteFileName;

    await db.putEvent(ev);
    await db.enqueueOutbox({
      id: opId,
      opId,
      remoteFileName,
      createdAt: now,
      event: ev
    });

    // Cleanup local cached blobs & best-effort remote blob deletion
    const provider = this.getActiveProvider();
    for (const att of item.attachments || []) {
      await db.deleteBlob(att.fileId);
      const cachedUrl = this.blobUrlCache.get(att.fileId);
      if (cachedUrl) {
        URL.revokeObjectURL(cachedUrl);
        this.blobUrlCache.delete(att.fileId);
      }
      if (att.remoteId && provider.isConnected()) {
        provider.deleteFileBlob(att.remoteId).catch(() => {});
      }
    }

    await this.reloadFromDb();
    if (provider.isConnected()) {
      this.syncNow({ silent: true });
    }
  }

  // ---- Core Bidirectional Sync ----

  async syncNow({ silent = false } = {}) {
    const provider = this.getActiveProvider();
    if (!provider.isConnected()) {
      this._refreshSyncBanner();
      return { ok: false, reason: 'not_connected' };
    }
    if (this.syncing) {
      // Recover automatically if a previous sync somehow wedged >45s
      if (Date.now() - this.syncStartedAt < 45000) {
        return { ok: true, skipped: true };
      }
      appLog.warn('Sync', '检测到上一次同步任务超时未释放，已强制重置同步锁');
    }

    this.syncing = true;
    this.syncStartedAt = Date.now();
    this._refreshSyncBanner({ errorMessage: '' });
    const t0 = performance.now();
    appLog.info('Sync', `开始同步 (${provider.name})`);

    try {
      await provider.ensureWorkspace();

      // Helper: push a single event (and its un-uploaded local blobs) to the active provider
      const pushEventToRemote = async (rawEvent, fileName) => {
        const ev = structuredClone(rawEvent);
        ev.remoteFileName = fileName;
        const atts = ev.payload?.attachments || [];

        for (const att of atts) {
          // If switching providers (e.g. local -> onedrive), local remoteId is not valid on cloud drive
          if (att.remoteId && att.remoteProvider === provider.id) continue;
          const localBlob = await db.getBlob(att.fileId);
          if (!localBlob) continue;

          const shouldEncrypt = Boolean(store.settings.e2eeEnabled && this.e2eeKey);
          const uploadBlob = shouldEncrypt ? await encryptBlob(localBlob, this.e2eeKey) : localBlob;
          const uploadName = shouldEncrypt ? `${att.remoteName}.enc` : att.remoteName;
          att.encrypted = shouldEncrypt;

          store.setTransferProgress(att.fileId, { pct: 2, phase: 'upload' });
          try {
            const uploaded = await provider.uploadFileBlob(
              uploadName,
              uploadBlob,
              shouldEncrypt ? 'application/octet-stream' : att.mimeType,
              (pct) => store.setTransferProgress(att.fileId, { pct, phase: 'upload' })
            );
            att.remoteId = uploaded.remoteId;
            att.remoteProvider = provider.id;
          } finally {
            store.setTransferProgress(att.fileId, null);
          }
        }

        await db.putEvent(ev);
        const wireObj =
          store.settings.e2eeEnabled && this.e2eeKey
            ? await encryptJson(ev, this.e2eeKey)
            : ev;
        await provider.uploadEventJson(fileName, wireObj);
        this.seenRemoteNames.add(fileName);
      };

      // 1. Push local outbox (blobs first, then immutable event JSON)
      const outbox = await db.getAllOutbox();
      const justPushedNames = new Set();
      let pushedCount = 0;
      for (const entry of outbox) {
        await pushEventToRemote(entry.event, entry.remoteFileName);
        justPushedNames.add(entry.remoteFileName);
        await db.removeOutbox(entry.id);
        pushedCount++;
      }

      // 2. Pull remote events unseen locally & backfill any pre-cloud local events missing from this drive
      const { events: remoteFiles } = await provider.listEvents();
      const remoteNameSet = new Set(remoteFiles.map((rf) => rf.name).filter(Boolean));
      const localEvents = await db.getAllEvents();
      const knownOpIds = new Set(localEvents.map((e) => e.opId));
      const knownRemoteNames = new Set(localEvents.map((e) => e.remoteFileName).filter(Boolean));

      // Backfill: if user sent notes in Local mode before connecting OneDrive/Google Drive, push them now
      for (const ev of localEvents) {
        if (!ev || !ev.opId || ev.__lockedEnvelope) continue;
        const fname = ev.remoteFileName || `${String(ev.createdAt || Date.now()).padStart(14, '0')}_${ev.opId}.json`;
        if (!remoteNameSet.has(fname) && !justPushedNames.has(fname)) {
          await pushEventToRemote(ev, fname);
          remoteNameSet.add(fname);
          knownRemoteNames.add(fname);
          pushedCount++;
        }
      }

      const toDownload = remoteFiles.filter(
        (rf) =>
          rf.name &&
          rf.name.endsWith('.json') &&
          !knownRemoteNames.has(rf.name) &&
          !this.seenRemoteNames.has(rf.name)
      );

      const pulled = [];
      let failedDownloads = 0;
      let firstErrMsg = '';
      const CONCURRENCY = 6;
      for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
        const batch = toDownload.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (rf) => {
            try {
              const raw = rf.inlineData || (await provider.downloadEventJson(rf.remoteId, rf.downloadUrl || null));
              if (raw && raw.__e2ee === 1) {
                if (this.e2eeKey) {
                  const plain = await decryptJson(raw, this.e2eeKey);
                  plain.encrypted = true;
                  plain.remoteFileName = rf.name;
                  return plain;
                }
                const fallbackId = `locked_${rf.name}`;
                return {
                  opId: fallbackId,
                  itemId: fallbackId,
                  type: 'create',
                  createdAt: Date.parse(rf.modifiedTime) || Date.now(),
                  deviceId: 'encrypted',
                  deviceName: '端到端加密内容',
                  platform: 'web',
                  encrypted: true,
                  remoteFileName: rf.name,
                  __lockedEnvelope: raw,
                  payload: { text: '🔒 此条内容已端到端加密，请在「设置 → 隐私加密」输入同步口令解锁。', attachments: [] }
                };
              }
              if (raw && raw.opId) {
                raw.remoteFileName = rf.name;
                return raw;
              }
              return null;
            } catch (err) {
              failedDownloads++;
              if (!firstErrMsg) firstErrMsg = err?.message || String(err);
              appLog.error('Sync', `拉取事件 ${rf.name} 失败: ${err?.message || err}`);
              console.warn('[Sync] Failed downloading event', rf.name, err);
              return null;
            }
          })
        );
        for (const ev of results) {
          if (ev && !knownOpIds.has(ev.opId)) {
            pulled.push(ev);
            this.seenRemoteNames.add(ev.remoteFileName);
          }
        }
      }

      if (pulled.length > 0) {
        await db.putEvents(pulled);
      }

      // Refresh quota occasionally
      const quota = await provider.getQuota().catch(() => null);

      await this.reloadFromDb();
      this.syncing = false;
      const ms = Math.round(performance.now() - t0);
      if (failedDownloads > 0) {
        appLog.warn('Sync', `同步部分失败 (${ms}ms): 上传 ${pushedCount}，拉取 ${pulled.length}，失败 ${failedDownloads} (${firstErrMsg})`);
      } else {
        appLog.info('Sync', `同步完成 (${ms}ms): 上传 ${pushedCount}，拉取 ${pulled.length}，远端共 ${remoteFiles.length} 条`);
      }
      this._refreshSyncBanner({
        lastSyncedAt: Date.now(),
        errorMessage: failedDownloads > 0 ? `有 ${failedDownloads} 条拉取失败：${firstErrMsg}` : '',
        quota: quota || store.syncState.quota
      });
      return { ok: failedDownloads === 0, pulled: pulled.length, pushed: pushedCount, failedDownloads };
    } catch (err) {
      appLog.error('Sync', `同步异常中断: ${err?.message || err}`);
      console.error('[SyncEngine]', err);
      this.syncing = false;
      this._refreshSyncBanner({ errorMessage: err.message || '同步失败' });
      if (!silent) throw err;
      return { ok: false, error: err.message };
    }
  }

  // ---- On-Demand Blob Retrieval & Caching ----

  async getBlobForAttachment(att, { autoDownload = true } = {}) {
    const cached = await db.getBlob(att.fileId);
    if (cached) return cached;

    if (!autoDownload || !att.remoteId) return null;
    const provider = this.getActiveProvider();
    if (!provider.isConnected()) return null;

    if (this.inflightBlobs.has(att.fileId)) {
      return this.inflightBlobs.get(att.fileId);
    }

    const promise = (async () => {
      store.setTransferProgress(att.fileId, { pct: 5, phase: 'download' });
      try {
        let blob = await provider.downloadFileBlob(att.remoteId, (pct) => {
          store.setTransferProgress(att.fileId, { pct, phase: 'download' });
        });
        if (att.encrypted) {
          if (!this.e2eeKey) {
            throw new Error('文件已加密，请先输入端到端加密口令解锁');
          }
          blob = await decryptBlob(blob, this.e2eeKey, att.mimeType);
        } else if (att.mimeType && blob.type !== att.mimeType) {
          blob = new Blob([blob], { type: att.mimeType });
        }
        await db.putBlob(att.fileId, blob, { mimeType: att.mimeType });
        return blob;
      } finally {
        store.setTransferProgress(att.fileId, null);
        this.inflightBlobs.delete(att.fileId);
      }
    })();

    this.inflightBlobs.set(att.fileId, promise);
    return promise;
  }

  async getPreviewUrl(att) {
    if (this.blobUrlCache.has(att.fileId)) {
      return this.blobUrlCache.get(att.fileId);
    }
    const blob = await this.getBlobForAttachment(att, { autoDownload: true });
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.blobUrlCache.set(att.fileId, url);
    return url;
  }

  async _saveBlobViaAndroidBridge(blob, fileName, mimeType) {
    const bridge = window.AndroidBridge;
    if (!bridge) return null;

    // Prefer chunked streaming bridge (512 KB chunks) so even 50 MB+ files never hit WebView JNI OOM
    if (typeof bridge.beginSaveFile === 'function' && typeof bridge.appendSaveChunk === 'function') {
      const start = JSON.parse(bridge.beginSaveFile(fileName, mimeType || ''));
      if (!start?.ok || !start.token) {
        throw new Error(start?.error || '无法在手机下载目录创建文件');
      }
      const token = start.token;
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const CHUNK = 512 * 1024;
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          const slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
          const ok = bridge.appendSaveChunk(token, bytesToBase64(slice));
          if (!ok) throw new Error('写入文件分片失败');
        }
        const done = JSON.parse(bridge.finishSaveFile(token));
        if (!done?.ok) throw new Error(done?.error || '完成文件保存失败');
        appLog.info('Download', `已保存到手机: ${done.path}`);
        return done.path;
      } catch (err) {
        try { bridge.cancelSaveFile?.(token); } catch {}
        throw err;
      }
    }

    // Backwards-compatible single-shot bridge for older APKs
    if (typeof bridge.saveFile === 'function') {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ok = bridge.saveFile(fileName, mimeType || '', bytesToBase64(bytes));
      if (!ok) throw new Error('保存到手机下载目录失败');
      return `Download/CloudDrop/${fileName}`;
    }
    return null;
  }

  async downloadAttachmentToDevice(att) {
    const blob = await this.getBlobForAttachment(att, { autoDownload: true });
    if (!blob) {
      throw new Error('文件尚未同步到本地，请先连接云盘');
    }
    // Inside Android native APK WebView, stream directly to Download/CloudDrop/ via AndroidBridge
    if (window.AndroidBridge) {
      const savedPath = await this._saveBlobViaAndroidBridge(
        blob,
        att.name || 'download',
        att.mimeType || blob.type || ''
      );
      return savedPath;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = att.name || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return att.name || 'download';
  }

  // ---- Backup Export / Import ----

  async exportBackupJson() {
    const events = await db.getAllEvents();
    const payload = {
      app: 'CloudDrop',
      version: 1,
      exportedAt: new Date().toISOString(),
      events
    };
    const jsonStr = JSON.stringify(payload, null, 2);
    const fileName = `clouddrop-backup-${new Date().toISOString().slice(0, 10)}.json`;
    if (window.AndroidBridge && typeof window.AndroidBridge.saveFile === 'function') {
      const bytes = new TextEncoder().encode(jsonStr);
      const ok = window.AndroidBridge.saveFile(fileName, 'application/json', bytesToBase64(bytes));
      if (ok) return;
    }
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async importBackupJson(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const events = Array.isArray(parsed.events) ? parsed.events : [];
    if (!events.length) throw new Error('备份文件中没有有效记录');
    await db.putEvents(events);
    await this.reloadFromDb();
    return events.length;
  }

  async clearLocalCache() {
    for (const u of this.blobUrlCache.values()) URL.revokeObjectURL(u);
    this.blobUrlCache.clear();
    this.seenRemoteNames.clear();
    await Promise.all([db.clearEvents(), db.clearBlobs(), db.clearOutbox()]);
    await this.reloadFromDb();
  }
}

export const syncEngine = new SyncEngine();
