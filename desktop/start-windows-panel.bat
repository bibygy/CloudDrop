@echo off
setlocal
cd /d "%~dp0.."
title CloudDrop Panel
echo Starting CloudDrop Edge-Drop Side Panel...

where python >nul 2>nul
if %errorlevel%==0 (
    python desktop\clouddrop.py --panel %*
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        py -3 desktop\clouddrop.py --panel %*
    ) else (
        echo [ERROR] Python 3 was not found in PATH.
        echo Please install Python 3 from https://www.python.org/downloads/
        pause
        exit /b 1
    )
)

if not %errorlevel%==0 pause
