// Settings & Cloud Drive Connection Wizard Modal
// Tabs: 云盘同步 (Google Drive / OneDrive / 本地局域网) | 外观与排版 | 端到端加密 | 设备与备份

import { store } from '../state/store.js';
import { syncEngine } from '../sync/engine.js';
import { getAppRedirectUri } from '../providers/base.js';
import { ICONS } from './icons.js';
import { escapeHtml } from './markdown.js';
import { showToast } from './toast.js';
import { appLog } from './logger.js';

let activeTab = 'cloud';
let logFilter = 'all'; // 'all' | 'error' | 'backend'
let cachedBackendLines = [];
let cachedBackendLogPath = '';

export function openSettingsModal(tab = 'cloud') {
  activeTab = tab;
  const backdrop = document.getElementById('settings-modal');
  if (!backdrop) return;
  backdrop.classList.add('open');
  renderSettingsModal();
}

export function closeSettingsModal() {
  const backdrop = document.getElementById('settings-modal');
  if (backdrop) backdrop.classList.remove('open');
}

export function initSettingsModal() {
  const backdrop = document.getElementById('settings-modal');
  const closeBtn = document.getElementById('settings-close');
  if (closeBtn) closeBtn.addEventListener('click', closeSettingsModal);
  if (backdrop) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeSettingsModal();
    });
  }
}

export function renderSettingsModal() {
  const tabsEl = document.getElementById('settings-tabs');
  const bodyEl = document.getElementById('settings-body');
  if (!tabsEl || !bodyEl) return;

  const tabs = [
    { id: 'cloud', label: '云盘同步' },
    { id: 'appearance', label: '外观与排版' },
    { id: 'e2ee', label: '端到端加密' },
    { id: 'device', label: '设备与备份' },
    { id: 'logs', label: '运行日志' }
  ];

  tabsEl.innerHTML = tabs
    .map(
      (t) =>
        `<button class="modal-tab ${activeTab === t.id ? 'active' : ''}" data-modal-tab="${t.id}" type="button">${t.label}</button>`
    )
    .join('');

  tabsEl.querySelectorAll('[data-modal-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.getAttribute('data-modal-tab');
      renderSettingsModal();
    });
  });

  if (activeTab === 'cloud') renderCloudTab(bodyEl);
  else if (activeTab === 'appearance') renderAppearanceTab(bodyEl);
  else if (activeTab === 'e2ee') renderE2eeTab(bodyEl);
  else if (activeTab === 'logs') renderLogsTab(bodyEl);
  else renderDeviceTab(bodyEl);
}

