// CloudDrop Main Application Entrypoint

import { store } from './state/store.js';
import { syncEngine } from './sync/engine.js';
import { ICONS } from './ui/icons.js';
import { formatBytes } from './providers/base.js';
import { escapeHtml } from './ui/markdown.js';
import { showToast } from './ui/toast.js';
import {
  bindStreamEvents,
  closeLightbox,
  initLightboxEvents,
  renderChrome,
  renderStream,
  updateTransferProgressDom
} from './ui/render.js';
import { closeSettingsModal, initSettingsModal, openSettingsModal } from './ui/modals.js';

let stagedFiles = []; // Array<{ file: File, thumbUrl: string | null }>

function updateComposerState() {
  const input = document.getElementById('composer-input');
  const sendBtn = document.getElementById('btn-send');
  const hint = document.getElementById('composer-hint');
  if (!input || !sendBtn) return;

  const hasContent = input.value.trim().length > 0 || stagedFiles.length > 0;
  sendBtn.disabled = !hasContent;

  if (hint) {
    hint.textContent = store.settings.enterToSend ? 'Enter 发送 · Shift+Enter 换行' : 'Ctrl+Enter 发送';
  }
}

function autoResizeTextarea(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  const h = Math.min(200, Math.max(44, ta.scrollHeight));
  ta.style.height = `${h}px`;
  ta.style.overflowY = ta.scrollHeight > 200 ? 'auto' : 'hidden';
}

function renderStagedFiles() {
  const container = document.getElementById('staged-files');
  if (!container) return;

  container.innerHTML = stagedFiles
    .map(
      (entry, idx) => `
      <div class="staged-chip">
        ${
          entry.thumbUrl
            ? `<img class="staged-thumb" src="${entry.thumbUrl}" alt="" />`
            : `<span style="color:var(--dsw-alias-accent);display:flex">${ICONS.file}</span>`
        }
        <span class="staged-name" title="${escapeHtml(entry.file.name)}">${escapeHtml(entry.file.name)}</span>
        <span class="staged-size">${formatBytes(entry.file.size)}</span>
        <button class="staged-remove" type="button" data-remove-staged="${idx}" aria-label="移除">${ICONS.x}</button>
      </div>`
    )
    .join('');

  container.querySelectorAll('[data-remove-staged]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.getAttribute('data-remove-staged'));
      const removed = stagedFiles.splice(i, 1)[0];
      if (removed?.thumbUrl) URL.revokeObjectURL(removed.thumbUrl);
      renderStagedFiles();
      updateComposerState();
    });
  });

  updateComposerState();
}

function addFilesToStage(fileList) {
  const arr = Array.from(fileList || []).filter((f) => f && typeof f.size === 'number');
  if (!arr.length) return;
  for (const file of arr) {
    const thumbUrl = (file.type || '').startsWith('image/') ? URL.createObjectURL(file) : null;
    stagedFiles.push({ file, thumbUrl });
  }
  renderStagedFiles();
}

function clearStagedFiles() {
  for (const entry of stagedFiles) {
    if (entry.thumbUrl) URL.revokeObjectURL(entry.thumbUrl);
  }
  stagedFiles = [];
  renderStagedFiles();
}

async function handleSend() {
  const input = document.getElementById('composer-input');
  const text = input ? input.value.trim() : '';
  const files = stagedFiles.map((s) => s.file);
  if (!text && files.length === 0) return;

  if (input) {
    input.value = '';
    autoResizeTextarea(input);
  }
  clearStagedFiles();

  await syncEngine.createDrop({ text, files });
  renderStream({ scrollToBottom: true });
}

function toggleDrawer(force) {
  const shell = document.getElementById('app-shell');
  if (!shell) return;
  const isCompactOrMobile = shell.classList.contains('compact-mode') || window.innerWidth <= 860;
  if (isCompactOrMobile) {
    shell.classList.toggle('drawer-open', typeof force === 'boolean' ? force : !shell.classList.contains('drawer-open'));
  } else {
    shell.classList.toggle('sidebar-collapsed', typeof force === 'boolean' ? !force : !shell.classList.contains('sidebar-collapsed'));
  }
}

