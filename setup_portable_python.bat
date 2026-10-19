@echo off
cd /d "%~dp0"
title Photo Manager - Setup Portable Python

echo ============================================================
echo   Setting up Portable Python for USB...
echo ============================================================
echo.

where python >nul 2>nul
if %errorlevel% equ 0 (
    python setup_portable_python.py
    goto :DONE
)

echo [INFO] System python not found. Running with powershell bootstrap...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$wc=New-Object Net.WebClient; $wc.DownloadFile('https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip', 'python_embed.zip'); Expand-Archive -Path 'python_embed.zip' -DestinationPath 'python' -Force; Remove-Item 'python_embed.zip'"
if exist "python\python.exe" (
    python\python.exe setup_portable_python.py
)

:DONE
echo.
pause