function renderCloudTab(bodyEl) {
  const s = store.settings;
  const current = s.provider || 'local';
  const redirectUri = getAppRedirectUri();
  const originUri = window.location.origin;

  const gdriveConnected = syncEngine.providers.gdrive.isConnected();
  const onedriveConnected = syncEngine.providers.onedrive.isConnected();
  const lanServer = syncEngine.providers.local.serverAvailable;
  const lanUrl = syncEngine.providers.local.serverInfo?.lanUrl || '';

  let detailHtml = '';

  if (current === 'gdrive') {
    detailHtml = `
      <div class="form-group">
        <label class="form-label" for="input-gdrive-cid">
          <span>Google OAuth Client ID</span>
          <span style="font-size:11.5px;color:${gdriveConnected ? 'var(--dsw-alias-success)' : 'var(--dsw-alias-ink-tertiary)'}">
            ${gdriveConnected ? '● 已连接' : '○ 未连接'}
          </span>
        </label>
        <input class="text-input mono" id="input-gdrive-cid" type="text"
          placeholder="例如：1234567890-xxxx.apps.googleusercontent.com"
          value="${escapeHtml(s.gdriveClientId || '')}" />
        <div class="form-help">采用最小权限 <code>drive.file</code>，仅读写你的 Google Drive 中 <code>CloudDrop/</code> 目录。</div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-primary" id="btn-connect-gdrive" type="button">${ICONS.cloud}<span>${gdriveConnected ? '重新授权 Google Drive' : '连接 Google Drive'}</span></button>
        <button class="btn btn-secondary" id="btn-connect-gdrive-redirect" type="button">当前页跳转授权</button>
        ${gdriveConnected ? `<button class="btn btn-danger" id="btn-disconnect-gdrive" type="button">断开连接</button>` : ''}
      </div>

      <div class="form-group">
        <div class="form-label"><span>当前设备来源与回调地址（需加入 Google Cloud OAuth）</span></div>
        <div class="copy-uri-row" style="margin-top:0;">
          <span>${escapeHtml(redirectUri)}</span>
          <button class="btn btn-secondary btn-sm" data-copy-text="${escapeHtml(redirectUri)}" type="button">复制</button>
        </div>
      </div>

      <details class="setup-guide">
        <summary>3 分钟免费获取自己的 Google Drive Client ID（数据完全归自己掌控）</summary>
        <ol>
          <li>打开 <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener">Google Cloud Console</a>，创建项目并启用 <strong>Google Drive API</strong>。</li>
          <li>在「OAuth 同意屏幕」选择「外部（External）」，在测试用户里添加你自己的 Gmail。</li>
          <li>在「凭据 → 创建凭据 → OAuth 客户端 ID」选择 <strong>Web 应用</strong>，将下方地址添加到 <strong>已获授权的 JavaScript 来源</strong> 与 <strong>已获授权的重定向 URI</strong>：</li>
        </ol>
        <div class="copy-uri-row">
          <span>${escapeHtml(originUri)}</span>
          <button class="btn btn-secondary btn-sm" data-copy-text="${escapeHtml(originUri)}" type="button">复制</button>
        </div>
        <div class="copy-uri-row">
          <span>${escapeHtml(redirectUri)}</span>
          <button class="btn btn-secondary btn-sm" data-copy-text="${escapeHtml(redirectUri)}" type="button">复制</button>
        </div>
      </details>`;
  } else if (current === 'onedrive') {
    detailHtml = `
      <div class="form-group">
        <label class="form-label" for="input-od-cid">
          <span>Microsoft Entra (Azure) 应用 Client ID</span>
          <span style="font-size:11.5px;color:${onedriveConnected ? 'var(--dsw-alias-success)' : 'var(--dsw-alias-ink-tertiary)'}">
            ${onedriveConnected ? '● 已连接' : '○ 未连接'}
          </span>
        </label>
        <input class="text-input mono" id="input-od-cid" type="text"
          placeholder="例如：xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          value="${escapeHtml(s.onedriveClientId || '')}" />
      </div>

      <div class="form-group">
        <label class="form-label" for="select-od-tenant">微软账号类型</label>
        <select class="select-input" id="select-od-tenant">
          <option value="consumers" ${s.onedriveAuthority !== 'common' ? 'selected' : ''}>个人微软账号（Outlook / Hotmail / Live）</option>
          <option value="common" ${s.onedriveAuthority === 'common' ? 'selected' : ''}>个人 + 企业/学校组织账号（Common）</option>
        </select>
        <div class="form-help">采用标准 OAuth 2.0 PKCE + Refresh Token，文件存放在 OneDrive 的 <code>CloudDrop/</code> 目录（与原版 Edge Drop 类似）。</div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-primary" id="btn-connect-od" type="button">${ICONS.cloud}<span>${onedriveConnected ? '重新授权 OneDrive' : '连接 OneDrive'}</span></button>
        <button class="btn btn-secondary" id="btn-connect-od-redirect" type="button">当前页跳转授权</button>
        ${onedriveConnected ? `<button class="btn btn-danger" id="btn-disconnect-od" type="button">断开连接</button>` : ''}
      </div>

      <div class="form-group">
        <div class="form-label"><span>当前设备回调地址（需加入 Azure SPA 重定向 URI）</span></div>
        <div class="copy-uri-row" style="margin-top:0;">
          <span>${escapeHtml(redirectUri)}</span>
          <button class="btn btn-secondary btn-sm" data-copy-text="${escapeHtml(redirectUri)}" type="button">复制</button>
        </div>
      </div>

      <details class="setup-guide">
        <summary>3 分钟免费配置 Microsoft OneDrive（SPA PKCE，无需任何后端）</summary>
        <ol>
          <li>打开 <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Microsoft Entra / Azure 应用注册</a> → 点击「新注册」。</li>
          <li>受支持的账户类型选择「仅个人 Microsoft 账户」或「任何组织目录和个人 Microsoft 账户」。</li>
          <li>重定向 URI 平台类型务必选择 <strong>单页应用程序 (SPA)</strong>，填入下方地址并保存：</li>
          <li>在「API 权限」确认包含 Microsoft Graph 委托权限：<code>Files.ReadWrite</code>、<code>User.Read</code>、<code>offline_access</code>。</li>
        </ol>
        <div class="copy-uri-row">
          <span>${escapeHtml(redirectUri)}</span>
          <button class="btn btn-secondary btn-sm" data-copy-text="${escapeHtml(redirectUri)}" type="button">复制</button>
        </div>
      </details>`;
  } else {
    detailHtml = `
      <div class="setup-guide">
        <strong>${lanServer ? '✓ 已连接本地伴侣服务（磁盘持久化已激活）' : '当前处于浏览器离线体验模式'}</strong>
        <p style="margin:6px 0 0;">
          ${
            lanServer
              ? `所有笔记和文件已实时保存在本机目录 <code>${escapeHtml(
                  syncEngine.providers.local.serverInfo?.dataDir || '~/.clouddrop/data'
                )}</code>。${
                  lanUrl
                    ? `<br>手机 Android 或 Linux 在同一 Wi-Fi 打开 <strong>${escapeHtml(lanUrl)}</strong> 即可免云盘直连互通！`
                    : '<br>提示：使用 <code>python desktop/clouddrop.py --lan</code> 启动即可开启局域网三端免配直连；或切换到上方 Google Drive / OneDrive 实现公网跨地区互通。'
                }`
              : '无需任何配置即可立刻试用全部交互体验。要实现 Windows / Android / Linux 公网三端互通，点击上方切换至 <strong>Google Drive</strong> 或 <strong>OneDrive</strong> 即可。'
          }
        </p>
      </div>`;
  }

  bodyEl.innerHTML = `
    <div class="provider-grid">
      <button class="provider-option ${current === 'gdrive' ? 'selected' : ''}" data-pick-provider="gdrive" type="button">
        <div class="provider-option-title">${ICONS.cloud}<span>Google Drive</span></div>
        <div class="provider-option-desc">谷歌云盘直连，支持大文件分片续传</div>
      </button>
      <button class="provider-option ${current === 'onedrive' ? 'selected' : ''}" data-pick-provider="onedrive" type="button">
        <div class="provider-option-title">${ICONS.cloud}<span>OneDrive</span></div>
        <div class="provider-option-desc">微软云盘直连，复刻原版 Edge Drop 体验</div>
      </button>
      <button class="provider-option ${current === 'local' ? 'selected' : ''}" data-pick-provider="local" type="button">
        <div class="provider-option-title">${ICONS.monitor}<span>本地 / 局域网</span></div>
        <div class="provider-option-desc">零配置本地缓存或同 Wi-Fi 局域网直连</div>
      </button>
    </div>

    ${detailHtml}

    <div class="settings-row">
      <div>
        <div style="font-weight:600;font-size:13px;">自动轮询同步频率</div>
        <div class="form-help">切回窗口时也会自动触发即时增量同步</div>
      </div>
      <select class="select-input" id="select-sync-interval" style="width:140px;">
        <option value="5" ${s.autoSyncSec == 5 ? 'selected' : ''}>每 5 秒</option>
        <option value="12" ${s.autoSyncSec == 12 ? 'selected' : ''}>每 12 秒（推荐）</option>
        <option value="30" ${s.autoSyncSec == 30 ? 'selected' : ''}>每 30 秒</option>
        <option value="0" ${s.autoSyncSec == 0 ? 'selected' : ''}>仅手动同步</option>
      </select>
    </div>
  `;

  // Bind cloud tab events
  bodyEl.querySelectorAll('[data-pick-provider]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pid = btn.getAttribute('data-pick-provider');
      await syncEngine.switchProvider(pid);
      renderSettingsModal();
    });
  });

  bodyEl.querySelectorAll('[data-copy-text]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(btn.getAttribute('data-copy-text'));
      showToast('已复制地址', 'success', 1500);
    });
  });

  const syncSel = document.getElementById('select-sync-interval');
  if (syncSel) {
    syncSel.addEventListener('change', () => {
      store.updateSettings({ autoSyncSec: Number(syncSel.value) });
      syncEngine.restartAutoPoll();
    });
  }

  // Google Drive connect/disconnect
  const gInput = document.getElementById('input-gdrive-cid');
  const connectGdrive = async (useRedirect) => {
    const cid = gInput ? gInput.value.trim() : s.gdriveClientId;
    store.updateSettings({ gdriveClientId: cid, provider: 'gdrive' });
    try {
      const ok = await syncEngine.providers.gdrive.connect({ clientId: cid, useRedirect });
      if (ok) {
        showToast('Google Drive 连接成功！正在同步...', 'success');
        await syncEngine.syncNow();
        renderSettingsModal();
      }
    } catch (err) {
      showToast(err.message || '连接失败', 'error', 4200);
    }
  };
  document.getElementById('btn-connect-gdrive')?.addEventListener('click', () => connectGdrive(false));
  document.getElementById('btn-connect-gdrive-redirect')?.addEventListener('click', () => connectGdrive(true));
  document.getElementById('btn-disconnect-gdrive')?.addEventListener('click', async () => {
    await syncEngine.providers.gdrive.disconnect();
    syncEngine._refreshSyncBanner();
    showToast('已断开 Google Drive', 'info');
    renderSettingsModal();
  });

  // OneDrive connect/disconnect
  const odInput = document.getElementById('input-od-cid');
  const odTenant = document.getElementById('select-od-tenant');
  const connectOd = async (useRedirect) => {
    const cid = odInput ? odInput.value.trim() : s.onedriveClientId;
    const authority = odTenant ? odTenant.value : s.onedriveAuthority;
    store.updateSettings({ onedriveClientId: cid, onedriveAuthority: authority, provider: 'onedrive' });
    try {
      const ok = await syncEngine.providers.onedrive.connect({ clientId: cid, authority, useRedirect });
      if (ok) {
        showToast('OneDrive 连接成功！正在同步...', 'success');
        await syncEngine.syncNow();
        renderSettingsModal();
      }
    } catch (err) {
      showToast(err.message || '连接失败', 'error', 4200);
    }
  };
  document.getElementById('btn-connect-od')?.addEventListener('click', () => connectOd(false));
  document.getElementById('btn-connect-od-redirect')?.addEventListener('click', () => connectOd(true));
  document.getElementById('btn-disconnect-od')?.addEventListener('click', async () => {
    await syncEngine.providers.onedrive.disconnect();
    syncEngine._refreshSyncBanner();
    showToast('已断开 OneDrive', 'info');
    renderSettingsModal();
  });
}

