@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo 正在启动 CloudDrop 桌面工作台...
python desktop\clouddrop.py %*