function cycleTheme() {
  const order = ['light', 'dark', 'system'];
  const idx = order.indexOf(store.settings.theme || 'system');
  const next = order[(idx + 1) % order.length];
  store.updateSettings({ theme: next });
  const labels = { light: '浅色主题', dark: '深色主题', system: '跟随系统主题' };
  showToast(`已切换至${labels[next]}`, 'info', 1500);
}

// Handle incoming Android PWA Web Share Target payload stashed by sw.js
async function consumePendingWebShare() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('share') !== 'pending') return;
  history.replaceState(null, '', window.location.pathname);

  if (!('caches' in window)) return;
  try {
    const shareCache = await caches.open('clouddrop-share-inbox');
    const metaResp = await shareCache.match('./__shared_meta');
    if (!metaResp) return;
    const meta = await metaResp.json();

    const parts = [meta.title, meta.text, meta.url].filter(Boolean);
    const sharedText = parts.join('\n').trim();
    const sharedFiles = [];

    for (const fmeta of meta.files || []) {
      const fResp = await shareCache.match(fmeta.key);
      if (fResp) {
        const blob = await fResp.blob();
        sharedFiles.push(new File([blob], fmeta.name, { type: fmeta.type || blob.type }));
        await shareCache.delete(fmeta.key);
      }
    }
    await shareCache.delete('./__shared_meta');

    if (sharedText || sharedFiles.length > 0) {
      await syncEngine.createDrop({ text: sharedText, files: sharedFiles });
      showToast('已接收来自系统分享的内容', 'success');
      renderStream({ scrollToBottom: true });
    }
  } catch (err) {
    console.warn('[ShareTarget]', err);
  }
}

