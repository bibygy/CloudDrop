// Universal cross-platform clipboard copy helper
// Works reliably on Android APK WebView (via native AndroidBridge), Desktop, Linux, and Mobile browsers.

export async function copyText(text) {
  const str = String(text ?? '');

  // 1. Native Android APK ClipboardManager bridge (never fails in Android WebView)
  if (window.AndroidBridge && typeof window.AndroidBridge.copyText === 'function') {
    try {
      const ok = window.AndroidBridge.copyText(str);
      if (ok) return true;
    } catch {
      // fall through to browser methods
    }
  }

  // 2. Modern Clipboard API (Desktop browsers & HTTPS PWAs)
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(str);
      return true;
    } catch {
      // fall through to legacy textarea execCommand
    }
  }

  // 3. Universal execCommand('copy') fallback (works in restricted WebViews & older browsers)
  try {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, str.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}
