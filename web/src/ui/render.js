// Reactive DOM Renderer for CloudDrop
// Clean, flicker-free rendering for sidebar, drop stream, image lazy hydration, and lightbox

import { store } from '../state/store.js';
import { syncEngine } from '../sync/engine.js';
import { ICONS, platformIcon } from './icons.js';
import { escapeHtml, renderMarkdown } from './markdown.js';
import { formatBytes } from '../providers/base.js';
import { showToast } from './toast.js';

const FILTER_LABELS = {
  all: '全部投递',
  pinned: '置顶收藏',
  note: '笔记与代码',
  image: '图片与截图',
  file: '文件传输',
  link: '网页链接'
};

function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDateLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function getExtInfo(filename, mimeType = '') {
  const parts = String(filename || '').split('.');
  const ext = parts.length > 1 ? parts.pop().slice(0, 4).toUpperCase() : 'FILE';
  const low = ext.toLowerCase();
  let cls = '';
  if (low === 'pdf') cls = 'pdf';
  else if (['zip', 'rar', '7z', 'tar', 'gz', 'xz'].includes(low)) cls = 'zip';
  else if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'md', 'txt'].includes(low)) cls = 'doc';
  else if (['mp4', 'mkv', 'mov', 'mp3', 'wav', 'flac', 'webm'].includes(low) || mimeType.startsWith('video/') || mimeType.startsWith('audio/')) cls = 'media';
  else if (['js', 'ts', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'json', 'yaml', 'yml', 'sh', 'html', 'css', 'sql'].includes(low)) cls = 'code';
  return { ext, cls };
}

// ---- Lightbox ----
let activeLightboxBlobUrl = null;
let activeLightboxName = '';

export function openLightbox(blobUrl, name) {
  const lb = document.getElementById('lightbox');
  const img = document.getElementById('lightbox-img');
  const title = document.getElementById('lightbox-title');
  if (!lb || !img) return;
  activeLightboxBlobUrl = blobUrl;
  activeLightboxName = name || 'image.png';
  img.src = blobUrl;
  img.alt = activeLightboxName;
  if (title) title.textContent = activeLightboxName;
  lb.classList.add('open');
}

export function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (lb) lb.classList.remove('open');
}

export function initLightboxEvents() {
  const lb = document.getElementById('lightbox');
  const closeBtn = document.getElementById('lightbox-close');
  const dlBtn = document.getElementById('lightbox-download');
  if (closeBtn) closeBtn.addEventListener('click', closeLightbox);
  if (lb) {
    lb.addEventListener('click', (e) => {
      if (e.target === lb || e.target.id === 'lightbox-canvas') closeLightbox();
    });
  }
  if (dlBtn) {
    dlBtn.addEventListener('click', () => {
      if (!activeLightboxBlobUrl) return;
      const a = document.createElement('a');
      a.href = activeLightboxBlobUrl;
      a.download = activeLightboxName;
      a.click();
    });
  }
}

