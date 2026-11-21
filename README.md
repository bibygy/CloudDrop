# CloudDrop

一款致敬微软 **Edge Drop**、界面采用 **DeepSeek HARNESS** 极简视觉语言的跨设备云端投递箱，支持 **Windows / Android / Linux** 三端互通，数据直连个人 **Microsoft OneDrive** 或 **Google Drive**，无任何第三方中转服务器。

---

## 核心特性

- **三端无缝互通**：支持 Windows、Linux 桌面端（静默后台零黑框运行）、Android 原生 APK 及 Web / PWA。
- **数据完全自主**：所有笔记、截图和文件直接保存在用户个人云盘的 `CloudDrop/` 目录中，不经过任何第三方服务器。
- **无冲突同步架构**：基于不可变追加事件日志（`CloudDrop/events/*.json`）+ 独立附件目录（`CloudDrop/files/`），多端离线并发编辑或发送内容不会互相覆盖。
- **DeepSeek HARNESS 清爽美学**：双层语义色阶 Token（`--dsw-static-*` / `--dsw-alias-*`），支持浅色 / 碳灰深色 / 跟随系统零闪烁切换、正文与代码块独立字号调节，以及 **Edge Drop 窄侧栏模式**。
- **高效日常投递**：
  - 支持纯文本、Markdown、代码语法高亮与一键复制、网页链接卡片自动识别
  - 支持 `Ctrl+V` 直接粘贴剪贴板截图、全窗口拖放多文件即发、图片灯箱原图预览
  - 支持全文搜索（`Ctrl+K` / `/`）、分类筛选（全部 / 置顶 / 笔记 / 图片 / 文件 / 链接）、按设备来源与 `#标签` 过滤
- **可选端到端加密（E2EE）**：支持 `PBKDF2-SHA256 + AES-256-GCM` 客户端本地加密后再上传云盘。
- **内置前后端运行日志**：界面内可实时查看、复制、导出脱敏后的运行日志，桌面端自动按 2 MB 轮转落盘，排错一目了然。

---

## 环境要求

- **Windows / Linux 桌面端**：Python 3.10+（仅使用标准库，无需 `pip install` 任何第三方依赖）以及已安装的 Edge / Chrome / Chromium 浏览器。
- **Android 端**：无需本地安装 Android Studio，Fork 或上传本仓库到 GitHub 后即可通过 GitHub Actions 云端自动构建 APK 或部署 PWA。

---

## 快速上手（分平台安装与使用）

### 1. Windows

1. 下载或克隆本仓库到本地任意固定目录（例如 `D:\Apps\CloudDrop`）。
2. **创建桌面与开始菜单快捷方式（推荐）**：
   双击运行 [`desktop/install-windows-shortcuts.bat`](desktop/install-windows-shortcuts.bat)，会自动生成带应用图标的快捷方式（通过 `pythonw.exe` 启动，**无黑框终端窗口**）：
   - 桌面：`CloudDrop`（宽屏工作台模式）
   - 开始菜单 → `CloudDrop` 文件夹：`CloudDrop` 与 `CloudDrop Panel`（430×840 Edge Drop 窄侧栏模式）
3. **日常启动与退出**：
   - 双击桌面 `CloudDrop` 图标即可启动；若后台已在运行，再次双击会直接打开新窗口。
   - 如需彻底关闭静默运行的后台服务，在应用左侧栏点击底部终端图标 `>_`（或「设置 → 运行日志」），点击右下角 **「退出后台服务」** 即可。
4. **其他启动方式**：
   - 手动启动（无黑框）：双击 [`desktop/start-windows.bat`](desktop/start-windows.bat) 或 [`desktop/start-windows-panel.bat`](desktop/start-windows-panel.bat)
   - 带调试终端启动：双击 [`desktop/start-windows-debug.bat`](desktop/start-windows-debug.bat)
   - 开启同 Wi-Fi 局域网免云盘直连：
     ```powershell
     python desktop\clouddrop.py --lan
     ```
   - 指定本地数据目录（可直接指向本机已有的 OneDrive / Google Drive 同步文件夹）：
     ```powershell
     python desktop\clouddrop.py --data-dir "$env:USERPROFILE\OneDrive\CloudDrop"
     ```

---

### 2. Linux

```bash
chmod +x desktop/start-linux.sh desktop/install-linux-desktop.sh
./desktop/start-linux.sh            # 宽屏工作台模式
./desktop/start-linux.sh --panel    # Edge Drop 窄侧栏模式
./desktop/install-linux-desktop.sh  # 注册到系统应用菜单（XDG .desktop）
```

---

### 3. Android（手机与平板）

Android 端提供 **原生 APK** 与 **Web PWA** 两种使用方式，建议根据所选云盘决定：

