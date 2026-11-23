// Frontend structured runtime diagnostics logger
// Captures sync/cloud/network events + global uncaught errors, redacting tokens/secrets automatically.

const STORAGE_KEY = 'clouddrop_runtime_logs_v1';
const MAX_ENTRIES = 400;

function redact(text) {
  return String(text || '')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-~+/=]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|code|sig|authkey|token)=)[^&\s]+/gi, '$1[REDACTED]');
}

function formatNow() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

class AppLogger {
  constructor() {
    this.entries = [];
    this.listeners = new Set();
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) this.entries = JSON.parse(saved).slice(-MAX_ENTRIES);
    } catch {
      this.entries = [];
    }
    this._hookGlobalErrors();
  }

  _hookGlobalErrors() {
    window.addEventListener('error', (ev) => {
      this.error('Window', `${ev.message || 'Uncaught error'} (${ev.filename || ''}:${ev.lineno || 0})`);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev.reason?.message || String(ev.reason || 'Unhandled promise rejection');
      this.error('Promise', reason);
    });
  }

  _push(level, scope, message) {
    const entry = {
      time: formatNow(),
      level,
      scope: String(scope || 'App'),
      message: redact(message)
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    } catch {
      // ignore storage limit
    }
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        // ignore listener failure
      }
    }
  }

  info(scope, message) {
    this._push('INFO', scope, message);
  }

  warn(scope, message) {
    this._push('WARN', scope, message);
  }

  error(scope, message) {
    this._push('ERROR', scope, message);
  }

  getEntries(filter = 'all') {
    if (filter === 'error') {
      return this.entries.filter((e) => e.level === 'ERROR' || e.level === 'WARN');
    }
    return this.entries;
  }

  clear() {
    this.entries = [];
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    this._push('INFO', 'Logger', '前端运行日志已清空');
  }

  formatPlainText(extraBackendLines = []) {
    const front = this.entries.map((e) => `${e.time} [${e.level}] [${e.scope}] ${e.message}`);
    const parts = [
      `=== CloudDrop 运行日志导出 (${new Date().toLocaleString()}) ===`,
      `UA: ${navigator.userAgent}`,
      `URL: ${window.location.href}`,
      '',
      '--- 前端日志 ---',
      ...(front.length ? front : ['(暂无记录)'])
    ];
    if (extraBackendLines.length) {
      parts.push('', '--- 桌面伴侣后端日志 ---', ...extraBackendLines);
    }
    return parts.join('\n');
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const appLog = new AppLogger();

// Shared one-click diagnostic log exporter (works on Desktop, Web, and Android APK)
export async function exportDiagnosticLogs() {
  let backendLines = [];
  try {
    const res = await fetch('/api/logs?tail=400', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.lines)) {
        backendLines = data.lines;
      }
    }
  } catch {
    // static web/APK without desktop companion
  }

  const text = appLog.formatPlainText(backendLines);
  const fileName = `clouddrop-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;

  // Inside Android APK, save directly to Downloads/CloudDrop/
  if (window.AndroidBridge && typeof window.AndroidBridge.saveFile === 'function') {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const ok = window.AndroidBridge.saveFile(fileName, 'text/plain', btoa(binary));
    if (ok) return true;
  }

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}
