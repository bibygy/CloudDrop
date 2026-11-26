// Real Microsoft OneDrive (Microsoft Graph v1.0) CloudProvider
// Auth: Zero-dependency RFC 7636 OAuth 2.0 Authorization Code + PKCE (S256) with Refresh Token rotation!
// Works cleanly with Personal Microsoft Accounts (/consumers) AND Work/School (/common)

import { bytesToBase64, formatBytes, getAppRedirectUri, xhrDownloadBlob, xhrUpload } from './base.js';
import { appLog } from '../ui/logger.js';

const TOKEN_STORAGE_KEY = 'clouddrop_onedrive_auth_v1';
const PKCE_STATE_KEY = 'clouddrop_onedrive_pkce_v1';
const AUTH_CHANNEL_NAME = 'clouddrop_onedrive_auth_channel';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'Files.ReadWrite User.Read offline_access';
const SIMPLE_LIMIT = 4 * 1024 * 1024; // 4 MB
const GRAPH_CHUNK_UNIT = 327680; // 320 KiB (Microsoft Graph required alignment)
const DESKTOP_CHUNK_SIZE = GRAPH_CHUNK_UNIT * 20; // 6.25 MiB (6,553,600 B)
const ANDROID_BRIDGE_CHUNK_SIZE = GRAPH_CHUNK_UNIT * 5; // 1.56 MiB (1,638,400 B, safe for WebView JNI)
const MAX_CHUNK_RETRIES = 5;
const CHUNK_INACTIVITY_TIMEOUT_MS = 120000;

const nativeHttpPending = new Map();
let nativeHttpSeq = 0;

function ensureNativeHttpBridge() {
  if (typeof window === 'undefined') return;
  if (!window.__clouddropNativeCb) {
    window.__clouddropNativeCb = (reqId, rawJson) => {
      const entry = nativeHttpPending.get(reqId);
      if (!entry) return;
      nativeHttpPending.delete(reqId);
      clearTimeout(entry.timer);
      try {
        const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
        entry.resolve(parsed);
      } catch (err) {
        entry.reject(err);
      }
    };
  }
}