// ---- Sidebar & Topbar Render ----
export function renderChrome() {
  const counts = store.getCounts();
  const devices = store.getDevices();
  const s = store.syncState;

  // Cloud status card
  const cloudCard = document.getElementById('cloud-status-card');
  if (cloudCard) {
    const quotaHtml =
      s.quota && s.quota.total > 0
        ? `<div class="quota-bar"><div class="quota-bar-fill" style="width:${Math.min(
            100,
            Math.round((s.quota.used / s.quota.total) * 100)
          )}%"></div></div>
           <div class="cloud-card-meta"><span>云盘空间</span><span>${formatBytes(s.quota.used)} / ${formatBytes(s.quota.total)}</span></div>`
        : '';

    const timeNote =
      s.status === 'syncing'
        ? '同步中...'
        : s.errorMessage
        ? '点击重新连接'
        : s.pendingCount > 0
        ? `${s.pendingCount} 条待同步`
        : s.lastSyncedAt
        ? `已同步 ${formatTime(s.lastSyncedAt)}`
        : '配置云盘';

    cloudCard.innerHTML = `
      <div class="cloud-card-top">
        <div class="cloud-provider-badge">
          <span class="status-dot ${escapeHtml(s.status)}"></span>
          <span>${escapeHtml(s.providerName)}</span>
        </div>
        <span style="font-size:11px;color:var(--dsw-alias-ink-tertiary)">${escapeHtml(timeNote)}</span>
      </div>
      <div class="cloud-card-meta">
        <span class="cloud-account" title="${escapeHtml(s.errorMessage || s.accountLabel)}">${escapeHtml(
          s.errorMessage || s.accountLabel
        )}</span>
      </div>
      ${quotaHtml}
    `;
  }

  // Filter nav items
  const navEl = document.getElementById('filter-nav');
  if (navEl) {
    const defs = [
      { id: 'all', icon: ICONS.inbox, label: '全部投递', count: counts.all },
      { id: 'pinned', icon: ICONS.pin, label: '置顶收藏', count: counts.pinned },
      { id: 'note', icon: ICONS.note, label: '笔记与代码', count: counts.note },
      { id: 'image', icon: ICONS.image, label: '图片与截图', count: counts.image },
      { id: 'file', icon: ICONS.file, label: '文件传输', count: counts.file },
      { id: 'link', icon: ICONS.link, label: '网页链接', count: counts.link }
    ];
    navEl.innerHTML = defs
      .map(
        (d) => `
      <button class="nav-item ${store.filter === d.id && !store.deviceFilter ? 'active' : ''}" data-filter="${d.id}" type="button">
        <span class="nav-item-left">${d.icon}<span>${d.label}</span></span>
        <span class="nav-count">${d.count}</span>
      </button>`
      )
      .join('');
  }

  // Compact / Mobile horizontal tabs
  const compactTabs = document.getElementById('compact-tabs');
  if (compactTabs) {
    const defs = [
      { id: 'all', label: `全部 (${counts.all})` },
      { id: 'pinned', label: `置顶 (${counts.pinned})` },
      { id: 'note', label: `笔记 (${counts.note})` },
      { id: 'image', label: `图片 (${counts.image})` },
      { id: 'file', label: `文件 (${counts.file})` },
      { id: 'link', label: `链接 (${counts.link})` }
    ];
    compactTabs.innerHTML = defs
      .map(
        (d) =>
          `<button class="compact-tab ${store.filter === d.id && !store.deviceFilter ? 'active' : ''}" data-filter="${d.id}" type="button">${d.label}</button>`
      )
      .join('');
  }

  // Devices list
  const devEl = document.getElementById('device-nav');
  if (devEl) {
    devEl.innerHTML = devices
      .map(
        (dev) => `
      <button class="nav-item ${store.deviceFilter === dev.deviceId ? 'active' : ''}" data-device="${escapeHtml(dev.deviceId)}" type="button">
        <span class="nav-item-left">
          ${platformIcon(dev.platform)}
          <span>${escapeHtml(dev.deviceName)}${dev.isCurrent ? ' (本机)' : ''}</span>
        </span>
        <span class="nav-count">${dev.count}</span>
      </button>`
      )
      .join('');
  }

  // Topbar view title & E2EE badge & sync button
  const titleEl = document.getElementById('view-title');
  const subEl = document.getElementById('view-subtitle');
  const filtered = store.getFilteredItems();
  if (titleEl) {
    let title = FILTER_LABELS[store.filter] || '全部投递';
    if (store.deviceFilter) {
      const d = devices.find((x) => x.deviceId === store.deviceFilter);
      title = d ? d.deviceName : title;
    }
    if (store.tagFilter) {
      title = `#${store.tagFilter}`;
    }
    titleEl.textContent = title;
  }
  if (subEl) {
    subEl.textContent = `${filtered.length} 条`;
  }

  const e2eeBadge = document.getElementById('e2ee-badge');
  if (e2eeBadge) {
    e2eeBadge.style.display = store.settings.e2eeEnabled ? 'inline-flex' : 'none';
    e2eeBadge.innerHTML = `${store.e2eeUnlocked ? ICONS.lock : ICONS.unlock}<span>${
      store.e2eeUnlocked ? 'E2EE 已开启' : '需解锁'
    }</span>`;
  }

  const syncBtn = document.getElementById('btn-sync');
  if (syncBtn) {
    syncBtn.classList.toggle('spin', s.status === 'syncing');
  }

  const compactBtn = document.getElementById('btn-compact');
  if (compactBtn) {
    compactBtn.classList.toggle('active', Boolean(store.settings.compactMode));
  }

  const themeBtn = document.getElementById('btn-theme');
  if (themeBtn) {
    const theme = store.settings.theme || 'system';
    themeBtn.innerHTML = theme === 'dark' ? ICONS.moon : theme === 'light' ? ICONS.sun : ICONS.monitor;
    themeBtn.title = `切换主题（当前：${theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统'}）`;
  }
}

