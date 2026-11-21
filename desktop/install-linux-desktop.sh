#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"

mkdir -p "$APP_DIR" "$ICON_DIR"
cp "$ROOT_DIR/web/assets/icon-512.png" "$ICON_DIR/clouddrop.png"
chmod +x "$ROOT_DIR/desktop/start-linux.sh" "$ROOT_DIR/desktop/clouddrop.py"

cat > "$APP_DIR/clouddrop.desktop" <<EOF
[Desktop Entry]
Name=CloudDrop
Comment=跨端清爽云端投递箱 (Google Drive / OneDrive)
Exec=$ROOT_DIR/desktop/start-linux.sh
Icon=clouddrop
Terminal=false
Type=Application
Categories=Utility;Network;
StartupNotify=true
EOF

update-desktop-database "$APP_DIR" 2>/dev/null || true
echo "✓ 已将 CloudDrop 安装到 Linux 应用菜单 ($APP_DIR/clouddrop.desktop)"
