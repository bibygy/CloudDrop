# CloudDrop — 三端清爽云端投递箱

一个致敬微软 **Edge Drop**、界面采用 **DeepSeek HARNESS** 极简语义视觉系统的跨设备文件与笔记投递工具。

- **Windows / Android / Linux 三端互通**
- **数据直连个人 Google Drive 或 Microsoft OneDrive**（无任何第三方中转服务器，数据完全掌握在你自己的云盘里）
- **无冲突同步架构**：基于不可变追加事件日志（`CloudDrop/events/*.json`）+ 独立附件目录（`CloudDrop/files/`），三端离线并发写入也不会互相覆盖
- **DeepSeek HARNESS 清爽美学**：双层语义色阶 Token（`--dsw-static-*` / `--dsw-alias-*`）、零闪烁浅色/护眼碳灰深色/跟随系统主题、独立 UI/代码字号控制、Edge Drop 窄侧栏模式

---

## 快速开始

### 1. Windows（零配置立刻启动）
- **宽屏工作台模式**：双击 [`desktop/start-windows.bat`](desktop/start-windows.bat)
- **Edge Drop 窄侧栏模式**（430×840 悬浮感窗口）：双击 [`desktop/start-windows-panel.bat`](desktop/start-windows-panel.bat)
- **开启同 Wi-Fi 局域网免云盘直连**（供 Android / Linux 同局域网秒连）：
  ```powershell
  python desktop\clouddrop.py --lan
  ```
- **直接复用本机已有的 OneDrive / Google Drive 同步目录**：
  ```powershell
  python desktop\clouddrop.py --data-dir "$env:USERPROFILE\OneDrive\CloudDrop"
  ```

### 2. Linux
```bash
chmod +x desktop/start-linux.sh desktop/install-linux-desktop.sh
./desktop/start-linux.sh            # 启动工作台
./desktop/start-linux.sh --panel    # Edge Drop 窄侧栏模式
./desktop/install-linux-desktop.sh  # 安装到桌面应用菜单
```

### 3. Android
提供两种原生级使用方式：
1. **PWA 独立应用（推荐，最轻最快）**：
   - 将本仓库推送到 GitHub，启用 GitHub Pages（已内置 `.github/workflows/deploy-pwa.yml` 自动部署 `web/`）
   - 在 Android Chrome 打开你的 Pages 链接 → 点击「安装应用 / 添加到主屏幕」
   - 即可拥有独立图标，并且自动接入 **Android 系统分享菜单**（Web Share Target），在任意 App 点「分享 → CloudDrop」直接投递文字、链接、图片和文件！
2. **原生 Android APK**：
   - 使用 [`platforms/android/`](platforms/android/)（已接入原生 `ACTION_SEND` / `ACTION_SEND_MULTIPLE` 系统分享 Intent），或通过 `.github/workflows/build-native.yml` 一键构建 `.apk`、Windows `.exe`/`.msi`、Linux `.AppImage`/`.deb`。

---

## 连接个人云盘（Google Drive / OneDrive）

打开右上角「设置 → 云盘同步」即可切换后端，弹窗内已自带当前地址的一键复制按钮与步骤引导：

### 接入 Google Drive
1. 在 [Google Cloud Console](https://console.cloud.google.com/apis/library/drive.googleapis.com) 创建项目并启用 **Google Drive API**。
2. 配置 OAuth 同意屏幕（外部）并把自己的 Gmail 加入测试用户。
3. 创建 **Web 应用** 类型的 OAuth 客户端 ID，将 CloudDrop 的运行地址（如 `http://localhost:4173` 或你的 GitHub Pages HTTPS 地址）添加到「已获授权的 JavaScript 来源」与「重定向 URI」。
4. 将生成的 Client ID 填入 CloudDrop 设置，点击「连接 Google Drive」。
   > 使用最小权限 `drive.file`，CloudDrop 仅读写它自己创建的 `CloudDrop/` 目录，支持 5MB 以上大文件断点分片续传。

### 接入 Microsoft OneDrive
1. 打开 [Microsoft Entra / Azure 应用注册](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) 新建应用。
2. 受支持的账户类型选择「仅个人 Microsoft 账户」或「个人 + 组织账户」。
3. 添加重定向 URI 时平台务必选择 **单页应用程序 (SPA)**，填入你的 CloudDrop 地址（如 `http://localhost:4173`）。
4. 将应用程序（客户端）ID 填入 CloudDrop 设置并点击「连接 OneDrive」。
   > 采用纯客户端标准 OAuth 2.0 PKCE + Refresh Token，文件存入 OneDrive 的 `CloudDrop/` 目录，4MB 以上自动启用 Microsoft Graph 分片上传会话。

---

## 核心快捷键与特性

- `Enter` 发送 / `Shift+Enter` 换行（可在设置中切换为 `Ctrl+Enter` 发送）
- `Ctrl+V` 直接粘贴剪贴板截图、图片或文件
- **全窗口拖放**：从资源管理器直接拖入任意文件，空输入框时松手即刻发送
- `Ctrl+K` 或 `/` 聚焦全局搜索（支持搜索文本、文件名、`#标签` 与设备名）
- `Ctrl+B` 展开/收起左侧边栏
- **可选端到端加密（E2EE）**：在「设置 → 端到端加密」填入统一口令后，新内容会先在本地以 `PBKDF2-SHA256 + AES-256-GCM` 加密再上传云盘

---

## 目录结构

```text
├── web/                  # 三端共享核心前端与 PWA（零编译依赖，ES Modules + CSS Tokens）
│   ├── styles/           # DeepSeek HARNESS 风格语义色阶 tokens.css + app.css
│   └── src/
│       ├── providers/    # Google Drive API v3 / OneDrive Graph PKCE / 本地局域网同步
│       ├── sync/         # 无冲突事件日志同步引擎（Outbox + 增量拉取 + 进度追踪）
│       ├── crypto/       # WebCrypto AES-256-GCM 可选端到端加密
│       ├── state/        # IndexedDB 离线缓存 + CRDT 归约器
│       └── ui/           # Markdown 代码高亮、图片灯箱、设置向导
├── desktop/              # Windows & Linux 零依赖伴侣服务与一键启动脚本
├── platforms/
│   ├── tauri/            # Tauri v2 原生三端打包工程 (Windows / Linux / Android)
│   └── android/          # Android Kotlin 原生 WebView + 系统分享菜单封装
├── tests/                # 自动化测试（后端 API + 真浏览器端到端验证）
└── .github/workflows/    # GitHub Pages 自动部署 + 三端原生安装包构建流水线
```
