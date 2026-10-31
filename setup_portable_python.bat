@echo off
setlocal
cd /d "%~dp0"
title Tetheract Photo Manager - Setup Portable Python

echo ============================================================
echo   Tetheract Photo Manager - Portable Python Auto Setup
echo ============================================================
echo.

:: 1. Download & extract Embeddable Python 3.11.9 if python\python.exe is not present yet
if not exist "%~dp0python\python.exe" (
    echo [1/4] Downloading official Python 3.11.9 Embeddable package...
    powershell -NoProfile -Command ^
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
        "$url = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'; " ^
        "$zip = Join-Path '%~dp0' 'python_embed.zip'; " ^
        "$dest = Join-Path '%~dp0' 'python'; " ^
        "Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing; " ^
        "Expand-Archive -Path $zip -DestinationPath $dest -Force; " ^
        "Remove-Item $zip -Force -ErrorAction SilentlyContinue"
)

if not exist "%~dp0python\python.exe" (
    echo.
    echo [ERROR] Failed to download or extract Portable Python.
    echo         Please check your internet connection and try again.
    echo.
    pause
    exit /b 1
)

:: 2. Run setup_portable_python.py using the extracted portable python\python.exe
"%~dp0python\python.exe" "%~dp0setup_portable_python.py"

echo.
pause
