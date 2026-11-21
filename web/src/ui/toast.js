// Minimalist non-intrusive toast notifications

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

export function showToast(message, type = 'info', durationMs = 2800) {
  const stack = ensureStack();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  stack.appendChild(el);

  const dismiss = () => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    el.style.transition = 'opacity 160ms, transform 160ms';
    setTimeout(() => el.remove(), 180);
  };

  el.addEventListener('click', dismiss);
  if (durationMs > 0) {
    setTimeout(dismiss, durationMs);
  }
  return dismiss;
}
