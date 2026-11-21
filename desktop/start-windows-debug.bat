@echo off
setlocal
cd /d "%~dp0.."
title CloudDrop (Debug Console)
echo Starting CloudDrop with debug console...
python desktop\clouddrop.py %*
if not %errorlevel%==0 pause
