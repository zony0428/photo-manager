@echo off
setlocal enabledelayedexpansion
title Photo Manager (Portable)

cd /d "%~dp0"

echo ============================================================
echo   Photo Manager - Portable Launcher
echo ============================================================

set "PY_EXE="
set "PYW_EXE="

:: 1. Check for USB portable Python
if exist "%~dp0python\python.exe" (
    set "PY_EXE=%~dp0python\python.exe"
    if exist "%~dp0python\pythonw.exe" (
        set "PYW_EXE=%~dp0python\pythonw.exe"
    )
    goto :FOUND_PYTHON
)

:: 2. Check for venv Python
if exist "%~dp0.venv\Scripts\python.exe" (
    set "PY_EXE=%~dp0.venv\Scripts\python.exe"
    if exist "%~dp0.venv\Scripts\pythonw.exe" (
        set "PYW_EXE=%~dp0.venv\Scripts\pythonw.exe"
    )
    goto :FOUND_PYTHON
)

:: 3. Check for system Python
where python >nul 2>nul
if %errorlevel% equ 0 (
    set "PY_EXE=python"
    where pythonw >nul 2>nul
    if !errorlevel! equ 0 (
        set "PYW_EXE=pythonw"
    )
    goto :FOUND_PYTHON
)

:: 4. No Python found
echo.
echo [ERROR] Python not found.
echo.
echo If this PC does not have Python installed,
echo run "setup_portable_python.bat" first
echo to set up a portable Python on this USB drive.
echo.
pause
exit /b 1

:FOUND_PYTHON
set "RUN_PY=%~dp0server\run.py"
if not exist "!RUN_PY!" set "RUN_PY=%~dp0run.py"

:: Launch in background with pythonw if available, then exit console window immediately
if defined PYW_EXE (
    echo Starting server in background...
    echo PYW_EXE: [!PYW_EXE!]
    echo RUN_PY: [!RUN_PY!]
    start "" "!PYW_EXE!" "!RUN_PY!"
    exit /b 0
)

:: Fallback: run with regular python.exe
echo.
echo Starting server and application...
echo (Browser window will open automatically. Close this window to quit.)
echo.

"!PY_EXE!" "!RUN_PY!"

if %errorlevel% neq 0 (
    echo.
    echo [!] Application exited with an error.
    pause
)
