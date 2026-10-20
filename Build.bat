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
> "%~dp0autorun.inf" echo [AutoRun]
>> "%~dp0autorun.inf" echo icon=frontend\favicon.ico,0
>> "%~dp0autorun.inf" echo label=Photo Manager

if exist "%~dp0autorun.inf" goto :AUTORUN_OK
echo       [WARN] Failed to create autorun.inf.
goto :BUILD_EXE

:AUTORUN_OK
echo       [OK] autorun.inf created.

:: ------------------------------------------------------------
:: 2. Compile PhotoManager.exe using Windows built-in C# compiler
:: ------------------------------------------------------------
:BUILD_EXE
echo.
echo [2/2] Building PhotoManager.exe...

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
"%CSC%" /nologo /target:winexe /optimize+ /win32icon:"%~dp0frontend\favicon.ico" /out:"%~dp0PhotoManager.exe" "%~dp0launcher\Launcher.cs"
if errorlevel 1 goto :CSC_FAIL
if not exist "%~dp0PhotoManager.exe" goto :CSC_FAIL

echo       [OK] PhotoManager.exe created successfully!
echo.
echo ============================================================
echo   Setup Complete! Launching Photo Manager...
echo   (Next time, just double-click "PhotoManager.exe" to start)
echo ============================================================
echo.

if defined NO_LAUNCH exit /b 0
start "" "%~dp0PhotoManager.exe"
exit /b 0

:CSC_FAIL
echo       [ERROR] Failed to compile PhotoManager.exe.
echo               Launching via start.bat instead...
if defined NO_LAUNCH exit /b 1
call "%~dp0start.bat"
exit /b 1
