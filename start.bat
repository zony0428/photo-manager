@echo off
setlocal enabledelayedexpansion
title Tetheract Photo Manager (Portable)

:: Identify application root directory (supports running from root or tools/ subfolder)
set "ROOT_DIR=%~dp0"
if not exist "%ROOT_DIR%server\run.py" (
    if exist "%~dp0..\server\run.py" (
        for %%I in ("%~dp0..") do set "ROOT_DIR=%%~fI\"
    )
)
cd /d "%ROOT_DIR%"

echo ============================================================
echo   Tetheract Photo Manager - Portable Launcher
echo ============================================================

set "PY_EXE="
set "PYW_EXE="

:: 1. Check for USB portable Python
if exist "%ROOT_DIR%python\python.exe" (
    set "PY_EXE=%ROOT_DIR%python\python.exe"
    if exist "%ROOT_DIR%python\pythonw.exe" (
        set "PYW_EXE=%ROOT_DIR%python\pythonw.exe"
    )
    goto :FOUND_PYTHON
)

:: 2. Check for venv Python
if exist "%ROOT_DIR%.venv\Scripts\python.exe" (
    set "PY_EXE=%ROOT_DIR%.venv\Scripts\python.exe"
    if exist "%ROOT_DIR%.venv\Scripts\pythonw.exe" (
        set "PYW_EXE=%ROOT_DIR%.venv\Scripts\pythonw.exe"
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
set "RUN_PY=%ROOT_DIR%server\run.py"
if not exist "!RUN_PY!" set "RUN_PY=%ROOT_DIR%run.py"

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