// Native Android WebView bridge for ACTION_SEND / ACTION_SEND_MULTIPLE
window.__CLOUDDROP_NATIVE_SHARE__ = async (payload) => {
  try {
    const text = payload?.text || '';
    const files = [];
    for (const f of payload?.files || []) {
      const bin = atob(f.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      files.push(new File([bytes], f.name || 'shared_file', { type: f.mimeType || 'application/octet-stream' }));
    }
    if (text || files.length) {
      await syncEngine.createDrop({ text, files });
      showToast('已接收来自 Android 的分享', 'success');
      renderStream({ scrollToBottom: true });
    }
  } catch (err) {
    showToast(`接收分享失败: ${err.message}`, 'error');
  }
};

function bindGlobalUiEvents() {
  // Inject icons into static buttons
  const setIcon = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };
  setIcon('btn-toggle-sidebar', ICONS.sidebar);
  setIcon('btn-sync', ICONS.sync);
  setIcon('btn-compact', ICONS.panelRight);
  setIcon('btn-settings-top', ICONS.settings);
  setIcon('btn-logs-side', ICONS.terminal);
  setIcon('btn-settings-side', ICONS.settings);
  setIcon('btn-attach', ICONS.paperclip);
  setIcon('btn-paste', ICONS.clipboard);
  setIcon('btn-code-snip', ICONS.code);
  setIcon('btn-add-tag', ICONS.hash);
  setIcon('btn-send-icon', ICONS.send);
  setIcon('search-icon-slot', ICONS.search);
  setIcon('search-clear', ICONS.x);
  setIcon('settings-close', ICONS.x);
  setIcon('drop-overlay-icon', ICONS.upload);

  // Sidebar & Drawer toggling
  document.getElementById('btn-toggle-sidebar')?.addEventListener('click', () => toggleDrawer());
  document.getElementById('sidebar-scrim')?.addEventListener('click', () => toggleDrawer(false));

  // Cloud status card -> open Cloud settings
  document.getElementById('cloud-status-card')?.addEventListener('click', () => {
    toggleDrawer(false);
    openSettingsModal('cloud');
  });

  // E2EE badge -> open E2EE tab
  document.getElementById('e2ee-badge')?.addEventListener('click', () => openSettingsModal('e2ee'));

  // Settings & Logs buttons
  document.getElementById('btn-settings-top')?.addEventListener('click', () => openSettingsModal('cloud'));
  document.getElementById('btn-logs-side')?.addEventListener('click', () => {
    toggleDrawer(false);
    openSettingsModal('logs');
  });
  document.getElementById('btn-settings-side')?.addEventListener('click', () => {
    toggleDrawer(false);
    openSettingsModal('appearance');
  });

  // Theme cycle & Compact side-panel toggle
  document.getElementById('btn-theme')?.addEventListener('click', cycleTheme);
  document.getElementById('btn-compact')?.addEventListener('click', () => {
    const next = !store.settings.compactMode;
    store.updateSettings({ compactMode: next });
    showToast(next ? '已切换至 Edge Drop 窄侧栏模式' : '已切换至宽屏工作台模式', 'info', 1600);
  });

  // Manual Sync button
  document.getElementById('btn-sync')?.addEventListener('click', async () => {
    const p = syncEngine.getActiveProvider();
    if (!p.isConnected()) {
      openSettingsModal('cloud');
      return;
    }
    try {
      const res = await syncEngine.syncNow({ silent: false });
      if (res?.ok && !res.skipped) {
        const msg =
          res.pulled || res.pushed
            ? `同步完成：上传 ${res.pushed} 条，拉取 ${res.pulled} 条`
            : '已是最新状态';
        showToast(msg, 'success', 1800);
      }
    } catch (err) {
      showToast(err.message || '同步失败', 'error', 3600);
    }
  });

  // Sidebar filter delegation
  const handleFilterClick = (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    store.setFilter(btn.getAttribute('data-filter'));
    toggleDrawer(false);
  };
  document.getElementById('filter-nav')?.addEventListener('click', handleFilterClick);
  document.getElementById('compact-tabs')?.addEventListener('click', handleFilterClick);

  document.getElementById('device-nav')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-device]');
    if (!btn) return;
    store.setDeviceFilter(btn.getAttribute('data-device'));
    toggleDrawer(false);
  });

  // Search box
  const searchInput = document.getElementById('search-input');
  const searchBox = document.getElementById('search-box');
  const searchClear = document.getElementById('search-clear');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      store.setSearchQuery(searchInput.value);
      searchBox?.classList.toggle('has-query', searchInput.value.length > 0);
    });
  }
  searchClear?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    store.setSearchQuery('');
    searchBox?.classList.remove('has-query');
    searchInput?.focus();
  });

  // Composer wiring
  const composerInput = document.getElementById('composer-input');
  const filePicker = document.getElementById('file-picker');

  if (composerInput) {
    composerInput.addEventListener('input', () => {
      autoResizeTextarea(composerInput);
      updateComposerState();
    });
    composerInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        const sendByEnter = store.settings.enterToSend && !e.shiftKey && !e.ctrlKey && !e.metaKey;
        const sendByCtrl = (e.ctrlKey || e.metaKey);
        if (sendByEnter || sendByCtrl) {
          e.preventDefault();
          handleSend();
        }
      }
    });
  }

  document.getElementById('btn-send')?.addEventListener('click', handleSend);
  document.getElementById('btn-attach')?.addEventListener('click', () => filePicker?.click());
  filePicker?.addEventListener('change', () => {
    if (filePicker.files?.length) {
      addFilesToStage(filePicker.files);
      composerInput?.focus();
    }
    filePicker.value = '';
  });

  // Quick insert code block
  document.getElementById('btn-code-snip')?.addEventListener('click', () => {
    if (!composerInput) return;
    const prefix = composerInput.value && !composerInput.value.endsWith('\n') ? '\n' : '';
    composerInput.value += `${prefix}\`\`\`\n\n\`\`\``;
    const pos = composerInput.value.length - 4;
    composerInput.focus();
    composerInput.setSelectionRange(pos, pos);
    autoResizeTextarea(composerInput);
    updateComposerState();
  });

  // Quick insert tag
  document.getElementById('btn-add-tag')?.addEventListener('click', () => {
    if (!composerInput) return;
    const sep = composerInput.value && !composerInput.value.endsWith(' ') ? ' ' : '';
    composerInput.value += `${sep}#`;
    composerInput.focus();
    autoResizeTextarea(composerInput);
    updateComposerState();
  });

  // Clipboard paste button (reads images or text)
  document.getElementById('btn-paste')?.addEventListener('click', async () => {
    try {
      if (navigator.clipboard?.read) {
        const clipItems = await navigator.clipboard.read();
        const files = [];
        for (const ci of clipItems) {
          const imgType = ci.types.find((t) => t.startsWith('image/'));
          if (imgType) {
            const blob = await ci.getType(imgType);
            const ext = imgType.split('/')[1] || 'png';
            files.push(new File([blob], `screenshot_${Date.now()}.${ext}`, { type: imgType }));
          }
        }
        if (files.length) {
          addFilesToStage(files);
          showToast('已从剪贴板粘贴图片', 'success', 1600);
          return;
        }
      }
      if (navigator.clipboard?.readText) {
        const txt = await navigator.clipboard.readText();
        if (txt && composerInput) {
          composerInput.value += txt;
          autoResizeTextarea(composerInput);
          updateComposerState();
          composerInput.focus();
          return;
        }
      }
      showToast('剪贴板为空，或请直接按 Ctrl+V 粘贴', 'info');
    } catch {
      showToast('请直接在输入框中按 Ctrl+V 粘贴截图或文字', 'info');
    }
  });

  // Global Ctrl+V paste handler (screenshots / files pasted anywhere in window!)
  window.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const pastedFiles = [];
    for (const item of dt.items || []) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) {
          const named =
            f.name && f.name !== 'image.png'
              ? f
              : new File([f], `screenshot_${Date.now()}.${(f.type.split('/')[1] || 'png')}`, { type: f.type || 'image/png' });
          pastedFiles.push(named);
        }
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      addFilesToStage(pastedFiles);
      composerInput?.focus();
      showToast(`已粘贴 ${pastedFiles.length} 个截图/文件，按 Enter 发送`, 'info', 2000);
    }
  });

  // Full-window Drag & Drop (instant Edge Drop feel!)
  const overlay = document.getElementById('drop-overlay');
  let dragDepth = 0;

  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    overlay?.classList.add('visible');
  });

  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  });

  window.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay?.classList.remove('visible');
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay?.classList.remove('visible');
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;

    // Edge Drop magic: if composer has no caption text yet, drop & send immediately!
    // If user is writing text, stage them into the composer so text + files travel together.
    if (composerInput && composerInput.value.trim().length === 0 && stagedFiles.length === 0) {
      await syncEngine.createDrop({ text: '', files });
      showToast(`已投递 ${files.length} 个文件`, 'success', 1800);
      renderStream({ scrollToBottom: true });
    } else {
      addFilesToStage(files);
      composerInput?.focus();
    }
  });

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchInput?.focus();
      searchInput?.select();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleDrawer();
    } else if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault();
      searchInput?.focus();
    } else if (e.key === 'Escape') {
      closeLightbox();
      closeSettingsModal();
      toggleDrawer(false);
      if (store.editingItemId) {
        store.editingItemId = null;
        renderStream();
      }
    }
  });

  // React to OS light/dark theme switch live when set to 'system'
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (store.settings.theme === 'system') store.applyAppearance();
  });
}

async function bootstrap() {
  // Support ?panel=1 launch flag (Edge Drop narrow side-panel mode)
  const params = new URLSearchParams(window.location.search);
  if (params.get('panel') === '1') {
    store.settings.compactMode = true;
  }

  store.applyAppearance();
  bindGlobalUiEvents();
  bindStreamEvents();
  initLightboxEvents();
  initSettingsModal();

  // Subscribe UI to store updates (targeted updates to guarantee zero flicker!)
  store.subscribe((_, reason) => {
    if (reason === 'progress') {
      updateTransferProgressDom();
      return;
    }
    renderChrome();
    if (reason !== 'sync') {
      renderStream();
    }
    updateComposerState();
  });

  renderChrome();
  renderStream();
  updateComposerState();

  await syncEngine.init();
  await consumePendingWebShare();

  renderChrome();
  renderStream({ scrollToBottom: true });

  // Register Service Worker for offline PWA + Android Web Share Target
  if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

bootstrap();
