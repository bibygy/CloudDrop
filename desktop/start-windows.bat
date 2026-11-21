@echo off
setlocal
cd /d "%~dp0.."
title CloudDrop
echo Starting CloudDrop Desktop...

where python >nul 2>nul
if %errorlevel%==0 (
    python desktop\clouddrop.py %*
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        py -3 desktop\clouddrop.py %*
    ) else (
        echo [ERROR] Python 3 was not found in PATH.
        echo Please install Python 3 from https://www.python.org/downloads/
        pause
        exit /b 1
    )
)

if not %errorlevel%==0 pause
