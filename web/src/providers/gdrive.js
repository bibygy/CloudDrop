// Real Google Drive API v3 CloudProvider
// Auth: Google Identity Services (GIS) Token Client + OAuth 2.0 redirect fallback
// Scope: https://www.googleapis.com/auth/drive.file (least-privilege: only CloudDrop's own folder/files!)

import { getAppRedirectUri, xhrDownloadBlob, xhrUpload } from './base.js';

const TOKEN_STORAGE_KEY = 'clouddrop_gdrive_auth_v1';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const RESUMABLE_THRESHOLD = 5 * 1024 * 1024; // 5 MB
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB (multiple of 256 KiB)

let gisLoadPromise = null;

function loadGisScript() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisLoadPromise = null;
      reject(new Error('无法加载 Google Identity Services 脚本，请检查网络环境'));
    };
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

export class GoogleDriveProvider {
  constructor() {
    this.id = 'gdrive';
    this.name = 'Google Drive';
    this.auth = this._loadAuth();
    this.folders = null; // { rootId, eventsId, filesId }
    this.metaFileId = null;
    this.tokenClient = null;
  }

  _loadAuth() {
    try {
      const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _saveAuth(auth) {
    this.auth = auth;
    try {
      if (auth) localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(auth));
      else localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // ignore storage failure
    }
  }

  // Handle OAuth redirect fallback (#access_token=...&state=gdrive_...)
  handleRedirectCallback() {
    if (!window.location.hash || !window.location.hash.includes('access_token=')) return false;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const state = params.get('state') || '';
    if (!state.startsWith('gdrive_')) return false;

    const expected = sessionStorage.getItem('clouddrop_gdrive_state');
    sessionStorage.removeItem('clouddrop_gdrive_state');
    if (expected && state !== expected) return false;

    const accessToken = params.get('access_token');
    const expiresIn = Number(params.get('expires_in') || 3500);
    if (accessToken) {
      this._saveAuth({
        ...(this.auth || {}),
        accessToken,
        expiresAt: Date.now() + (expiresIn - 60) * 1000
      });
      history.replaceState(null, '', window.location.pathname + window.location.search);
      return true;
    }
    return false;
  }

  isConnected() {
    return Boolean(this.auth && this.auth.accessToken && Date.now() < (this.auth.expiresAt || 0));
  }

  hasSavedSession() {
    return Boolean(this.auth && (this.auth.accessToken || this.auth.email));
  }

  getAccountInfo() {
    return {
      providerName: 'Google Drive',
      accountLabel: this.auth?.email || (this.isConnected() ? '已连接 Google Drive' : '需要授权登录')
    };
  }

  async connect({ clientId, useRedirect = false, manualToken = '' } = {}) {
    if (manualToken) {
      this._saveAuth({
        accessToken: manualToken.trim(),
        expiresAt: Date.now() + 55 * 60 * 1000,
        clientId: clientId || this.auth?.clientId || ''
      });
      await this._fetchAccountProfile();
      await this.ensureWorkspace();
      return true;
    }

    const cid = (clientId || this.auth?.clientId || '').trim();
    if (!cid) {
      throw new Error('请先填写 Google OAuth Client ID');
    }

    if (useRedirect) {
      const state = `gdrive_${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
      sessionStorage.setItem('clouddrop_gdrive_state', state);
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', cid);
      url.searchParams.set('redirect_uri', getAppRedirectUri());
      url.searchParams.set('response_type', 'token');
      url.searchParams.set('scope', SCOPES);
      url.searchParams.set('include_granted_scopes', 'true');
      url.searchParams.set('state', state);
      this._saveAuth({ ...(this.auth || {}), clientId: cid });
      window.location.href = url.toString();
      return false;
    }

    await loadGisScript();
    const tokenResp = await new Promise((resolve, reject) => {
      try {
        this.tokenClient = globalThis.google.accounts.oauth2.initTokenClient({
          client_id: cid,
          scope: SCOPES,
          callback: (resp) => {
            if (resp.error) {
              reject(new Error(`Google 授权失败: ${resp.error_description || resp.error}`));
            } else {
              resolve(resp);
            }
          },
          error_callback: (err) => {
            reject(new Error(`Google 授权弹窗关闭或被拦截: ${err?.type || 'popup_closed'}`));
          }
        });
        this.tokenClient.requestAccessToken({ prompt: this.auth?.email ? '' : 'consent' });
      } catch (err) {
        reject(err);
      }
    });

    this._saveAuth({
      ...(this.auth || {}),
      clientId: cid,
      accessToken: tokenResp.access_token,
      expiresAt: Date.now() + (Number(tokenResp.expires_in || 3500) - 60) * 1000
    });

    await this._fetchAccountProfile();
    await this.ensureWorkspace();
    return true;
  }

  async _ensureToken() {
    if (this.isConnected()) return this.auth.accessToken;
    // Try silent GIS refresh if clientId exists
    if (this.auth?.clientId && globalThis.google?.accounts?.oauth2) {
      try {
        const resp = await new Promise((resolve, reject) => {
          const client = globalThis.google.accounts.oauth2.initTokenClient({
            client_id: this.auth.clientId,
            scope: SCOPES,
            hint: this.auth.email || undefined,
            callback: (r) => (r.error ? reject(new Error(r.error)) : resolve(r)),
            error_callback: (e) => reject(e)
          });
          client.requestAccessToken({ prompt: '' });
        });
        this._saveAuth({
          ...this.auth,
          accessToken: resp.access_token,
          expiresAt: Date.now() + (Number(resp.expires_in || 3500) - 60) * 1000
        });
        return this.auth.accessToken;
      } catch {
        // fall through to re-auth error
      }
    }
    const err = new Error('Google Drive 访问令牌已过期，请在设置中重新授权');
    err.code = 'AUTH_EXPIRED';
    throw err;
  }

  async disconnect() {
    if (this.auth?.accessToken && globalThis.google?.accounts?.oauth2?.revoke) {
      try {
        globalThis.google.accounts.oauth2.revoke(this.auth.accessToken, () => {});
      } catch {
        // ignore revoke failure
      }
    }
    this._saveAuth(null);
    this.folders = null;
    this.metaFileId = null;
  }

  async _apiFetch(url, options = {}) {
    const token = await this._ensureToken();
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    if (res.status === 401) {
      const err = new Error('Google Drive 登录已过期，请重新连接');
      err.code = 'AUTH_EXPIRED';
      throw err;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Google Drive API 错误 (${res.status}): ${txt.slice(0, 220)}`);
    }
    return res;
  }