function renderAppearanceTab(bodyEl) {
  const s = store.settings;
  bodyEl.innerHTML = `
    <div class="settings-row">
      <div>
        <div style="font-weight:600;font-size:13px;">界面主题</div>
        <div class="form-help">采用 DeepSeek HARNESS 语义色阶，零闪烁切换</div>
      </div>
      <div class="segmented" id="seg-theme">
        <button type="button" data-theme-val="light" class="${s.theme === 'light' ? 'active' : ''}">浅色</button>
        <button type="button" data-theme-val="dark" class="${s.theme === 'dark' ? 'active' : ''}">深色</button>
        <button type="button" data-theme-val="system" class="${s.theme === 'system' ? 'active' : ''}">系统</button>
      </div>
    </div>

    <div class="settings-row">
      <div>
        <div style="font-weight:600;font-size:13px;">正文界面字号</div>
        <div class="form-help">独立控制正文与卡片排版尺寸（当前 ${s.uiFontSize}px）</div>
      </div>
      <input type="range" id="range-ui-font" min="12" max="17" step="1" value="${s.uiFontSize}" />
    </div>

    <div class="settings-row">
      <div>
        <div style="font-weight:600;font-size:13px;">代码块字号</div>
        <div class="form-help">独立控制等宽代码块尺寸（当前 ${s.codeFontSize}px）</div>
      </div>
      <input type="range" id="range-code-font" min="11" max="16" step="1" value="${s.codeFontSize}" />
    </div>

    <div class="settings-row">
      <div>
        <div style="font-weight:600;font-size:13px;">Edge Drop 窄侧栏模式</div>
        <div class="form-help">折叠左侧栏为抽屉，适合分屏或贴边常驻</div>
      </div>
      <div class="segmented" id="seg-compact">
        <button type="button" data-val="false" class="${!s.compactMode ? 'active' : ''}">宽屏工作台</button>
        <button type="button" data-val="true" class="${s.compactMode ? 'active' : ''}">窄侧栏</button>
      </div>
    </div>

    <div class="settings-row">
      <div>
        <div style="font-weight:600;font-size:13px;">发送快捷键</div>
        <div class="form-help">控制输入框按下 Enter 时的行为</div>
      </div>
      <div class="segmented" id="seg-enter">
        <button type="button" data-val="true" class="${s.enterToSend ? 'active' : ''}">Enter 发送</button>
        <button type="button" data-val="false" class="${!s.enterToSend ? 'active' : ''}">Ctrl+Enter 发送</button>
      </div>
    </div>
  `;

  bodyEl.querySelectorAll('#seg-theme button').forEach((b) => {
    b.addEventListener('click', () => {
      store.updateSettings({ theme: b.getAttribute('data-theme-val') });
      renderAppearanceTab(bodyEl);
    });
  });

  document.getElementById('range-ui-font')?.addEventListener('input', (e) => {
    store.updateSettings({ uiFontSize: Number(e.target.value) });
    renderAppearanceTab(bodyEl);
  });
  document.getElementById('range-code-font')?.addEventListener('input', (e) => {
    store.updateSettings({ codeFontSize: Number(e.target.value) });
    renderAppearanceTab(bodyEl);
  });

  bodyEl.querySelectorAll('#seg-compact button').forEach((b) => {
    b.addEventListener('click', () => {
      store.updateSettings({ compactMode: b.getAttribute('data-val') === 'true' });
      renderAppearanceTab(bodyEl);
    });
  });

  bodyEl.querySelectorAll('#seg-enter button').forEach((b) => {
    b.addEventListener('click', () => {
      store.updateSettings({ enterToSend: b.getAttribute('data-val') === 'true' });
      renderAppearanceTab(bodyEl);
    });
  });
}

