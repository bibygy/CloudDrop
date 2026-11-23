// Minimalist non-intrusive toast notifications with 1-click log download on errors

import { appLog, exportDiagnosticLogs } from './logger.js';

let stackEl = null;

function ensureStack() {
  if (!stackEl) {
    stackEl = document.getElementById('toast-stack');
    if (!stackEl) {
      stackEl = document.createElement('div');
      stackEl.id = 'toast-stack';
      stackEl.className = 'toast-stack';
      document.body.appendChild(stackEl);
    }
  }
  return stackEl;
}

export function showToast(message, type = 'info', durationMs = null) {
  const stack = ensureStack();
  const effectiveDuration = durationMs !== null ? durationMs : type === 'error' ? 6000 : 2600;

  if (type === 'error') {
    appLog.error('Toast', message);
  }

  const el = document.createElement('div');
  el.className = `toast ${type}`;

  const msgSpan = document.createElement('div');
  msgSpan.className = 'toast-msg';
  msgSpan.textContent = message;
  el.appendChild(msgSpan);

  const dismiss = () => {
    if (!el.isConnected) return;
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    el.style.transition = 'opacity 160ms, transform 160ms';
    setTimeout(() => el.remove(), 180);
  };

  if (type === 'error') {
    const actions = document.createElement('div');
    actions.className = 'toast-actions';

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'toast-action-btn';
    dlBtn.textContent = '下载日志';
    dlBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await exportDiagnosticLogs();
        dlBtn.textContent = '已导出';
      } catch {
        dlBtn.textContent = '导出失败';
      }
    });
    actions.appendChild(dlBtn);
    el.appendChild(actions);
  }

  stack.appendChild(el);

  el.addEventListener('click', dismiss);
  if (effectiveDuration > 0) {
    setTimeout(dismiss, effectiveDuration);
  }
  return dismiss;
}