  async _fetchAccountProfile() {
    try {
      const res = await this._apiFetch(`${DRIVE_API}/about?fields=user(displayName,emailAddress),storageQuota(usage,limit)`);
      const data = await res.json();
      const email = data?.user?.emailAddress || data?.user?.displayName || '';
      const quota = data?.storageQuota
        ? {
            used: Number(data.storageQuota.usage || 0),
            total: Number(data.storageQuota.limit || 0)
          }
        : null;
      this._saveAuth({ ...this.auth, email, quota });
    } catch {
      // non-fatal
    }
  }

  async _findOrCreateFolder(name, parentId = null) {
    const safeName = name.replace(/'/g, "\\'");
    const parentClause = parentId ? `'${parentId}' in parents` : `'root' in parents`;
    const q = `mimeType='application/vnd.google-apps.folder' and name='${safeName}' and ${parentClause} and trashed=false`;
    const listUrl = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive&pageSize=5`;
    const res = await this._apiFetch(listUrl);
    const data = await res.json();
    if (data.files && data.files.length > 0) {
      return data.files[0].id;
    }

    const body = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {})
    };
    const createRes = await this._apiFetch(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const created = await createRes.json();
    return created.id;
  }

  async ensureWorkspace() {
    if (this.folders) return this.folders;
    const rootId = await this._findOrCreateFolder('CloudDrop', null);
    const [eventsId, filesId] = await Promise.all([
      this._findOrCreateFolder('events', rootId),
      this._findOrCreateFolder('files', rootId)
    ]);
    this.folders = { rootId, eventsId, filesId };
    return this.folders;
  }

  async readMeta() {
    const { rootId } = await this.ensureWorkspace();
    const q = `name='meta.json' and '${rootId}' in parents and trashed=false`;
    const res = await this._apiFetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`);
    const data = await res.json();
    if (!data.files || !data.files.length) return null;
    this.metaFileId = data.files[0].id;
    const dl = await this._apiFetch(`${DRIVE_API}/files/${this.metaFileId}?alt=media`);
    return dl.json();
  }