// ---- Stream Cards Render ----
let lastRenderedCount = 0;

export function renderStream({ scrollToBottom = false } = {}) {
  const container = document.getElementById('stream-container');
  const viewport = document.getElementById('stream-viewport');
  if (!container || !viewport) return;

  const items = store.getFilteredItems();
  const wasNearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 90;

  if (items.length === 0) {
    const isFiltering = Boolean(store.searchQuery || store.filter !== 'all' || store.deviceFilter || store.tagFilter);
    container.innerHTML = isFiltering
      ? `
      <div class="empty-state">
        <div class="empty-icon">${ICONS.search}</div>
        <h2 class="empty-title">没有匹配的投递内容</h2>
        <p class="empty-desc">尝试清空搜索关键词或切换左侧分类筛选。</p>
        <button class="btn btn-secondary" id="btn-reset-filters" type="button">显示全部内容</button>
      </div>`
      : `
      <div class="empty-state">
        <div class="empty-icon">${ICONS.droplet}</div>
        <h2 class="empty-title">欢迎使用 CloudDrop</h2>
        <p class="empty-desc">你的三端清爽云端投递箱 — 像给自己发消息一样，在 Windows、Android 与 Linux 之间瞬间流转笔记、截图和任意文件。</p>
        <div class="empty-hints">
          <div class="hint-chip"><strong>拖放或 Ctrl+V</strong><span>直接粘贴截图、图片和任意文件</span></div>
          <div class="hint-chip"><strong>Google Drive / OneDrive</strong><span>数据直存个人云盘，无第三方服务器</span></div>
          <div class="hint-chip"><strong>Markdown 与代码</strong><span>支持代码块高亮与一键复制</span></div>
          <div class="hint-chip"><strong>Ctrl+K 秒速检索</strong><span>跨设备按文字、文件名或 #标签 搜索</span></div>
        </div>
      </div>`;
    const resetBtn = document.getElementById('btn-reset-filters');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        store.setFilter('all');
        store.setSearchQuery('');
        const si = document.getElementById('search-input');
        if (si) si.value = '';
      });
    }
    lastRenderedCount = 0;
    return;
  }

  const chunks = [];
  let prevDate = '';

  for (const item of items) {
    const dateLabel = formatDateLabel(item.createdAt);
    if (dateLabel !== prevDate) {
      chunks.push(`<div class="date-divider"><span>${escapeHtml(dateLabel)}</span></div>`);
      prevDate = dateLabel;
    }
    chunks.push(renderCardHtml(item));
  }

  container.innerHTML = chunks.join('');
  hydrateVisibleImages(container, items);

  if (scrollToBottom || (items.length > lastRenderedCount && wasNearBottom)) {
    requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
  }
  lastRenderedCount = items.length;
}