function renderE2eeTab(bodyEl) {
  const enabled = store.settings.e2eeEnabled;
  const unlocked = store.e2eeUnlocked;
  bodyEl.innerHTML = `
    <div class="setup-guide">
      <strong>可选客户端端到端加密（AES-256-GCM + PBKDF2）</strong>
      <p style="margin:6px 0 0;">
        开启后，新发送的文字笔记和上传文件都会先在本机使用你的口令加密，再存入 Google Drive 或 OneDrive。
        即使云盘账号泄露，他人也无法读取内容。<br>
        <em>注意：关闭状态（默认）时，文件直接明文存放在云盘 <code>CloudDrop/files/</code> 中，方便你在云盘 App 里直接预览。</em>
      </p>
    </div>

    <div class="form-group">
      <label class="form-label" for="input-e2ee-pass">
        <span>同步加密口令</span>
        <span style="font-size:11.5px;color:${unlocked ? 'var(--dsw-alias-success)' : 'var(--dsw-alias-ink-tertiary)'}">
          ${unlocked ? '● 已解锁加密中' : enabled ? '○ 已开启（当前会话未解锁）' : '○ 未开启'}
        </span>
      </label>
      <input class="text-input" id="input-e2ee-pass" type="password" placeholder="输入自定义同步口令（Windows / Android / Linux 填同一口令）" />
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-primary" id="btn-e2ee-unlock" type="button">${ICONS.lock}<span>${enabled ? '验证并解锁' : '启用端到端加密'}</span></button>
      ${enabled ? `<button class="btn btn-secondary" id="btn-e2ee-disable" type="button">关闭加密（后续内容明文）</button>` : ''}
    </div>
  `;

  document.getElementById('btn-e2ee-unlock')?.addEventListener('click', async () => {
    const pass = document.getElementById('input-e2ee-pass')?.value || '';
    try {
      await syncEngine.enableOrUnlockE2ee(pass);
      showToast('端到端加密已解锁生效', 'success');
      renderE2eeTab(bodyEl);
    } catch (err) {
      showToast(err.message || '解锁失败', 'error');
    }
  });

  document.getElementById('btn-e2ee-disable')?.addEventListener('click', () => {
    syncEngine.disableE2eeSession();
    showToast('已关闭新内容的端到端加密', 'info');
    renderE2eeTab(bodyEl);
  });
}

