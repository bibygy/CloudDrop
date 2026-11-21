@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows-shortcuts.ps1"
if not %errorlevel%==0 pause