function renderCardHtml(item) {
  const isEditing = store.editingItemId === item.id;
  const atts = item.attachments || [];
  const images = atts.filter((a) => (a.mimeType || '').startsWith('image/'));
  const files = atts.filter((a) => !(a.mimeType || '').startsWith('image/'));

  const syncChip = item.pending
    ? `<span class="sync-state-chip pending" title="等待上传到云盘">${ICONS.clock}<span>待同步</span></span>`
    : `<span class="sync-state-chip synced" title="已保存">${ICONS.check}</span>`;

  const pinBadge = item.pinned ? `<span class="pin-indicator">${ICONS.pin}<span>置顶</span></span>` : '';
  const encBadge = item.encrypted ? `<span class="sync-state-chip synced" title="端到端加密">${ICONS.lock}</span>` : '';

  const bodyHtml = isEditing
    ? `
    <div class="inline-edit-wrap">
      <textarea class="inline-edit-textarea" id="inline-edit-input" data-edit-id="${escapeHtml(item.id)}">${escapeHtml(
        item.text || ''
      )}</textarea>
      <div class="inline-edit-bar">
        <button class="btn btn-secondary btn-sm" data-action="cancel-edit" type="button">取消</button>
        <button class="btn btn-primary btn-sm" data-action="save-edit" data-id="${escapeHtml(item.id)}" type="button">保存修改</button>
      </div>
    </div>`
    : item.text
    ? `<div class="drop-body">${renderMarkdown(item.text)}</div>`
    : '';

  const linksHtml =
    !isEditing && item.urls && item.urls.length > 0
      ? `<div class="link-cards">${item.urls
          .slice(0, 3)
          .map(
            (u) => `
          <a class="link-card" href="${escapeHtml(u.url)}" target="_blank" rel="noopener noreferrer">
            <div class="link-card-main">
              <div class="link-favicon">${ICONS.link}</div>
              <div class="link-info">
                <span class="link-host">${escapeHtml(u.host)}</span>
                <span class="link-url">${escapeHtml(u.url)}</span>
              </div>
            </div>
            <span style="color:var(--dsw-alias-ink-tertiary);flex-shrink:0">${ICONS.external}</span>
          </a>`
          )
          .join('')}</div>`
      : '';

  const imagesHtml =
    images.length > 0
      ? `<div class="image-grid ${images.length === 1 ? 'single' : ''}">${images
          .map((img) => {
            const prog = store.transferProgress.get(img.fileId);
            const cachedUrl = syncEngine.blobUrlCache.get(img.fileId);
            return `
            <div class="image-tile" data-image-id="${escapeHtml(img.fileId)}" data-image-name="${escapeHtml(img.name)}" data-item-id="${escapeHtml(item.id)}">
              ${
                cachedUrl
                  ? `<img src="${cachedUrl}" alt="${escapeHtml(img.name)}" loading="lazy" />`
                  : `<div class="image-placeholder">
                      <span>${prog ? `${prog.phase === 'upload' ? '上传中' : '加载中'} ${prog.pct}%` : escapeHtml(img.name)}</span>
                      ${prog ? `<div class="progress-track" style="width:120px"><div class="progress-fill" style="width:${prog.pct}%"></div></div>` : ''}
                    </div>`
              }
            </div>`;
          })
          .join('')}</div>`
      : '';

  const filesHtml =
    files.length > 0
      ? `<div class="file-list">${files
          .map((f) => {
            const { ext, cls } = getExtInfo(f.name, f.mimeType);
            const prog = store.transferProgress.get(f.fileId);
            return `
            <div class="file-card">
              <div class="file-card-left">
                <div class="file-ext-badge ${cls}">${escapeHtml(ext)}</div>
                <div class="file-info">
                  <div class="file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
                  <div class="file-sub">
                    <span>${formatBytes(f.size)}</span>
                    ${prog ? `<span>${prog.phase === 'upload' ? '正在上传' : '正在下载'} ${prog.pct}%</span>` : ''}
                  </div>
                  ${prog ? `<div class="progress-track"><div class="progress-fill" style="width:${prog.pct}%"></div></div>` : ''}
                </div>
              </div>
              <button class="file-dl-btn" type="button" data-action="download-file" data-item-id="${escapeHtml(item.id)}" data-file-id="${escapeHtml(f.fileId)}">
                ${ICONS.download}<span>下载</span>
              </button>
            </div>`;
          })
          .join('')}</div>`
      : '';

  const tagsHtml =
    item.tags && item.tags.length > 0
      ? `<div class="card-tags">${item.tags
          .map((t) => `<button class="tag-pill" type="button" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`)
          .join('')}</div>`
      : '';

  return `
    <article class="drop-card ${item.pinned ? 'pinned' : ''}" data-id="${escapeHtml(item.id)}">
      <div class="drop-card-header">
        <div class="drop-meta">
          <span class="device-badge">${platformIcon(item.platform)}<span>${escapeHtml(item.deviceName)}</span></span>
          <span>·</span>
          <span>${formatTime(item.createdAt)}</span>
          ${pinBadge}
          ${encBadge}
          ${syncChip}
        </div>
        <div class="drop-actions">
          ${
            item.text
              ? `<button class="action-btn" type="button" title="复制文本" data-action="copy" data-id="${escapeHtml(item.id)}">${ICONS.copy}</button>`
              : ''
          }
          <button class="action-btn ${item.pinned ? 'active' : ''}" type="button" title="${item.pinned ? '取消置顶' : '置顶'}" data-action="pin" data-id="${escapeHtml(item.id)}">${ICONS.pin}</button>
          <button class="action-btn" type="button" title="编辑" data-action="edit" data-id="${escapeHtml(item.id)}">${ICONS.edit}</button>
          <button class="action-btn danger" type="button" title="删除" data-action="delete" data-id="${escapeHtml(item.id)}">${ICONS.trash}</button>
        </div>
      </div>
      ${bodyHtml}
      ${linksHtml}
      ${imagesHtml}
      ${filesHtml}
      ${tagsHtml}
    </article>`;
}

