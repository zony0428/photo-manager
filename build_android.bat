@echo off
setlocal
cd /d "%~dp0"
title Tetheract Photo Manager - Build Portable Android APK

echo ============================================================
echo   Tetheract Photo Manager - Android APK Auto Builder
echo ============================================================
echo.

if not exist "%~dp0python\python.exe" (
    echo [INFO] Portable Python is not set up yet. Running setup_portable_python.bat first...
    call "%~dp0setup_portable_python.bat"
)

if not exist "%~dp0python\python.exe" (
    echo [ERROR] python\python.exe not found.
    exit /b 1
)

"%~dp0python\python.exe" "%~dp0scripts\build_android_apk.py" %*
set EXIT_CODE=%ERRORLEVEL%

if "%1"=="" (
    echo.
    pause
)

exit /b %EXIT_CODE%
