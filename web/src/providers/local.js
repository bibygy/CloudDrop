// Local / LAN Companion Provider
// Works seamlessly in 2 tiers:
// 1. Standalone Browser / PWA offline mode (IndexedDB only, zero setup)
// 2. Desktop Companion LAN Sync mode (auto-detects desktop/clouddrop.py `/api/local-sync/*`
//    which persists events & files to disk and allows Windows + Android + Linux LAN sync!)

import { xhrDownloadBlob, xhrUpload } from './base.js';

export class LocalProvider {
  constructor() {
    this.id = 'local';
    this.name = '本地 / 局域网';
    this.serverAvailable = false;
    this.serverInfo = null;
  }

  async probeServer() {
    try {
      const res = await fetch('/api/local-sync/ping', { cache: 'no-store' });
      if (res.ok) {
        const info = await res.json();
        if (info && info.ok) {
          this.serverAvailable = true;
          this.serverInfo = info;
          return true;
        }
      }
    } catch {
      // Running as static PWA or offline without companion server
    }
    this.serverAvailable = false;
    this.serverInfo = null;
    return false;
  }

  isConnected() {
    return this.serverAvailable;
  }

  getAccountInfo() {
    if (this.serverAvailable) {
      const dir = this.serverInfo?.dataDir ? `目录: ${this.serverInfo.dataDir}` : '局域网直连已就绪';
      return {
        providerName: this.serverInfo?.lanUrl ? '局域网直连' : '本地磁盘同步',
        accountLabel: this.serverInfo?.lanUrl || dir
      };
    }
    return {
      providerName: '本地离线体验',
      accountLabel: '点击连接 Google Drive 或 OneDrive'
    };
  }

  async connect() {
    await this.probeServer();
    return this.serverAvailable;
  }

  async disconnect() {
    // Local provider stays available
  }

  async ensureWorkspace() {
    await this.probeServer();
    return this.serverAvailable;
  }

  async readMeta() {
    if (!this.serverAvailable) return null;
    const res = await fetch('/api/local-sync/meta', { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`读取 meta 失败 (${res.status})`);
    return res.json();
  }

  async writeMeta(meta) {
    if (!this.serverAvailable) return;
    const res = await fetch('/api/local-sync/meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta)
    });
    if (!res.ok) throw new Error(`写入 meta 失败 (${res.status})`);
  }

  async listEvents() {
    if (!this.serverAvailable) return { events: [], nextToken: null };
    const res = await fetch('/api/local-sync/events', { cache: 'no-store' });
    if (!res.ok) throw new Error(`拉取事件列表失败 (${res.status})`);
    const data = await res.json();
    return { events: data.events || [], nextToken: null };
  }

  async downloadEventJson(remoteId) {
    const res = await fetch(`/api/local-sync/events/${encodeURIComponent(remoteId)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`下载事件失败 (${res.status})`);
    return res.json();
  }

  async uploadEventJson(filename, obj) {
    if (!this.serverAvailable) return { remoteId: filename };
    const res = await fetch(`/api/local-sync/events/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj)
    });
    if (!res.ok) throw new Error(`上传事件失败 (${res.status})`);
    return { remoteId: filename };
  }

  async uploadFileBlob(filename, blob, mimeType, onProgress) {
    if (!this.serverAvailable) {
      if (onProgress) onProgress(100);
      return { remoteId: filename, size: blob.size };
    }
    await xhrUpload({
      method: 'PUT',
      url: `/api/local-sync/files/${encodeURIComponent(filename)}`,
      headers: { 'Content-Type': mimeType || 'application/octet-stream' },
      body: blob,
      onProgress
    });
    return { remoteId: filename, size: blob.size };
  }

  async downloadFileBlob(remoteId, onProgress) {
    return xhrDownloadBlob({
      url: `/api/local-sync/files/${encodeURIComponent(remoteId)}`,
      onProgress
    });
  }

  async deleteFileBlob(remoteId) {
    if (!this.serverAvailable) return;
    await fetch(`/api/local-sync/files/${encodeURIComponent(remoteId)}`, { method: 'DELETE' });
  }

  async getQuota() {
    if (!this.serverAvailable || !this.serverInfo) return null;
    if (typeof this.serverInfo.diskUsed === 'number' && typeof this.serverInfo.diskTotal === 'number') {
      return { used: this.serverInfo.diskUsed, total: this.serverInfo.diskTotal };
    }
    return null;
  }
}