// Lazily hydrate cached/remote images into <img> tags without blocking stream render
function hydrateVisibleImages(container, items) {
  const byFileId = new Map();
  for (const it of items) {
    for (const att of it.attachments || []) {
      if ((att.mimeType || '').startsWith('image/')) {
        byFileId.set(att.fileId, att);
      }
    }
  }

  const tiles = container.querySelectorAll('.image-tile[data-image-id]');
  for (const tile of tiles) {
    if (tile.querySelector('img')) continue;
    const fileId = tile.getAttribute('data-image-id');
    const att = byFileId.get(fileId);
    if (!att) continue;
    syncEngine
      .getPreviewUrl(att)
      .then((url) => {
        if (!url || !tile.isConnected) return;
        tile.innerHTML = `<img src="${url}" alt="${escapeHtml(att.name)}" loading="lazy" />`;
      })
      .catch(() => {
        // leave clean placeholder if offline/locked
      });
  }
}

// Delegate click events on the stream container
export function bindStreamEvents() {
  const container = document.getElementById('stream-container');
  if (!container) return;

  container.addEventListener('click', async (e) => {
    // Code block copy button
    const codeCopyBtn = e.target.closest('[data-copy-code]');
    if (codeCopyBtn) {
      const code = decodeURIComponent(codeCopyBtn.getAttribute('data-copy-code') || '');
      try {
        await navigator.clipboard.writeText(code);
        codeCopyBtn.innerHTML = `${ICONS.check}<span>已复制</span>`;
        setTimeout(() => {
          codeCopyBtn.innerHTML = `${ICONS.copy}<span>复制</span>`;
        }, 1500);
      } catch {
        showToast('复制失败，请检查剪贴板权限', 'error');
      }
      return;
    }

    // Tag pill click -> filter by tag
    const tagBtn = e.target.closest('[data-tag]');
    if (tagBtn) {
      store.setTagFilter(tagBtn.getAttribute('data-tag'));
      return;
    }

    // Image lightbox click
    const tile = e.target.closest('.image-tile[data-image-id]');
    if (tile) {
      const fileId = tile.getAttribute('data-image-id');
      const name = tile.getAttribute('data-image-name');
      const url = syncEngine.blobUrlCache.get(fileId);
      if (url) openLightbox(url, name);
      return;
    }

    // Action buttons
    const actBtn = e.target.closest('[data-action]');
    if (!actBtn) return;
    const action = actBtn.getAttribute('data-action');
    const id = actBtn.getAttribute('data-id');
    const item = store.items.find((x) => x.id === id);

    if (action === 'copy' && item) {
      try {
        await navigator.clipboard.writeText(item.text || '');
        showToast('已复制到剪贴板', 'success', 1800);
      } catch {
        showToast('复制失败', 'error');
      }
    } else if (action === 'pin' && item) {
      await syncEngine.patchDrop(item.id, { pinned: !item.pinned });
      showToast(item.pinned ? '已取消置顶' : '已置顶', 'info', 1600);
    } else if (action === 'edit' && item) {
      store.editingItemId = item.id;
      renderStream();
      const ta = document.getElementById('inline-edit-input');
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    } else if (action === 'cancel-edit') {
      store.editingItemId = null;
      renderStream();
    } else if (action === 'save-edit' && item) {
      const ta = document.getElementById('inline-edit-input');
      const newText = ta ? ta.value.trim() : item.text;
      store.editingItemId = null;
      await syncEngine.patchDrop(item.id, { text: newText });
      showToast('已保存修改', 'success', 1600);
    } else if (action === 'delete' && item) {
      await syncEngine.deleteDrop(item);
      showToast('已删除该条投递', 'info', 1800);
    } else if (action === 'download-file') {
      const itemId = actBtn.getAttribute('data-item-id');
      const fileId = actBtn.getAttribute('data-file-id');
      const targetItem = store.items.find((x) => x.id === itemId);
      const att = targetItem?.attachments?.find((a) => a.fileId === fileId);
      if (!att) return;
      try {
        await syncEngine.downloadAttachmentToDevice(att);
        showToast(`开始下载 ${att.name}`, 'success', 2000);
      } catch (err) {
        showToast(err.message || '下载失败', 'error');
      }
    }
  });
}