function renderDeviceTab(bodyEl) {
  const s = store.settings;
  bodyEl.innerHTML = `
    <div class="form-group">
      <label class="form-label" for="input-device-name">本机显示名称（用于区分 Windows / Android / Linux 来源）</label>
      <div style="display:flex;gap:8px;">
        <input class="text-input" id="input-device-name" type="text" value="${escapeHtml(s.deviceName)}" />
        <button class="btn btn-primary" id="btn-save-device" type="button">保存</button>
      </div>
      <div class="form-help">识别平台：<code>${escapeHtml(s.platform)}</code> · 设备 ID：<code>${escapeHtml(s.deviceId)}</code></div>
    </div>

    <div class="settings-row">
      <div>
        <div style="font-weight:600;font-size:13px;">导出与恢复备份（JSON）</div>
        <div class="form-help">随时导出全部笔记与事件索引，或迁移到新设备</div>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-secondary btn-sm" id="btn-export-json" type="button">${ICONS.download}<span>导出</span></button>
        <button class="btn btn-secondary btn-sm" id="btn-import-json" type="button">${ICONS.upload}<span>导入</span></button>
        <input type="file" id="input-import-file" accept=".json,application/json" style="display:none" />
      </div>
    </div>

    <div class="settings-row">
      <div>
        <div style="font-weight:600;font-size:13px;">清空本机离线缓存</div>
        <div class="form-help">仅清除本机 IndexedDB 缓存，不会删除云盘上的文件</div>
      </div>
      <button class="btn btn-danger btn-sm" id="btn-clear-cache" type="button">清空缓存</button>
    </div>

    <div class="setup-guide">
      <strong>Windows / Android / Linux 三端部署说明</strong>
      <ol>
        <li><strong>Windows / Linux</strong>：直接运行项目内 <code>start-windows.bat</code>（或 <code>start-windows-panel.bat</code> 窄侧栏模式）/ <code>start-linux.sh</code>，或通过仓库 GitHub Actions 构建 Tauri 原生安装包。</li>
        <li><strong>Android</strong>：将 <code>web/</code> 免费部署到 GitHub Pages 后用 Chrome「添加到主屏幕」即可成为独立 App 并接入 Android 系统分享菜单；也可使用 <code>platforms/android</code> 或 <code>platforms/tauri</code> 编译原生 APK。</li>
      </ol>
    </div>
  `;

  document.getElementById('btn-save-device')?.addEventListener('click', () => {
    const val = document.getElementById('input-device-name')?.value.trim();
    if (!val) return;
    store.updateSettings({ deviceName: val });
    showToast(`设备名称已更新为「${val}」`, 'success');
  });

  document.getElementById('btn-export-json')?.addEventListener('click', async () => {
    await syncEngine.exportBackupJson();
    showToast('已导出 JSON 备份文件', 'success');
  });

  const fileInput = document.getElementById('input-import-file');
  document.getElementById('btn-import-json')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const count = await syncEngine.importBackupJson(f);
      showToast(`已成功导入 ${count} 条记录`, 'success');
    } catch (err) {
      showToast(err.message || '导入失败', 'error');
    }
    fileInput.value = '';
  });

  document.getElementById('btn-clear-cache')?.addEventListener('click', async () => {
    await syncEngine.clearLocalCache();
    showToast('本机缓存已清空', 'info');
  });
}

