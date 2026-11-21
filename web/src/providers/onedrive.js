// Real Microsoft OneDrive (Microsoft Graph v1.0) CloudProvider
// Auth: Zero-dependency RFC 7636 OAuth 2.0 Authorization Code + PKCE (S256) with Refresh Token rotation!
// Works cleanly with Personal Microsoft Accounts (/consumers) AND Work/School (/common)

import { getAppRedirectUri, xhrDownloadBlob, xhrUpload } from './base.js';

const TOKEN_STORAGE_KEY = 'clouddrop_onedrive_auth_v1';
const PKCE_STATE_KEY = 'clouddrop_onedrive_pkce_v1';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'Files.ReadWrite User.Read offline_access';
const SIMPLE_LIMIT = 4 * 1024 * 1024; // 4 MB
const CHUNK_SIZE = 327680 * 10; // 3.2 MiB (exact multiple of 320 KiB as required by Microsoft Graph)

function base64UrlEncode(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createPkcePair() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

export class OneDriveProvider {
  constructor() {
    this.id = 'onedrive';
    this.name = 'OneDrive';
    this.auth = this._loadAuth();
    this.workspaceReady = false;
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
      // ignore
    }
  }

  isConnected() {
    return Boolean(this.auth && (this.auth.accessToken || this.auth.refreshToken));
  }

  getAccountInfo() {
    return {
      providerName: 'Microsoft OneDrive',
      accountLabel: this.auth?.accountName || (this.isConnected() ? '已连接 OneDrive' : '需要授权登录')
    };
  }

  // Called on app startup to complete OAuth PKCE redirect callback (`?code=...&state=od_...`)
  async handleRedirectCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state') || '';
    const errParam = params.get('error');

    if (errParam && state.startsWith('od_')) {
      const desc = params.get('error_description') || errParam;
      history.replaceState(null, '', window.location.pathname);
      throw new Error(`OneDrive 授权被拒绝: ${desc}`);
    }

    if (!code || !state.startsWith('od_')) return false;

    const savedRaw = sessionStorage.getItem(PKCE_STATE_KEY);
    sessionStorage.removeItem(PKCE_STATE_KEY);
    history.replaceState(null, '', window.location.pathname);

    if (!savedRaw) {
      throw new Error('PKCE 状态已失效，请重新点击连接 OneDrive');
    }
    const saved = JSON.parse(savedRaw);
    if (saved.state !== state) {
      throw new Error('OAuth state 校验不匹配');
    }

    await this._exchangeCode({
      code,
      verifier: saved.verifier,
      clientId: saved.clientId,
      authority: saved.authority,
      redirectUri: saved.redirectUri
    });

    // If opened inside a popup window, notify opener and close!
    if (window.opener && window.opener !== window) {
      try {
        window.opener.postMessage({ type: 'clouddrop_onedrive_auth_done', auth: this.auth }, window.location.origin);
        window.close();
      } catch {
        // fallback if popup can't close
      }
    }

    await this._fetchProfileAndQuota();
    await this.ensureWorkspace();
    return true;
  }

  async connect({ clientId, authority = 'consumers', useRedirect = false } = {}) {
    const cid = (clientId || this.auth?.clientId || '').trim();
    if (!cid) {
      throw new Error('请先填写 Microsoft Entra (Azure) 应用 Client ID');
    }
    const tenant = authority === 'common' ? 'common' : 'consumers';
    const redirectUri = getAppRedirectUri();
    const { verifier, challenge } = await createPkcePair();
    const state = `od_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(12)))}`;

    sessionStorage.setItem(
      PKCE_STATE_KEY,
      JSON.stringify({ state, verifier, clientId: cid, authority: tenant, redirectUri })
    );

    const authUrl = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
    authUrl.searchParams.set('client_id', cid);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_mode', 'query');
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    if (useRedirect) {
      window.location.href = authUrl.toString();
      return false;
    }

    // Try popup first for seamless desktop experience; fallback to redirect if popup blocked
    const popup = window.open(authUrl.toString(), 'clouddrop_onedrive_oauth', 'width=520,height=660');
    if (!popup) {
      window.location.href = authUrl.toString();
      return false;
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.removeEventListener('message', onMsg);
        clearInterval(poll);
      };
      const onMsg = async (ev) => {
        if (ev.origin !== window.location.origin) return;
        if (ev.data?.type === 'clouddrop_onedrive_auth_done' && ev.data.auth) {
          cleanup();
          this._saveAuth(ev.data.auth);
          try {
            await this._fetchProfileAndQuota();
            await this.ensureWorkspace();
            resolve(true);
          } catch (e) {
            reject(e);
          }
        }
      };
      window.addEventListener('message', onMsg);

      const poll = setInterval(() => {
        if (popup.closed) {
          cleanup();
          // Re-check localStorage in case popup saved tokens before closing
          const fresh = this._loadAuth();
          if (fresh && fresh.accessToken) {
            this.auth = fresh;
            resolve(true);
          } else {
            reject(new Error('OneDrive 登录窗口已关闭'));
          }
        }
      }, 500);
    });
  }

  async _exchangeCode({ code, verifier, clientId, authority, redirectUri }) {
    const tokenUrl = `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      scope: SCOPES
    });
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`OneDrive 换取令牌失败: ${data.error_description || data.error || res.status}`);
    }
    this._saveAuth({
      ...(this.auth || {}),
      clientId,
      authority,
      redirectUri,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || this.auth?.refreshToken || '',
      expiresAt: Date.now() + (Number(data.expires_in || 3500) - 90) * 1000
    });
  }

  async _refreshAccessToken() {
    if (!this.auth?.refreshToken || !this.auth?.clientId) {
      const err = new Error('OneDrive 会话已过期，请重新连接');
      err.code = 'AUTH_EXPIRED';
      throw err;
    }
    const authority = this.auth.authority || 'consumers';
    const tokenUrl = `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.auth.clientId,
      grant_type: 'refresh_token',
      refresh_token: this.auth.refreshToken,
      scope: SCOPES
    });
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(`OneDrive 刷新令牌失败: ${data.error_description || data.error || res.status}`);
      err.code = 'AUTH_EXPIRED';
      throw err;
    }
    this._saveAuth({
      ...this.auth,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || this.auth.refreshToken,
      expiresAt: Date.now() + (Number(data.expires_in || 3500) - 90) * 1000
    });
    return this.auth.accessToken;
  }

  async _ensureToken() {
    if (this.auth?.accessToken && Date.now() < (this.auth.expiresAt || 0)) {
      return this.auth.accessToken;
    }
    return this._refreshAccessToken();
  }

  async disconnect() {
    this._saveAuth(null);
    this.workspaceReady = false;
  }

  async _graphFetch(pathOrUrl, options = {}, allow404 = false) {
    const token = await this._ensureToken();
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_API}${pathOrUrl}`;
    let res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    if (res.status === 401 && this.auth?.refreshToken) {
      const newToken = await this._refreshAccessToken();
      res = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${newToken}`,
          ...(options.headers || {})
        }
      });
    }
    if (allow404 && res.status === 404) return null;
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`OneDrive API 错误 (${res.status}): ${txt.slice(0, 220)}`);
    }
    return res;
  }

  async _fetchProfileAndQuota() {
    try {
      const [meRes, driveRes] = await Promise.all([
        this._graphFetch('/me?$select=displayName,userPrincipalName,mail'),
        this._graphFetch('/me/drive?$select=quota')
      ]);
      const me = await meRes.json();
      const drv = await driveRes.json();
      const accountName = me.mail || me.userPrincipalName || me.displayName || 'OneDrive 用户';
      const quota = drv?.quota
        ? { used: Number(drv.quota.used || 0), total: Number(drv.quota.total || 0) }
        : null;
      this._saveAuth({ ...this.auth, accountName, quota });
    } catch {
      // non-fatal
    }
  }

  async _ensureFolder(parentPath, folderName) {
    const fullPath = parentPath ? `${parentPath}/${folderName}` : folderName;
    const check = await this._graphFetch(`/me/drive/root:/${fullPath}:`, {}, true);
    if (check) return;
    const createEndpoint = parentPath
      ? `/me/drive/root:/${parentPath}:/children`
      : `/me/drive/root/children`;
    await this._graphFetch(createEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: folderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'replace'
      })
    });
  }

  async ensureWorkspace() {
    if (this.workspaceReady) return true;
    await this._ensureFolder('', 'CloudDrop');
    await Promise.all([
      this._ensureFolder('CloudDrop', 'events'),
      this._ensureFolder('CloudDrop', 'files')
    ]);
    this.workspaceReady = true;
    return true;
  }

  async readMeta() {
    await this.ensureWorkspace();
    const res = await this._graphFetch('/me/drive/root:/CloudDrop/meta.json:/content', {}, true);
    if (!res) return null;
    return res.json();
  }

  async writeMeta(meta) {
    await this.ensureWorkspace();
    await this._graphFetch('/me/drive/root:/CloudDrop/meta.json:/content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta, null, 2)
    });
  }

  async listEvents() {
    await this.ensureWorkspace();
    const events = [];
    let url = '/me/drive/root:/CloudDrop/events:/children?$select=id,name,lastModifiedDateTime&$top=200';
    while (url) {
      const res = await this._graphFetch(url, {}, true);
      if (!res) break;
      const data = await res.json();
      for (const f of data.value || []) {
        events.push({
          remoteId: f.id,
          name: f.name,
          modifiedTime: f.lastModifiedDateTime
        });
      }
      url = data['@odata.nextLink'] || null;
    }
    return { events, nextToken: null };
  }

  async downloadEventJson(remoteId) {
    const res = await this._graphFetch(`/me/drive/items/${encodeURIComponent(remoteId)}/content`);
    return res.json();
  }

  async uploadEventJson(filename, obj) {
    await this.ensureWorkspace();
    const res = await this._graphFetch(
      `/me/drive/root:/CloudDrop/events/${encodeURIComponent(filename)}:/content`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obj)
      }
    );
    const data = await res.json();
    return { remoteId: data.id };
  }

  async uploadFileBlob(filename, blob, mimeType, onProgress) {
    await this.ensureWorkspace();
    const token = await this._ensureToken();
    const safeEnc = encodeURIComponent(filename);

    if (blob.size <= SIMPLE_LIMIT) {
      const res = await xhrUpload({
        method: 'PUT',
        url: `${GRAPH_API}/me/drive/root:/CloudDrop/files/${safeEnc}:/content`,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': mimeType || 'application/octet-stream'
        },
        body: blob,
        onProgress
      });
      return { remoteId: res.data?.id || filename, size: blob.size };
    }

    // Microsoft Graph Resumable Upload Session for > 4 MB files
    const sessRes = await this._graphFetch(
      `/me/drive/root:/CloudDrop/files/${safeEnc}:/createUploadSession`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item: { '@microsoft.graph.conflictBehavior': 'replace', name: filename }
        })
      }
    );
    const { uploadUrl } = await sessRes.json();
    if (!uploadUrl) throw new Error('OneDrive 未返回 uploadUrl');

    let offset = 0;
    let finalItem = null;
    while (offset < blob.size) {
      const end = Math.min(offset + CHUNK_SIZE, blob.size);
      const chunk = blob.slice(offset, end);
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunk.size),
          'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}`
        },
        body: chunk
      });
      if (!putRes.ok && putRes.status !== 202) {
        throw new Error(`OneDrive 分片上传失败 (${putRes.status})`);
      }
      if (putRes.status === 200 || putRes.status === 201) {
        finalItem = await putRes.json();
      }
      offset = end;
      if (onProgress) onProgress(Math.round((offset / blob.size) * 100));
    }
    return { remoteId: finalItem?.id || filename, size: blob.size };
  }

  async downloadFileBlob(remoteId, onProgress) {
    const token = await this._ensureToken();
    // Fetch item metadata to get pre-authenticated @microsoft.graph.downloadUrl (avoids CORS redirect issues!)
    const metaRes = await this._graphFetch(`/me/drive/items/${encodeURIComponent(remoteId)}`);
    const meta = await metaRes.json();
    const dlUrl = meta['@microsoft.graph.downloadUrl'];
    if (dlUrl) {
      return xhrDownloadBlob({ url: dlUrl, onProgress });
    }
    return xhrDownloadBlob({
      url: `${GRAPH_API}/me/drive/items/${encodeURIComponent(remoteId)}/content`,
      headers: { Authorization: `Bearer ${token}` },
      onProgress
    });
  }

  async deleteFileBlob(remoteId) {
    if (!remoteId) return;
    try {
      await this._graphFetch(`/me/drive/items/${encodeURIComponent(remoteId)}`, { method: 'DELETE' }, true);
    } catch {
      // ignore
    }
  }

  async getQuota() {
    if (this.auth?.quota) return this.auth.quota;
    await this._fetchProfileAndQuota();
    return this.auth?.quota || null;
  }
}