function callNativeAsync(invoker, timeoutMs = 135000) {
  ensureNativeHttpBridge();
  const reqId = `nat_${++nativeHttpSeq}_${Date.now().toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativeHttpPending.delete(reqId);
      const err = new Error(`原生通道请求超时 (${Math.round(timeoutMs / 1000)}s)`);
      err.isTimeout = true;
      err.isNetworkError = true;
      reject(err);
    }, timeoutMs);
    nativeHttpPending.set(reqId, { resolve, reject, timer });
    try {
      invoker(reqId);
    } catch (err) {
      nativeHttpPending.delete(reqId);
      clearTimeout(timer);
      reject(err);
    }
  });
}

function parseNextExpectedOffset(data) {
  const ranges = data?.nextExpectedRanges;
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  const first = String(ranges[0] || '');
  const startStr = first.split('-')[0];
  const n = Number(startStr);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`请求超时 (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`网络请求超时 (${Math.round(timeoutMs / 1000)}s)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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
    this._refreshPromise = null;
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

    const savedRaw = localStorage.getItem(PKCE_STATE_KEY) || sessionStorage.getItem(PKCE_STATE_KEY);
    localStorage.removeItem(PKCE_STATE_KEY);
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

    this.workspaceReady = false;
    this._refreshPromise = null;
    appLog.info('OneDrive', 'OAuth 授权回调换取令牌成功');

    // Notify main window via BroadcastChannel (works even when Microsoft COOP severs window.opener!)
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        const ch = new BroadcastChannel(AUTH_CHANNEL_NAME);
        ch.postMessage({ type: 'clouddrop_onedrive_auth_done', auth: this.auth });
        ch.close();
      }
    } catch {
      // ignore BroadcastChannel error
    }

    // If opened inside a popup window, also notify opener and close
    if (window.opener && window.opener !== window) {
      try {
        window.opener.postMessage({ type: 'clouddrop_onedrive_auth_done', auth: this.auth }, window.location.origin);
        window.close();
      } catch {
        // fallback if popup can't close
      }
    }

    // Fetch profile & workspace best-effort so callback never stalls or blanks the UI
    await this._fetchProfileAndQuota().catch(() => {});
    await this.ensureWorkspace().catch((e) => appLog.warn('OneDrive', `回调后初始化目录延迟: ${e?.message || e}`));
    return true;
  }

  async connect({ clientId, authority = 'consumers', useRedirect = false, reauth = false } = {}) {
    const cid = (clientId || this.auth?.clientId || '').trim();
    if (!cid) {
      throw new Error('请先填写 Microsoft Entra (Azure) 应用 Client ID');
    }
    this.workspaceReady = false;
    this._refreshPromise = null;

    const tenant = authority === 'common' ? 'common' : 'consumers';
    const redirectUri = getAppRedirectUri();
    const { verifier, challenge } = await createPkcePair();
    const state = `od_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(12)))}`;

    const pkceRecord = JSON.stringify({ state, verifier, clientId: cid, authority: tenant, redirectUri, ts: Date.now() });
    localStorage.setItem(PKCE_STATE_KEY, pkceRecord);
    sessionStorage.setItem(PKCE_STATE_KEY, pkceRecord);

    const authUrl = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
    authUrl.searchParams.set('client_id', cid);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_mode', 'query');
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    if (reauth || this.isConnected()) {
      authUrl.searchParams.set('prompt', 'select_account');
    }

    const isMobileOrPwa =
      window.matchMedia('(display-mode: standalone)').matches ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');

    appLog.info('OneDrive', `发起授权 (mode=${useRedirect || isMobileOrPwa ? 'redirect' : 'popup'}, reauth=${Boolean(reauth)})`);

    if (useRedirect || isMobileOrPwa) {
      window.location.href = authUrl.toString();
      return false;
    }

    // Try popup first for regular desktop web tab; fallback to redirect if popup blocked
    const startedAt = Date.now();
    const popup = window.open(authUrl.toString(), 'clouddrop_onedrive_oauth', 'width=520,height=660');
    if (!popup) {
      window.location.href = authUrl.toString();
      return false;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let ch = null;
      const cleanup = () => {
        window.removeEventListener('message', onMsg);
        window.removeEventListener('storage', onStorage);
        if (ch) {
          try { ch.close(); } catch {}
        }
        clearInterval(poll);
        clearTimeout(timeout);
      };

      const finishWithAuth = async (newAuth) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { if (!popup.closed) popup.close(); } catch {}
        this._saveAuth(newAuth);
        this.workspaceReady = false;
        this._refreshPromise = null;
        try {
          await this._fetchProfileAndQuota().catch(() => {});
          await this.ensureWorkspace();
          resolve(true);
        } catch (e) {
          reject(e);
        }
      };

      const onMsg = (ev) => {
        if (ev.origin !== window.location.origin) return;
        if (ev.data?.type === 'clouddrop_onedrive_auth_done' && ev.data.auth) {
          finishWithAuth(ev.data.auth);
        }
      };
      const onStorage = (ev) => {
        if (ev.key === TOKEN_STORAGE_KEY && ev.newValue) {
          try {
            const parsed = JSON.parse(ev.newValue);
            if (parsed?.accessToken && (parsed.savedAt || 0) >= startedAt) {
              finishWithAuth(parsed);
            }
          } catch {}
        }
      };

      window.addEventListener('message', onMsg);
      window.addEventListener('storage', onStorage);
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          ch = new BroadcastChannel(AUTH_CHANNEL_NAME);
          ch.onmessage = (ev) => {
            if (ev.data?.type === 'clouddrop_onedrive_auth_done' && ev.data.auth) {
              finishWithAuth(ev.data.auth);
            }
          };
        }
      } catch {}

      const poll = setInterval(() => {
        if (popup.closed) {
          if (settled) return;
          const fresh = this._loadAuth();
          if (fresh && fresh.accessToken && (fresh.savedAt || 0) >= startedAt) {
            finishWithAuth(fresh);
          } else {
            settled = true;
            cleanup();
            reject(new Error('OneDrive 登录窗口已关闭'));
          }
        }
      }, 450);

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('OneDrive 授权超时，请点击「当前页跳转授权」重试'));
      }, 120000);
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
    const res = await fetchWithTimeout(
      tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      },
      20000
    );
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
      expiresAt: Date.now() + (Number(data.expires_in || 3500) - 90) * 1000,
      savedAt: Date.now()
    });
  }

  // Single-flight token refresh with retry on transient cold-start network errors.
  // Prevents concurrent startup API calls from double-spending Microsoft's single-use refresh token!
  async _refreshAccessToken() {
    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    this._refreshPromise = (async () => {
      // Re-read storage first in case another tab/window already rotated the token
      const latest = this._loadAuth();
      if (latest) this.auth = latest;
      if (this.auth?.accessToken && Date.now() < (this.auth.expiresAt || 0)) {
        return this.auth.accessToken;
      }

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

      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetchWithTimeout(
            tokenUrl,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body
            },
            20000
          );
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.access_token) {
            this._saveAuth({
              ...this.auth,
              accessToken: data.access_token,
              refreshToken: data.refresh_token || this.auth.refreshToken,
              expiresAt: Date.now() + (Number(data.expires_in || 3500) - 90) * 1000,
              savedAt: Date.now()
            });
            appLog.info('OneDrive', '访问令牌静默刷新成功');
            return this.auth.accessToken;
          }
          // Transient Microsoft 5xx -> retry
          if (res.status >= 500 && attempt < 2) {
            await sleep(700 * (attempt + 1));
            continue;
          }
          const err = new Error(`OneDrive 刷新令牌失败: ${data.error_description || data.error || res.status}`);
          err.code = 'AUTH_EXPIRED';
          throw err;
        } catch (err) {
          lastErr = err;
          if (err?.code === 'AUTH_EXPIRED') throw err;
          if (attempt < 2) {
            appLog.warn('OneDrive', `刷新令牌网络波动，第 ${attempt + 1} 次重试: ${err?.message || err}`);
            await sleep(800 * (attempt + 1));
            continue;
          }
          throw err;
        }
      }
      throw lastErr || new Error('OneDrive 刷新令牌失败');
    })();

    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
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
    this._refreshPromise = null;
  }

  async _graphFetch(pathOrUrl, options = {}, allow404 = false) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_API}${pathOrUrl}`;
    let lastErr = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const token = await this._ensureToken();
        let res = await fetchWithTimeout(
          url,
          {
            ...options,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(options.headers || {})
            }
          },
          25000
        );
        if (res.status === 401 && this.auth?.refreshToken) {
          // Force refresh once via single-flight lock
          if (this.auth) this.auth.expiresAt = 0;
          const newToken = await this._refreshAccessToken();
          res = await fetchWithTimeout(
            url,
            {
              ...options,
              headers: {
                Authorization: `Bearer ${newToken}`,
                ...(options.headers || {})
              }
            },
            25000
          );
        }
        if (allow404 && res.status === 404) return null;
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await sleep(700 * (attempt + 1));
          continue;
        }
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`OneDrive API 错误 (${res.status}): ${txt.slice(0, 220)}`);
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (err?.code === 'AUTH_EXPIRED' || String(err?.message || '').includes('OneDrive API 错误 (4')) {
          throw err;
        }
        if (attempt < 2) {
          appLog.warn('OneDrive', `Graph 请求波动，第 ${attempt + 1} 次重试: ${err?.message || err}`);
          await sleep(800 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('OneDrive 网络请求失败');
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
    try {
      await this._graphFetch(createEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: folderName,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'fail'
        })
      });
    } catch (err) {
      // 409 Conflict means another device created the folder concurrently — safe to continue
      if (!String(err?.message || '').includes('(409)')) throw err;
    }
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

  _preferLocalProxy() {
    const h = window.location.hostname;
    return (
      h === 'appassets.androidplatform.net' ||
      h === 'localhost' ||
      h === '127.0.0.1' ||
      /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      Boolean(this._hasLocalProxy)
    );
  }

  async _fetchDownloadUrl(downloadUrl) {
    const proxyUrl = `/api/onedrive-proxy?url=${encodeURIComponent(downloadUrl)}`;
    const tryProxy = async () => {
      const pRes = await fetch(proxyUrl, { cache: 'no-store' });
      if (!pRes.ok) {
        throw new Error(`OneDrive 代理读取失败 (${pRes.status})`);
      }
      this._hasLocalProxy = true;
      return pRes;
    };

    // On Android APK (WebViewAssetLoader) and Desktop Companion (clouddrop.py),
    // go straight through the same-origin local proxy to bypass OneDrive Personal's missing CORS headers.
    if (this._preferLocalProxy()) {
      try {
        return await tryProxy();
      } catch {
        // Fallback to direct fetch if static localhost server without proxy
      }
    }

    try {
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error(`OneDrive 下载失败 (${res.status})`);
      return res;
    } catch (directErr) {
      try {
        return await tryProxy();
      } catch {
        throw new Error(
          `OneDrive 个人版内容域未开放浏览器跨域(CORS)，请使用桌面端或 Android APK 客户端读取 (${directErr?.message || 'CORS'})`
        );
      }
    }
  }

  async readMeta() {
    await this.ensureWorkspace();
    const res = await this._graphFetch('/me/drive/root:/CloudDrop/meta.json', {}, true);
    if (!res) return null;
    const meta = await res.json();
    if (meta.description && meta.description.trim().startsWith('{')) {
      try {
        return JSON.parse(meta.description);
      } catch {
        // fallback to file download
      }
    }
    const dlUrl = meta['@microsoft.graph.downloadUrl'];
    if (!dlUrl) return null;
    const fileRes = await this._fetchDownloadUrl(dlUrl);
    return fileRes.json();
  }

  async writeMeta(meta) {
    await this.ensureWorkspace();
    const jsonStr = JSON.stringify(meta, null, 2);
    const res = await this._graphFetch('/me/drive/root:/CloudDrop/meta.json:/content', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: jsonStr
    });
    const saved = await res.json().catch(() => null);
    if (saved?.id && jsonStr.length <= 3500) {
      this._graphFetch(`/me/drive/items/${encodeURIComponent(saved.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: jsonStr })
      }).catch(() => {});
    }
  }

  async listEvents() {
    await this.ensureWorkspace();
    const events = [];
    // Omit $select so Graph returns full driveItem including description & @microsoft.graph.downloadUrl
    let url = '/me/drive/root:/CloudDrop/events:/children?$top=200';
    while (url) {
      const res = await this._graphFetch(url, {}, true);
      if (!res) break;
      const data = await res.json();
      for (const f of data.value || []) {
        let inlineData = null;
        if (typeof f.description === 'string' && f.description.trim().startsWith('{')) {
          try {
            inlineData = JSON.parse(f.description);
          } catch {
            inlineData = null;
          }
        }
        events.push({
          remoteId: f.id,
          name: f.name,
          modifiedTime: f.lastModifiedDateTime,
          downloadUrl: f['@microsoft.graph.downloadUrl'] || null,
          inlineData
        });
      }
      url = data['@odata.nextLink'] || null;
    }
    return { events, nextToken: null };
  }

  async downloadEventJson(remoteId, downloadUrl = null) {
    let url = downloadUrl;
    if (!url) {
      const metaRes = await this._graphFetch(`/me/drive/items/${encodeURIComponent(remoteId)}`);
      const meta = await metaRes.json();
      if (typeof meta.description === 'string' && meta.description.trim().startsWith('{')) {
        try {
          return JSON.parse(meta.description);
        } catch {
          // continue to downloadUrl
        }
      }
      url = meta['@microsoft.graph.downloadUrl'];
    }
    if (!url) {
      throw new Error('OneDrive 未返回事件文件的下载链接');
    }
    const res = await this._fetchDownloadUrl(url);
    return res.json();
  }

  async uploadEventJson(filename, obj) {
    await this.ensureWorkspace();
    const jsonStr = JSON.stringify(obj);
    const res = await this._graphFetch(
      `/me/drive/root:/CloudDrop/events/${encodeURIComponent(filename)}:/content`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: jsonStr
      }
    );
    const data = await res.json();
    // Mirror compact event JSON into driveItem.description (served directly by graph.microsoft.com with full CORS!)
    // so even pure static web browsers / PWAs without local proxy can sync messages with 0 extra requests.
    if (data?.id && jsonStr.length <= 3500) {
      this._graphFetch(`/me/drive/items/${encodeURIComponent(data.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: jsonStr })
      }).catch(() => {});
    }
    return { remoteId: data.id };
  }

  async _putUploadChunk({ uploadUrl, chunk, offset, totalSize, transport, onProgress }) {
    const end = offset + chunk.size;
    const contentRange = `bytes ${offset}-${end - 1}/${totalSize}`;
    const basePct = Math.min(99, Math.max(1, Math.round((offset / totalSize) * 100)));

    // Keep sync heartbeat alive while local-proxy or Android native bridge forwards a large chunk upstream
    let heartbeat = null;
    if (transport !== 'direct' && onProgress) {
      heartbeat = setInterval(() => {
        onProgress(basePct, '');
      }, 10000);
    }

    try {
      if (transport === 'android-bridge') {
        const buf = await chunk.arrayBuffer();
        const b64 = bytesToBase64(new Uint8Array(buf));
        const res = await callNativeAsync(
          (reqId) => window.AndroidBridge.putUploadChunkAsync(reqId, uploadUrl, contentRange, b64),
          CHUNK_INACTIVITY_TIMEOUT_MS + 15000
        );
        if (!res || (!res.status && res.error)) {
          const err = new Error(res?.error || 'Android 原生分片上传网络中断');
          err.isNetworkError = true;
          throw err;
        }
        let parsed = null;
        if (res.body) {
          try {
            parsed = JSON.parse(res.body);
          } catch {
            parsed = null;
          }
        }
        if (res.status === 200 || res.status === 201 || res.status === 202) {
          return { status: res.status, data: parsed };
        }
        const err = new Error(`HTTP ${res.status}: ${String(res.body || res.error || '').slice(0, 220)}`);
        err.status = res.status;
        err.retryAfter = Number(res.retryAfter) > 0 ? Number(res.retryAfter) : null;
        throw err;
      }

      const targetUrl =
        transport === 'local-proxy'
          ? `/api/onedrive-upload-proxy?url=${encodeURIComponent(uploadUrl)}`
          : uploadUrl;

      return await xhrUpload({
        method: 'PUT',
        url: targetUrl,
        headers: { 'Content-Range': contentRange },
        body: chunk,
        acceptStatuses: [200, 201, 202],
        inactivityTimeoutMs: CHUNK_INACTIVITY_TIMEOUT_MS,
        onProgress: (_, loaded) => {
          if (!onProgress) return;
          // On local-proxy, XHR measures localhost upload speed; cap intra-chunk progress at 50%
          // until OneDrive upstream actually acknowledges the chunk.
          const effectiveLoaded = transport === 'local-proxy' ? loaded * 0.5 : loaded;
          const pct = Math.min(99, Math.max(1, Math.round(((offset + effectiveLoaded) / totalSize) * 100)));
          onProgress(pct, '');
        }
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  async _queryUploadSession(uploadUrl, transport) {
    try {
      if (
        transport === 'android-bridge' &&
        typeof window !== 'undefined' &&
        typeof window.AndroidBridge?.queryUploadSessionAsync === 'function'
      ) {
        const res = await callNativeAsync(
          (reqId) => window.AndroidBridge.queryUploadSessionAsync(reqId, uploadUrl),
          30000
        );
        if (res?.status === 404) return { expired: true };
        if (res?.status >= 200 && res?.status < 300 && res.body) {
          const data = JSON.parse(res.body);
          return { expired: false, nextOffset: parseNextExpectedOffset(data), data };
        }
        return null;
      }

      const proxyUrl = `/api/onedrive-proxy?url=${encodeURIComponent(uploadUrl)}`;
      let res = null;
      if (transport === 'local-proxy') {
        res = await fetchWithTimeout(proxyUrl, { cache: 'no-store' }, 25000);
      } else {
        try {
          res = await fetchWithTimeout(uploadUrl, { cache: 'no-store' }, 20000);
        } catch {
          if (this._preferLocalProxy()) {
            res = await fetchWithTimeout(proxyUrl, { cache: 'no-store' }, 25000);
          }
        }
      }
      if (!res) return null;
      if (res.status === 404) return { expired: true };
      if (!res.ok) return null;
      const data = await res.json();
      return { expired: false, nextOffset: parseNextExpectedOffset(data), data };
    } catch {
      return null;
    }
  }

  async _lookupUploadedItem(safeEnc, expectedSize) {
    try {
      const res = await this._graphFetch(`/me/drive/root:/CloudDrop/files/${safeEnc}`, {}, true);
      if (!res) return null;
      const item = await res.json();
      if (item?.id && (!expectedSize || Number(item.size) === expectedSize)) {
        return item;
      }
      return null;
    } catch {
      return null;
    }
  }

  async uploadFileBlob(filename, blob, mimeType, onProgress) {
    await this.ensureWorkspace();
    const safeEnc = encodeURIComponent(filename);

    if (blob.size <= SIMPLE_LIMIT) {
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const token = await this._ensureToken();
          const res = await xhrUpload({
            method: 'PUT',
            url: `${GRAPH_API}/me/drive/root:/CloudDrop/files/${safeEnc}:/content`,
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': mimeType || 'application/octet-stream'
            },
            body: blob,
            inactivityTimeoutMs: CHUNK_INACTIVITY_TIMEOUT_MS,
            onProgress: (pct) => onProgress?.(pct, '')
          });
          return { remoteId: res.data?.id || filename, size: blob.size };
        } catch (err) {
          lastErr = err;
          const retryable = err?.isNetworkError || err?.status === 429 || (err?.status >= 500 && err?.status < 600);
          if (!retryable || attempt >= 3) throw err;
          onProgress?.(5, `重试 ${attempt}/2`);
          await sleep(1200 * attempt);
        }
      }
      throw lastErr;
    }

    // Microsoft Graph Resumable Upload Session for > 4 MB files (with chunk retry, range resume & CORS fallback)
    const hasAndroidBridge =
      typeof window !== 'undefined' && typeof window.AndroidBridge?.putUploadChunkAsync === 'function';
    const isAndroidWebView = typeof window !== 'undefined' && window.location.hostname === 'appassets.androidplatform.net';
    let transport = 'direct';
    let realignCount = 0;

    for (let sessionAttempt = 0; sessionAttempt < 2; sessionAttempt++) {
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

      appLog.info(
        'OneDrive',
        `创建大文件分片上传会话: ${filename} (${formatBytes(blob.size)})${sessionAttempt > 0 ? ' [重建会话]' : ''}`
      );

      let offset = 0;
      let finalItem = null;
      let sessionExpired = false;
      let lastMilestone = 0;

      while (offset < blob.size) {
        const chunkSize = transport === 'android-bridge' ? ANDROID_BRIDGE_CHUNK_SIZE : DESKTOP_CHUNK_SIZE;
        const end = Math.min(offset + chunkSize, blob.size);
        const chunk = blob.slice(offset, end);
        let chunkRestart = false;

        for (let attempt = 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
          try {
            const putRes = await this._putUploadChunk({
              uploadUrl,
              chunk,
              offset,
              totalSize: blob.size,
              transport,
              onProgress
            });

            if (putRes.status === 200 || putRes.status === 201) {
              finalItem = putRes.data;
              offset = blob.size;
              onProgress?.(100, '');
              break;
            }

            // 202 Accepted — advance to server-confirmed offset
            const serverNext = parseNextExpectedOffset(putRes.data);
            offset = serverNext !== null && serverNext >= end ? serverNext : end;
            const pct = Math.min(99, Math.round((offset / blob.size) * 100));
            onProgress?.(pct, '');
            const milestone = Math.floor(pct / 25) * 25;
            if (milestone >= 25 && milestone > lastMilestone) {
              lastMilestone = milestone;
              appLog.info('OneDrive', `大文件上传进度 ${pct}% (${formatBytes(offset)} / ${formatBytes(blob.size)})`);
            }
            break;
          } catch (err) {
            // Transparently switch away from direct PUT if WebView / browser hits CORS block
            if (err?.isNetworkError && !err?.isTimeout && transport === 'direct') {
              if (hasAndroidBridge) {
                transport = 'android-bridge';
                appLog.info('OneDrive', '直连分片受限，已自动切换至 Android 原生通道续传');
                chunkRestart = true;
                break;
              }
              if (!isAndroidWebView && this._preferLocalProxy()) {
                transport = 'local-proxy';
                appLog.info('OneDrive', '直连分片受限，已自动切换至桌面本地代理续传');
                attempt--;
                continue;
              }
            }

            if (err?.status === 404) {
              const finished = await this._lookupUploadedItem(safeEnc, blob.size);
              if (finished?.id) {
                onProgress?.(100, '');
                return { remoteId: finished.id, size: blob.size };
              }
              sessionExpired = true;
              break;
            }

            const retryable =
              err?.isNetworkError ||
              err?.isTimeout ||
              err?.status === 408 ||
              err?.status === 409 ||
              err?.status === 416 ||
              err?.status === 429 ||
              (err?.status >= 500 && err?.status < 600);

            if (retryable && attempt < MAX_CHUNK_RETRIES) {
              const pct = Math.min(99, Math.max(1, Math.round((offset / blob.size) * 100)));
              const sessStatus = await this._queryUploadSession(uploadUrl, transport);
              if (sessStatus?.expired) {
                const finished = await this._lookupUploadedItem(safeEnc, blob.size);
                if (finished?.id) {
                  onProgress?.(100, '');
                  return { remoteId: finished.id, size: blob.size };
                }
                sessionExpired = true;
                break;
              }
              if (sessStatus && Number.isFinite(sessStatus.nextOffset)) {
                if (sessStatus.nextOffset >= blob.size) {
                  const finished = await this._lookupUploadedItem(safeEnc, blob.size);
                  if (finished?.id) {
                    onProgress?.(100, '');
                    return { remoteId: finished.id, size: blob.size };
                  }
                }
                if (sessStatus.nextOffset !== offset && realignCount < 10) {
                  realignCount++;
                  appLog.info(
                    'OneDrive',
                    `断点续传对齐偏移量: ${formatBytes(offset)} -> ${formatBytes(sessStatus.nextOffset)}`
                  );
                  offset = sessStatus.nextOffset;
                  onProgress?.(Math.min(99, Math.round((offset / blob.size) * 100)), '');
                  chunkRestart = true;
                  break;
                }
              }

              const waitMs = err?.retryAfter
                ? Math.min(30000, Math.max(1000, err.retryAfter * 1000))
                : Math.min(12000, 1500 * attempt);
              onProgress?.(pct, `重试 ${attempt}/${MAX_CHUNK_RETRIES - 1}`);
              appLog.warn(
                'OneDrive',
                `分片 ${formatBytes(offset)}-${formatBytes(end)} 上传受阻 (${err?.status ? `HTTP ${err.status}` : err?.message || '网络波动'})，${Math.round(waitMs / 1000)}s 后重试`
              );
              await sleep(waitMs);
              continue;
            }

            const failPct = Math.round((offset / blob.size) * 100);
            throw new Error(
              `OneDrive 分片上传失败 (已传 ${failPct}%，${err?.status ? `HTTP ${err.status}` : err?.message || '网络异常'})`
            );
          }
        }

        if (sessionExpired) break;
        if (chunkRestart) continue;
      }

      if (sessionExpired && sessionAttempt === 0) {
        appLog.warn('OneDrive', '上传会话已失效，正在重建上传会话重新上传');
        continue;
      }

      if (!finalItem?.id) {
        finalItem = await this._lookupUploadedItem(safeEnc, blob.size);
      }
      return { remoteId: finalItem?.id || filename, size: blob.size };
    }

    throw new Error('OneDrive 上传会话多次失效，请检查网络后重试');
  }

  async downloadFileBlob(remoteId, onProgress) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const metaRes = await this._graphFetch(`/me/drive/items/${encodeURIComponent(remoteId)}`);
        const meta = await metaRes.json();
        const dlUrl = meta['@microsoft.graph.downloadUrl'];
        if (!dlUrl) {
          throw new Error('OneDrive 未返回文件下载链接');
        }
        const proxyUrl = `/api/onedrive-proxy?url=${encodeURIComponent(dlUrl)}`;
        if (this._preferLocalProxy()) {
          try {
            return await xhrDownloadBlob({ url: proxyUrl, onProgress, inactivityTimeoutMs: 120000 });
          } catch {
            // fallback to direct
          }
        }
        try {
          return await xhrDownloadBlob({ url: dlUrl, onProgress, inactivityTimeoutMs: 120000 });
        } catch {
          return await xhrDownloadBlob({ url: proxyUrl, onProgress, inactivityTimeoutMs: 120000 });
        }
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          appLog.warn('OneDrive', `文件下载中断，正在重新获取链接重试: ${err?.message || err}`);
          onProgress?.(2, '重试中');
          await sleep(1200);
        }
      }
    }
    throw lastErr;
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