| 特性对比 | 方式 A：原生 Android APK（GitHub Actions 云端构建） | 方式 B：PWA 独立网页应用（GitHub Pages 部署） |
| :--- | :--- | :--- |
| 桌面图标 & 全屏无地址栏 | 支持 | 支持 |
| 系统「分享」菜单投递文字/图片/文件 | 支持（原生 `ACTION_SEND`） | 支持（Web Share Target） |
| **Microsoft OneDrive（推荐）** | **完整支持**（内置原生无跨域代理，全量历史/图片/文件） | 部分受限（仅同步带元数据的新文本消息） |
| **Google Drive（推荐）** | 受限（Google 策略拦截 WebView OAuth 登录） | **完整支持**（Chrome 原生内核） |

#### 方式 A：通过 GitHub Actions 云端免费构建 Android APK（推荐 OneDrive 用户）

无需在本地安装 Android Studio：

1. 将本仓库 Fork 或完整推送至 GitHub（请确保 `.github/workflows/build-android-apk.yml` 与 `platforms/android/` 目录完整）。
2. 在 GitHub 仓库顶部进入 **Actions** 标签页，在左侧选择 **Build Android APK**。
3. 推送到 `main` / `master` 分支时会自动触发；也可点击右侧 **Run workflow** 手动运行。
4. 等待约 **2~3 分钟**出现绿色对勾 `✓` 后，点进该次运行记录，滑到页面最底部的 **Artifacts** 区域下载 **`CloudDrop-Android-APK`**。
5. 解压得到 `app-debug.apk`，在 Android 手机或平板上安装即可。下载的附件默认保存在手机 `下载/CloudDrop/` 目录。

#### 方式 B：通过 GitHub Pages 部署 PWA 独立应用（推荐 Google Drive 用户）

1. 在 GitHub 仓库顶部进入 **Settings → Pages**。
2. 在 **Build and deployment → Source** 中选择 **GitHub Actions**。
3. 进入 **Actions → Deploy CloudDrop PWA to GitHub Pages**，点击 **Run workflow** 运行（约 30 秒完成）。
4. 在 Android 手机或平板的 **Chrome / Edge** 浏览器中打开生成的 HTTPS 地址（`https://<用户名>.github.io/<仓库名>/`）。
5. 点击浏览器右上角菜单，选择 **「安装应用」** 或 **「添加到主屏幕」**，即可作为独立应用使用并出现在系统分享菜单中。

---

## 配置云盘同步（实现多端互通）

在任意设备打开 CloudDrop，点击左上角云盘状态卡片或右上角齿轮图标进入 **「设置 → 云盘同步」**。界面中会直接展示**当前设备的回调地址**并附带一键复制按钮。

> **多端互通原则**：每台设备独立授权登录。只要在 Windows、Android、Linux 上填写**同一个 Client ID** 并登录**同一个微软账号或 Google 账号**，所有设备就会读写个人云盘里的同一个 `CloudDrop/` 目录，实现实时双向同步。

### 方案 1：接入 Microsoft OneDrive（推荐搭配桌面端 + Android APK）

1. 打开 [Microsoft Entra / Azure 应用注册](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)，点击 **「新注册」**。
2. 名称可填 `CloudDrop`，受支持的账户类型选择：
   - 仅个人使用：**仅个人 Microsoft 账户**（应用设置中选「个人微软账号」）
   - 兼顾工作/学校账号：**任何组织目录和个人 Microsoft 账户**（应用设置中选「Common」）
3. 在 **身份验证（Authentication）** → **添加平台** → 务必选择 **「单页应用程序 (SPA)」**，将所有会用到的设备回调地址全部添加到重定向 URI 列表中并保存：
   - Windows / Linux 桌面端：`http://localhost:4173`
   - Android 原生 APK：`https://appassets.androidplatform.net/assets`
   - GitHub Pages 网页端：`https://<用户名>.github.io/<仓库名>`（建议同时添加末尾带 `/` 的版本）
4. 在 **API 权限** 中确认具备 Microsoft Graph 委托权限：`Files.ReadWrite`、`User.Read`、`offline_access`。
5. 复制应用「概述」页中的 **应用程序（客户端）ID**，填入 CloudDrop 的 **Client ID** 输入框，点击 **「连接 OneDrive」** 完成授权。

> 数据存储位置：OneDrive 根目录下的 `CloudDrop/events/` 与 `CloudDrop/files/`，4 MB 以上文件自动启用 Microsoft Graph 分片上传会话。

### 方案 2：接入 Google Drive（推荐搭配桌面端 + Android Chrome PWA）

