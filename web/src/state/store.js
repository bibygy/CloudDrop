// Reactive state store + deterministic conflict-free CRDT event log reducer

import { extractTags, extractUrls } from '../ui/markdown.js';

const SETTINGS_KEY = 'clouddrop_settings_v1';

export function detectPlatform() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return 'linux';
  if (/Macintosh|Mac OS/i.test(ua)) return 'macos';
  return 'web';
}

export function defaultDeviceName(platform) {
  const map = {
    windows: 'Windows PC',
    android: 'Android Phone',
    linux: 'Linux Desktop',
    macos: 'Mac',
    ios: 'iPhone',
    web: 'Web Browser'
  };
  return map[platform] || 'Device';
}

export function makeId(prefix = 'id') {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  const hex = [...rand].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${Date.now().toString(36)}_${hex}`;
}

function loadSettings() {
  const platform = detectPlatform();
  const defaults = {
    theme: 'system', // 'light' | 'dark' | 'system'
    uiFontSize: 14,
    codeFontSize: 13,
    enterToSend: true,
    compactMode: false,
    autoSyncSec: 12,
    provider: 'local', // 'local' | 'gdrive' | 'onedrive'
    deviceId: makeId('dev'),
    deviceName: defaultDeviceName(platform),
    platform,
    gdriveClientId: '',
    onedriveClientId: '',
    onedriveAuthority: 'consumers', // 'consumers' | 'common'
    e2eeEnabled: false
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(defaults));
      return defaults;
    }
    const parsed = JSON.parse(raw);
    const merged = { ...defaults, ...parsed, platform };
    if (!parsed.deviceId) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    }
    return merged;
  } catch {
    return defaults;
  }
}

export function classifyItem(item) {
  const atts = item.attachments || [];
  const hasImages = atts.some((a) => (a.mimeType || '').startsWith('image/'));
  const hasOtherFiles = atts.some((a) => !(a.mimeType || '').startsWith('image/'));
  const text = (item.text || '').trim();
  const urls = extractUrls(text);
  const hasCode = /```[\s\S]*```/.test(text);

  if (hasOtherFiles) return 'file';
  if (hasImages) return 'image';
  if (urls.length > 0 && text.replace(/https?:\/\/\S+/g, '').trim().length < 80) return 'link';
  if (hasCode) return 'code';
  return 'note';
}

/**
 * Deterministic CRDT fold of immutable events into current items list.
 * Supports:
 *  - type: 'create' -> creates item
 *  - type: 'patch'  -> LWW update of text, pinned, tags, attachments
 *  - type: 'delete' -> tombstone
 */
export function reduceEvents(events, pendingOpIds = new Set()) {
  const sorted = [...events].sort((a, b) => {
    const dt = (a.createdAt || 0) - (b.createdAt || 0);
    if (dt !== 0) return dt;
    return String(a.opId).localeCompare(String(b.opId));
  });

  const byId = new Map();
  const tombstones = new Set();

  for (const ev of sorted) {
    if (!ev || !ev.opId) continue;

    if (ev.type === 'create') {
      const id = ev.itemId || ev.targetId || ev.opId;
      if (tombstones.has(id)) continue;
      const payload = ev.payload || {};
      byId.set(id, {
        id,
        opId: ev.opId,
        createdAt: ev.createdAt || Date.now(),
        updatedAt: ev.createdAt || Date.now(),
        deviceId: ev.deviceId || 'unknown',
        deviceName: ev.deviceName || 'Device',
        platform: ev.platform || 'web',
        text: payload.text || '',
        attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
        pinned: Boolean(payload.pinned),
        tags: Array.isArray(payload.tags) ? payload.tags : extractTags(payload.text || ''),
        encrypted: Boolean(ev.encrypted),
        pending: pendingOpIds.has(ev.opId)
      });
    } else if (ev.type === 'patch') {
      const id = ev.targetId;
      const cur = byId.get(id);
      if (!cur || tombstones.has(id)) continue;
      if ((ev.createdAt || 0) >= (cur.updatedAt || 0)) {
        const p = ev.payload || {};
        if (typeof p.text === 'string') {
          cur.text = p.text;
          cur.tags = Array.isArray(p.tags) ? p.tags : extractTags(p.text);
        }
        if (typeof p.pinned === 'boolean') cur.pinned = p.pinned;
        if (Array.isArray(p.tags)) cur.tags = p.tags;
        if (Array.isArray(p.attachments)) cur.attachments = p.attachments;
        cur.updatedAt = ev.createdAt || cur.updatedAt;
      }
      if (pendingOpIds.has(ev.opId)) cur.pending = true;
    } else if (ev.type === 'delete') {
      const id = ev.targetId;
      tombstones.add(id);
      byId.delete(id);
    }
  }

  const items = [];
  for (const item of byId.values()) {
    item.kind = classifyItem(item);
    item.urls = extractUrls(item.text);
    items.push(item);
  }

  items.sort((a, b) => a.createdAt - b.createdAt);
  return items;
}

class Store {
  constructor() {
    this.settings = loadSettings();
    this.events = [];
    this.pendingOpIds = new Set();
    this.items = [];
    this.filter = 'all'; // 'all' | 'pinned' | 'note' | 'image' | 'file' | 'link'
    this.deviceFilter = null;
    this.tagFilter = null;
    this.searchQuery = '';
    this.editingItemId = null;
    this.syncState = {
      status: 'local', // 'connected' | 'syncing' | 'local' | 'error'
      providerName: '本地模式',
      accountLabel: '未连接云盘',
      lastSyncedAt: null,
      errorMessage: '',
      pendingCount: 0,
      quota: null,
      lanAvailable: false
    };
    this.transferProgress = new Map();
    this.e2eeUnlocked = false;
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(reason = 'update') {
    for (const fn of this.listeners) {
      try {
        fn(this, reason);
      } catch (err) {
        console.error('[Store listener]', err);
      }
    }
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // ignore storage quota errors
    }
    this.applyAppearance();
    this.notify('settings');
  }

  applyAppearance() {
    const root = document.documentElement;
    const pref = this.settings.theme || 'system';
    const resolved =
      pref === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : pref;
    root.setAttribute('data-theme', resolved);
    root.style.setProperty('--dsw-font-size-ui', `${this.settings.uiFontSize || 14}px`);
    root.style.setProperty('--dsw-font-size-code', `${this.settings.codeFontSize || 13}px`);

    const shell = document.getElementById('app-shell');
    if (shell) {
      shell.classList.toggle('compact-mode', Boolean(this.settings.compactMode));
    }
  }

  setEvents(events, pendingOpIds = this.pendingOpIds) {
    this.events = events;
    this.pendingOpIds = new Set(pendingOpIds);
    this.items = reduceEvents(this.events, this.pendingOpIds);
    this.syncState.pendingCount = this.pendingOpIds.size;
    this.notify('items');
  }

  setSyncState(patch) {
    this.syncState = { ...this.syncState, ...patch };
    this.notify('sync');
  }

  setTransferProgress(fileId, progress) {
    if (!progress) {
      this.transferProgress.delete(fileId);
    } else {
      this.transferProgress.set(fileId, progress);
    }
    this.notify('progress');
  }

  setFilter(filter) {
    this.filter = filter;
    this.deviceFilter = null;
    this.tagFilter = null;
    this.notify('filter');
  }

  setDeviceFilter(deviceId) {
    this.deviceFilter = this.deviceFilter === deviceId ? null : deviceId;
    if (this.deviceFilter) this.filter = 'all';
    this.notify('filter');
  }

  setTagFilter(tag) {
    this.tagFilter = this.tagFilter === tag ? null : tag;
    this.notify('filter');
  }

  setSearchQuery(q) {
    this.searchQuery = q;
    this.notify('filter');
  }

  getCounts() {
    const counts = { all: this.items.length, pinned: 0, note: 0, image: 0, file: 0, link: 0 };
    for (const it of this.items) {
      if (it.pinned) counts.pinned++;
      if ((it.text || '').trim().length > 0) counts.note++;
      if ((it.attachments || []).some((a) => (a.mimeType || '').startsWith('image/'))) counts.image++;
      if ((it.attachments || []).some((a) => !(a.mimeType || '').startsWith('image/'))) counts.file++;
      if ((it.urls || []).length > 0) counts.link++;
    }
    return counts;
  }

  getDevices() {
    const map = new Map();
    map.set(this.settings.deviceId, {
      deviceId: this.settings.deviceId,
      deviceName: this.settings.deviceName,
      platform: this.settings.platform,
      count: 0,
      isCurrent: true
    });
    for (const it of this.items) {
      const existing = map.get(it.deviceId);
      if (existing) {
        existing.count++;
        existing.deviceName = it.deviceName || existing.deviceName;
      } else {
        map.set(it.deviceId, {
          deviceId: it.deviceId,
          deviceName: it.deviceName || 'Device',
          platform: it.platform || 'web',
          count: 1,
          isCurrent: it.deviceId === this.settings.deviceId
        });
      }
    }
    return [...map.values()];
  }

  getFilteredItems() {
    const q = (this.searchQuery || '').trim().toLowerCase();
    return this.items.filter((it) => {
      if (this.filter === 'pinned' && !it.pinned) return false;
      if (this.filter === 'note' && !(it.text || '').trim()) return false;
      if (this.filter === 'image' && !(it.attachments || []).some((a) => (a.mimeType || '').startsWith('image/'))) {
        return false;
      }
      if (this.filter === 'file' && !(it.attachments || []).some((a) => !(a.mimeType || '').startsWith('image/'))) {
        return false;
      }
      if (this.filter === 'link' && (!it.urls || it.urls.length === 0)) return false;

      if (this.deviceFilter && it.deviceId !== this.deviceFilter) return false;
      if (this.tagFilter && !(it.tags || []).includes(this.tagFilter)) return false;

      if (q) {
        const hay = [
          it.text || '',
          it.deviceName || '',
          ...(it.tags || []),
          ...(it.attachments || []).map((a) => a.name || '')
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
}

export const store = new Store();
