@echo off
setlocal
cd /d "%~dp0.."

where pythonw >nul 2>nul
if %errorlevel%==0 (
    start "" pythonw desktop\clouddrop.py --panel %*
    exit /b 0
)

where pyw >nul 2>nul
if %errorlevel%==0 (
    start "" pyw -3 desktop\clouddrop.py --panel %*
    exit /b 0
)

where python >nul 2>nul
if %errorlevel%==0 (
    python desktop\clouddrop.py --panel %*
    exit /b %errorlevel%
)

echo [ERROR] Python 3 was not found in PATH.
echo Please install Python 3 from https://www.python.org/downloads/
pause
exit /b 1