  async writeMeta(meta) {
    const { rootId } = await this.ensureWorkspace();
    const jsonBlob = new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' });
    if (this.metaFileId) {
      await this._apiFetch(`${UPLOAD_API}/files/${this.metaFileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: jsonBlob
      });
      return;
    }
    const created = await this._multipartUpload('meta.json', rootId, jsonBlob, 'application/json');
    this.metaFileId = created.id;
  }

  async listEvents(sinceModifiedIso = null) {
    const { eventsId } = await this.ensureWorkspace();
    let q = `'${eventsId}' in parents and trashed=false`;
    if (sinceModifiedIso) {
      q += ` and modifiedTime > '${sinceModifiedIso}'`;
    }
    const events = [];
    let pageToken = '';
    do {
      const url =
        `${DRIVE_API}/files?q=${encodeURIComponent(q)}` +
        `&fields=nextPageToken,files(id,name,modifiedTime)&orderBy=modifiedTime&pageSize=200` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const res = await this._apiFetch(url);
      const data = await res.json();
      for (const f of data.files || []) {
        events.push({ remoteId: f.id, name: f.name, modifiedTime: f.modifiedTime });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    const lastModified = events.length ? events[events.length - 1].modifiedTime : sinceModifiedIso;
    return { events, nextToken: lastModified };
  }

  async downloadEventJson(remoteId) {
    const res = await this._apiFetch(`${DRIVE_API}/files/${encodeURIComponent(remoteId)}?alt=media`);
    return res.json();
  }

  async uploadEventJson(filename, obj) {
    const { eventsId } = await this.ensureWorkspace();
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const created = await this._multipartUpload(filename, eventsId, blob, 'application/json');
    return { remoteId: created.id };
  }

  async uploadFileBlob(filename, blob, mimeType, onProgress) {
    const { filesId } = await this.ensureWorkspace();
    const type = mimeType || blob.type || 'application/octet-stream';
    if (blob.size <= RESUMABLE_THRESHOLD) {
      const created = await this._multipartUpload(filename, filesId, blob, type, onProgress);
      return { remoteId: created.id, size: blob.size };
    }
    const created = await this._resumableUpload(filename, filesId, blob, type, onProgress);
    return { remoteId: created.id, size: blob.size };
  }

  async _multipartUpload(filename, parentId, blob, mimeType, onProgress) {
    const token = await this._ensureToken();
    const boundary = `clouddrop_${Date.now().toString(36)}`;
    const metadata = JSON.stringify({ name: filename, parents: [parentId] });
    const multipartBody = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      metadata,
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`
    ]);

    const res = await xhrUpload({
      method: 'POST',
      url: `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,size`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: multipartBody,
      onProgress
    });
    return res.data;
  }

  async _resumableUpload(filename, parentId, blob, mimeType, onProgress) {
    const token = await this._ensureToken();
    const initRes = await fetch(`${UPLOAD_API}/files?uploadType=resumable&fields=id,name,size`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(blob.size)
      },
      body: JSON.stringify({ name: filename, parents: [parentId] })
    });
    if (!initRes.ok) {
      throw new Error(`初始化 Google Drive 断点续传失败 (${initRes.status})`);
    }
    const sessionUrl = initRes.headers.get('Location');
    if (!sessionUrl) throw new Error('未获取到上传会话地址');

    let offset = 0;
    while (offset < blob.size) {
      const end = Math.min(offset + CHUNK_SIZE, blob.size);
      const chunk = blob.slice(offset, end);
      const putRes = await fetch(sessionUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': mimeType,
          'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}`
        },
        body: chunk
      });
      if (putRes.status === 200 || putRes.status === 201) {
        if (onProgress) onProgress(100);
        return putRes.json();
      }
      if (putRes.status !== 308) {
        throw new Error(`分片上传失败 (${putRes.status})`);
      }
      offset = end;
      if (onProgress) onProgress(Math.round((offset / blob.size) * 100));
    }
    throw new Error('分片上传未返回文件 ID');
  }

  async downloadFileBlob(remoteId, onProgress) {
    const token = await this._ensureToken();
    return xhrDownloadBlob({
      url: `${DRIVE_API}/files/${encodeURIComponent(remoteId)}?alt=media`,
      headers: { Authorization: `Bearer ${token}` },
      onProgress
    });
  }

  async deleteFileBlob(remoteId) {
    if (!remoteId) return;
    try {
      await this._apiFetch(`${DRIVE_API}/files/${encodeURIComponent(remoteId)}`, { method: 'DELETE' });
    } catch {
      // ignore if already deleted
    }
  }

  async getQuota() {
    if (this.auth?.quota) return this.auth.quota;
    await this._fetchAccountProfile();
    return this.auth?.quota || null;
  }
}
