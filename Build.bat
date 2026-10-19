@echo off
setlocal
cd /d "%~dp0"

title Photo Manager - Initial Build ^& Setup

echo ============================================================
echo   Photo Manager - Launcher ^& USB Icon Setup (Build.bat)
echo ============================================================
echo.

:: ------------------------------------------------------------
:: 1. Generate autorun.inf (for USB drive icon & label)
:: ------------------------------------------------------------
echo [1/2] Generating autorun.inf for USB drive icon...
(
    echo [AutoRun]
    echo icon=frontend\favicon.ico,0
    echo label=Photo Manager
) > "%~dp0autorun.inf"

if exist "%~dp0autorun.inf" (
    echo       [OK] autorun.inf created.
) else (
    echo       [WARN] Failed to create autorun.inf.
)

:: ------------------------------------------------------------
:: 2. Compile PhotoManager.exe using Windows built-in C# compiler
:: ------------------------------------------------------------
echo.
echo [2/2] Building PhotoManager.exe...

set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
    set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

if not exist "%CSC%" (
    echo       [WARN] Windows C# compiler (csc.exe) not found.
    echo              Launching via start.bat instead...
    call "%~dp0start.bat"
    exit /b 0
)

if not exist "%~dp0launcher\Launcher.cs" (
    echo       [ERROR] launcher\Launcher.cs not found.
    pause
    exit /b 1
)

"%CSC%" /nologo /target:winexe /optimize+ /win32icon:frontend\favicon.ico /out:PhotoManager.exe launcher\Launcher.cs

if errorlevel 1 (
    echo       [ERROR] Failed to compile PhotoManager.exe.
    echo               Launching via start.bat instead...
    call "%~dp0start.bat"
    exit /b 1
)

echo       [OK] PhotoManager.exe created successfully!
echo.
echo ============================================================
echo   Setup Complete! Launching Photo Manager...
echo   (Next time, just double-click "PhotoManager.exe" to start)
echo ============================================================
echo.

start "" "%~dp0PhotoManager.exe"
exit /b 0