1. 打开 [Google Cloud Console](https://console.cloud.google.com/apis/library/drive.googleapis.com)，创建项目并启用 **Google Drive API**。
2. 配置 **OAuth 同意屏幕**（选择「外部」），在 **测试用户** 列表中添加自己的 Gmail 地址。
3. 在 **凭据 → 创建凭据 → OAuth 客户端 ID** 中选择 **Web 应用**，将使用的地址添加到 **「已获授权的 JavaScript 来源」** 与 **「已获授权的重定向 URI」**：
   - Windows / Linux 桌面端：`http://localhost:4173`
   - GitHub Pages 网页端：来源填 `https://<用户名>.github.io`，重定向 URI 填 `https://<用户名>.github.io/<仓库名>`
4. 复制生成的 **Client ID** 填入 CloudDrop 设置，点击 **「连接 Google Drive」** 即可。

> 权限说明：采用最小权限 `drive.file`，CloudDrop 仅可读写自身创建的 `CloudDrop/` 目录，不访问云盘中的其他私人文件；5 MB 以上文件自动启用断点分片续传。

---

## 日常使用与快捷键

| 操作 | 快捷键 / 交互方式 |
| :--- | :--- |
| 发送笔记 | `Enter`（可在「设置 → 外观与排版」切换为 `Ctrl+Enter` 发送） |
| 输入框换行 | `Shift+Enter` |
| 粘贴截图 / 图片 / 文件 | 在窗口内任意位置直接按 `Ctrl+V` |
| 拖放上传文件 | 将文件直接拖入窗口（输入框为空时松手即刻发送；已有文字时自动作为附件随文字发送） |
| 全局全文搜索 | `Ctrl+K` 或按 `/`（支持搜正文、文件名、`#标签`、设备名） |
| 展开 / 收起左侧边栏 | `Ctrl+B` |
| 关闭弹窗 / 灯箱 / 抽屉 | `Esc` |
| 查看前后端运行日志 | 点击左侧栏底部 `>_` 图标，或「设置 → 运行日志」 |

### 端到端加密（E2EE，可选）
- 默认**关闭**，文件明文保存在云盘 `CloudDrop/files/` 中，方便直接在 OneDrive / Google Drive 官方 App 里预览。
- 如需零知识隐私保护，可在 **「设置 → 端到端加密」** 设置同步口令并在各设备输入相同口令解锁，此后新发送的文字与附件均会在本机经 `PBKDF2-SHA256 + AES-256-GCM` 加密后再上传。

### 数据备份与迁移
- 在 **「设置 → 设备与备份」** 中可随时修改本机显示名称（用于在消息流中区分不同设备），并支持一键导出 / 导入全部笔记与事件索引的 JSON 备份文件。

---

## 隐私与安全说明（公开部署 FAQ）

1. **将本仓库公开托管在 GitHub 并启用 GitHub Pages，会泄露个人数据吗？**
   **不会。** GitHub Pages 仅托管静态前端代码（HTML/CSS/JS），不包含任何数据库或用户数据。登录令牌、Client ID 与本地缓存均只保存在各自设备的浏览器/App 本地存储中，云端数据直接点对点同步到用户自己的云盘。他人访问同一个公开网址看到的只是一个完全空白的界面，也无法访问他人的云盘数据。
2. **不要将个人本地目录提交进公开仓库**：
   本地同步数据目录（默认 `~/.clouddrop/data`）、日志文件（`~/.clouddrop/logs`）以及手动导出的 `clouddrop-backup-*.json` 均保存在项目目录之外，请勿手动提交到公开 Git 仓库。

---

## 常见问题排查

- **OneDrive 授权提示 `invalid_request: redirect_uri is not valid`**：
  打开当前设备的 CloudDrop「设置 → 云盘同步」，复制页面上显示的「当前设备回调地址」，检查是否已完整添加到 Azure 应用注册的 **单页应用程序 (SPA)** 重定向 URI 列表并点击了保存。
- **同步异常或想定位报错原因**：
  点击左下角 `>_` 打开 **「运行日志」**，切换查看「前端日志 / 仅警告错误 / 桌面后端日志」，可直接一键复制或导出 `.log` 文件（Token 与签名参数已自动脱敏）。桌面端持久化日志默认位于 `%USERPROFILE%\.clouddrop\logs\clouddrop.log`（Linux 为 `~/.clouddrop/logs/clouddrop.log`）。
- **如何自行构建桌面原生安装包（Tauri v2）**：
  本仓库内置 [`platforms/tauri/`](platforms/tauri/) 工程与 [`.github/workflows/build-native.yml`](.github/workflows/build-native.yml)，在 GitHub Actions 中手动触发 **Build Native Apps** 或推送 `v*` 标签即可云端构建 Windows (`.exe`/`.msi`)、Linux (`.AppImage`/`.deb`) 与 Android (`.apk`) 安装包。

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
│       └── ui/           # Markdown 代码高亮、图片灯箱、设置向导、内置日志控制台
├── desktop/              # Windows & Linux 零依赖伴侣服务、快捷方式安装器与启动脚本
├── platforms/
│   ├── tauri/            # Tauri v2 原生三端打包工程 (Windows / Linux / Android)
│   └── android/          # Android Kotlin 原生 WebView + 系统分享菜单 + 无跨域代理封装
├── tests/                # 自动化测试（后端 API、安全白名单、真浏览器 E2E 验证）
└── .github/workflows/    # GitHub Pages 自动部署 + Android APK / 三端原生构建流水线
```

## 运行自动化测试

```bash
python -m pytest tests -v
```