async function fetchBackendLogs() {
  try {
    const res = await fetch('/api/logs?tail=300', { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    if (data && data.ok) {
      cachedBackendLines = Array.isArray(data.lines) ? data.lines : [];
      cachedBackendLogPath = data.logPath || '';
      return true;
    }
  } catch {
    // static PWA without desktop companion
  }
  return false;
}

function renderLogLinesHtml() {
  if (logFilter === 'backend') {
    if (!cachedBackendLines.length) {
      return '<div style="color:var(--dsw-alias-ink-tertiary);padding:8px;">暂无桌面后端日志（仅在 Windows / Linux 桌面伴侣运行时产生）。</div>';
    }
    return cachedBackendLines
      .map((line) => {
        const lvl = line.includes('[ERROR]') ? 'ERROR' : line.includes('[WARNING]') ? 'WARN' : 'INFO';
        return `<div class="log-line"><span class="log-lvl ${lvl}">${lvl}</span><span class="log-msg">${escapeHtml(line)}</span></div>`;
      })
      .join('');
  }

  const list = appLog.getEntries(logFilter);
  if (!list.length) {
    return '<div style="color:var(--dsw-alias-ink-tertiary);padding:8px;">当前筛选下暂无日志记录。</div>';
  }
  return list
    .map(
      (e) =>
        `<div class="log-line">` +
        `<span class="log-ts">${escapeHtml(e.time)}</span>` +
        `<span class="log-lvl ${escapeHtml(e.level)}">${escapeHtml(e.level)}</span>` +
        `<span class="log-scope">[${escapeHtml(e.scope)}]</span>` +
        `<span class="log-msg">${escapeHtml(e.message)}</span>` +
        `</div>`
    )
    .join('');
}

async function renderLogsTab(bodyEl) {
  const hasDesktop = syncEngine.providers.local.serverAvailable || (await fetchBackendLogs());
  if (hasDesktop && !cachedBackendLogPath) {
    await fetchBackendLogs();
  }

  bodyEl.innerHTML = `
    <div class="log-toolbar">
      <div class="segmented" id="seg-log-filter">
        <button type="button" data-log-filter="all" class="${logFilter === 'all' ? 'active' : ''}">前端日志</button>
        <button type="button" data-log-filter="error" class="${logFilter === 'error' ? 'active' : ''}">仅警告/错误</button>
        ${hasDesktop ? `<button type="button" data-log-filter="backend" class="${logFilter === 'backend' ? 'active' : ''}">桌面后端日志</button>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn btn-secondary btn-sm" id="btn-log-refresh" type="button">刷新</button>
        <button class="btn btn-secondary btn-sm" id="btn-log-copy" type="button">复制全部</button>
        <button class="btn btn-secondary btn-sm" id="btn-log-export" type="button">导出 .log</button>
        <button class="btn btn-danger btn-sm" id="btn-log-clear" type="button">清空</button>
      </div>
    </div>

    <div class="log-console" id="log-console">${renderLogLinesHtml()}</div>

    ${
      hasDesktop
        ? `<div class="settings-row" style="padding-bottom:0;">
            <div>
              <div style="font-weight:600;font-size:12.5px;">桌面后台日志文件（自动脱敏滚动保存）</div>
              <div class="form-help" style="font-family:var(--dsw-font-code);word-break:break-all;">${escapeHtml(
                cachedBackendLogPath || '~/.clouddrop/logs/clouddrop.log'
              )}</div>
            </div>
            <button class="btn btn-danger btn-sm" id="btn-stop-daemon" type="button">退出后台服务</button>
          </div>`
        : `<div class="form-help">提示：日志会自动对 Token/密钥脱敏，遇到异常可直接点击「复制全部」发给开发者定位。</div>`
    }
  `;

  const consoleEl = document.getElementById('log-console');
  if (consoleEl) consoleEl.scrollTop = consoleEl.scrollHeight;

  bodyEl.querySelectorAll('#seg-log-filter button').forEach((b) => {
    b.addEventListener('click', async () => {
      logFilter = b.getAttribute('data-log-filter');
      if (logFilter === 'backend') await fetchBackendLogs();
      renderLogsTab(bodyEl);
    });
  });

  document.getElementById('btn-log-refresh')?.addEventListener('click', async () => {
    if (hasDesktop) await fetchBackendLogs();
    renderLogsTab(bodyEl);
    showToast('日志已刷新', 'info', 1200);
  });

  document.getElementById('btn-log-copy')?.addEventListener('click', async () => {
    if (hasDesktop) await fetchBackendLogs();
    const text = appLog.formatPlainText(cachedBackendLines);
    await navigator.clipboard.writeText(text);
    showToast('已复制全部脱敏诊断日志', 'success', 1800);
  });

  document.getElementById('btn-log-export')?.addEventListener('click', async () => {
    if (hasDesktop) await fetchBackendLogs();
    const text = appLog.formatPlainText(cachedBackendLines);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clouddrop-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });

  document.getElementById('btn-log-clear')?.addEventListener('click', async () => {
    appLog.clear();
    if (hasDesktop) {
      await fetch('/api/logs/clear', { method: 'POST' }).catch(() => {});
      cachedBackendLines = [];
    }
    renderLogsTab(bodyEl);
    showToast('运行日志已清空', 'info', 1500);
  });

  document.getElementById('btn-stop-daemon')?.addEventListener('click', async () => {
    await fetch('/api/shutdown', { method: 'POST' }).catch(() => {});
    showToast('桌面后台服务已安全停止，可直接关闭窗口', 'info', 4000);
  });
}
