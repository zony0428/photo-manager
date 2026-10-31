@echo off
setlocal
cd /d "%~dp0"

title Tetheract Photo Manager - Initial Build ^& Setup

echo ============================================================
echo   Tetheract Photo Manager - Launcher Setup (Build.bat)
echo ============================================================
echo.

:: ------------------------------------------------------------
:: 1. Compile Tetheract.exe using Windows built-in C# compiler
:: ------------------------------------------------------------
:BUILD_EXE
echo [1/2] Building Tetheract.exe...

set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if exist "%CSC%" goto :CHECK_CS_SRC
set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if exist "%CSC%" goto :CHECK_CS_SRC

echo       [WARN] Windows C# compiler not found.
echo              Launching via start.bat instead...
call "%~dp0start.bat"
exit /b 0

:CHECK_CS_SRC
if exist "%~dp0launcher\Launcher.cs" goto :RUN_CSC
echo       [ERROR] launcher\Launcher.cs not found.
pause
exit /b 1

:RUN_CSC
"%CSC%" /nologo /target:winexe /optimize+ /win32icon:"%~dp0frontend\favicon.ico" /out:"%~dp0Tetheract.exe" "%~dp0launcher\Launcher.cs"
if errorlevel 1 goto :CSC_FAIL
if not exist "%~dp0Tetheract.exe" goto :CSC_FAIL

echo       [OK] Tetheract.exe created successfully!

:: ------------------------------------------------------------
:: 2. Optional: Generate autorun.inf (only when requested or at drive root)
:: ------------------------------------------------------------
if /i "%~1"=="--autorun" goto :CREATE_AUTORUN
if defined NO_LAUNCH goto :FINISH_BUILD

:: Check if placed directly at the root of a drive (e.g. E:\)
set "CUR_DIR=%~dp0"
if not "%CUR_DIR:~3%"=="" goto :FINISH_BUILD
if exist "%~dp0autorun.inf" goto :FINISH_BUILD

echo.
echo [2/2] USB Drive Root Detected (%CUR_DIR%)
echo       Would you like to create "autorun.inf" for custom USB drive icon?
echo       (Note: Some strict antivirus software may warn about autorun.inf files)
choice /C YN /N /T 5 /D N /M "      Create autorun.inf? [y/N] (Auto-skips in 5s): "
if errorlevel 2 goto :FINISH_BUILD

:CREATE_AUTORUN
> "%~dp0autorun.inf" echo [AutoRun]
>> "%~dp0autorun.inf" echo icon=frontend\favicon.ico,0
>> "%~dp0autorun.inf" echo label=Tetheract Photo Manager
if exist "%~dp0autorun.inf" (
    echo       [OK] autorun.inf created.
)

:FINISH_BUILD
echo.
echo ============================================================
echo   Setup Complete! Launching Tetheract Photo Manager...
echo   (Next time, just double-click "Tetheract.exe" to start)
echo ============================================================
echo.

if defined NO_LAUNCH exit /b 0
start "" "%~dp0Tetheract.exe"
exit /b 0

:CSC_FAIL
echo       [ERROR] Failed to compile Tetheract.exe.
echo               Launching via start.bat instead...
if defined NO_LAUNCH exit /b 1
call "%~dp0start.bat"
exit /b 1
