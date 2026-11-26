// Shared CloudProvider utilities & transfer helpers

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let u = 0;
  while (val >= 1024 && u < units.length - 1) {
    val /= 1024;
    u++;
  }
  return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[u]}`;
}

export function sanitizeFileName(name) {
  const clean = String(name || 'file')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, 140) || 'file';
}

export function getAppRedirectUri() {
  const u = new URL(window.location.href);
  u.search = '';
  u.hash = '';
  // Normalize /index.html -> /
  if (u.pathname.endsWith('/index.html')) {
    u.pathname = u.pathname.slice(0, -'index.html'.length);
  }
  return u.href.replace(/\/+$/, '') || u.origin;
}

export function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function parseRetryAfterSeconds(raw) {
  if (!raw) return null;
  const num = Number(raw);
  if (Number.isFinite(num) && num >= 0) return num;
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return null;
}

export function xhrUpload({
  method = 'PUT',
  url,
  headers = {},
  body,
  onProgress,
  acceptStatuses = null,
  inactivityTimeoutMs = 90000
}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let watchdog = null;

    const clearWatchdog = () => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };

    const armWatchdog = () => {
      clearWatchdog();
      if (inactivityTimeoutMs > 0) {
        watchdog = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            xhr.abort();
          } catch {
            // ignore
          }
          const err = new Error(`上传超时：超过 ${Math.round(inactivityTimeoutMs / 1000)} 秒无数据响应`);
          err.isTimeout = true;
          err.isNetworkError = true;
          reject(err);
        }, inactivityTimeoutMs);
      }
    };

    xhr.open(method, url, true);
    for (const [k, v] of Object.entries(headers)) {
      xhr.setRequestHeader(k, v);
    }

    xhr.upload.onprogress = (ev) => {
      armWatchdog();
      if (onProgress && ev.lengthComputable && ev.total > 0) {
        onProgress(Math.min(100, Math.round((ev.loaded / ev.total) * 100)), ev.loaded, ev.total);
      }
    };

    xhr.onload = () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const ok = Array.isArray(acceptStatuses)
        ? acceptStatuses.includes(xhr.status)
        : xhr.status >= 200 && xhr.status < 300;
      if (ok) {
        let data = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = xhr.responseText;
        }
        resolve({
          status: xhr.status,
          data,
          text: xhr.responseText || '',
          headers: xhr.getAllResponseHeaders(),
          getHeader: (name) => {
            try {
              return xhr.getResponseHeader(name);
            } catch {
              return null;
            }
          }
        });
      } else {
        const err = new Error(`HTTP ${xhr.status}: ${xhr.responseText?.slice(0, 260) || xhr.statusText}`);
        err.status = xhr.status;
        err.responseText = xhr.responseText || '';
        try {
          err.retryAfter = parseRetryAfterSeconds(xhr.getResponseHeader('Retry-After'));
        } catch {
          err.retryAfter = null;
        }
        reject(err);
      }
    };

    xhr.onerror = () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const err = new Error('网络错误：上传中断');
      err.isNetworkError = true;
      reject(err);
    };

    xhr.onabort = () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const err = new Error('上传已中止');
      err.isNetworkError = true;
      reject(err);
    };

    armWatchdog();
    xhr.send(body);
  });
}

export function xhrDownloadBlob({ url, headers = {}, onProgress, inactivityTimeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let watchdog = null;

    const clearWatchdog = () => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };

    const armWatchdog = () => {
      clearWatchdog();
      if (inactivityTimeoutMs > 0) {
        watchdog = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            xhr.abort();
          } catch {
            // ignore
          }
          const err = new Error(`下载超时：超过 ${Math.round(inactivityTimeoutMs / 1000)} 秒无数据响应`);
          err.isTimeout = true;
          err.isNetworkError = true;
          reject(err);
        }, inactivityTimeoutMs);
      }
    };

    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    for (const [k, v] of Object.entries(headers)) {
      xhr.setRequestHeader(k, v);
    }
    xhr.onprogress = (ev) => {
      armWatchdog();
      if (onProgress && ev.lengthComputable && ev.total > 0) {
        onProgress(Math.min(100, Math.round((ev.loaded / ev.total) * 100)), ev.loaded, ev.total);
      }
    };
    xhr.onload = () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response);
      } else {
        const err = new Error(`下载失败 HTTP ${xhr.status}`);
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const err = new Error('网络错误：下载中断');
      err.isNetworkError = true;
      reject(err);
    };
    xhr.onabort = () => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      const err = new Error('下载已中止');
      err.isNetworkError = true;
      reject(err);
    };
    armWatchdog();
    xhr.send();
  });
}
