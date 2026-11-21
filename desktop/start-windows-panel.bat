@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo 正在以 Edge Drop 窄侧栏模式启动 CloudDrop...
python desktop\clouddrop.py --panel %*
