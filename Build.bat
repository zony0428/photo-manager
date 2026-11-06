@echo off
setlocal
chcp 65001 >nul 2>&1

:: Identify application root directory (supports running from root or tools/ subfolder)
set "SCRIPT_DIR=%~dp0"
set "ROOT_DIR=%~dp0"
if not exist "%ROOT_DIR%server\run.py" (
    if exist "%~dp0..\server\run.py" (
        for %%I in ("%~dp0..") do set "ROOT_DIR=%%~fI\"
    )
)
cd /d "%ROOT_DIR%"

title Tetheract Photo Manager - Build Launcher (Tetheract.exe)

echo ============================================================
echo   Tetheract Photo Manager - Launcher Builder (Build.bat)
echo ============================================================
echo.
echo   App Root : %ROOT_DIR%
echo.

:: ------------------------------------------------------------
:: 1. Compile Tetheract.exe using Windows built-in C# compiler
:: ------------------------------------------------------------
echo [1/2] Building Tetheract.exe...

set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if exist "%CSC%" goto :FIND_CS_SRC
set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if exist "%CSC%" goto :FIND_CS_SRC

echo       [WARN] Windows C# compiler not found.
echo              Launching via start.bat instead...
call "%SCRIPT_DIR%start.bat"
exit /b 0

:FIND_CS_SRC
set "CS_SRC="
if exist "%SCRIPT_DIR%Launcher.cs" set "CS_SRC=%SCRIPT_DIR%Launcher.cs"
if not defined CS_SRC if exist "%ROOT_DIR%tools\Launcher.cs" set "CS_SRC=%ROOT_DIR%tools\Launcher.cs"
if not defined CS_SRC if exist "%ROOT_DIR%launcher\Launcher.cs" set "CS_SRC=%ROOT_DIR%launcher\Launcher.cs"

if defined CS_SRC goto :RUN_CSC
echo       [ERROR] Launcher.cs not found in tools\ or launcher\.
pause
exit /b 1

:RUN_CSC
if exist "%ROOT_DIR%PhotoManager.exe" del /f /q "%ROOT_DIR%PhotoManager.exe" >nul 2>&1
if exist "%ROOT_DIR%Tetheract.exe" del /f /q "%ROOT_DIR%Tetheract.exe" >nul 2>&1
"%CSC%" /nologo /target:winexe /optimize+ /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /win32icon:"%ROOT_DIR%frontend\favicon.ico" /out:"%ROOT_DIR%Tetheract.exe" "%CS_SRC%"
if errorlevel 1 goto :CSC_FAIL
if not exist "%ROOT_DIR%Tetheract.exe" goto :CSC_FAIL

if exist "%ROOT_DIR%python\python.exe" (
    "%ROOT_DIR%python\python.exe" -c "import sys; sys.path.insert(0, r'%ROOT_DIR%server'); import pathlib, run; run.refresh_windows_exe_icon(pathlib.Path(r'%ROOT_DIR%Tetheract.exe'))" >nul 2>&1
)

echo       [OK] Tetheract.exe created successfully!

:: ------------------------------------------------------------
:: 2. Optional: Generate autorun.inf
:: ------------------------------------------------------------
if /i "%~1"=="--autorun" goto :CREATE_AUTORUN
if defined NO_LAUNCH goto :FINISH_BUILD
if exist "%ROOT_DIR%autorun.inf" goto :FINISH_BUILD

echo.
echo [2/2] Optional: Create "autorun.inf" for custom drive icon ^& label?
echo       (Recommended when placed at the root of a USB / portable drive)
choice /C YN /N /T 5 /D N /M "      Create autorun.inf? [y/N] (Auto-skips in 5s): "
if errorlevel 2 goto :FINISH_BUILD

:CREATE_AUTORUN
> "%ROOT_DIR%autorun.inf" echo [AutoRun]
>> "%ROOT_DIR%autorun.inf" echo icon=frontend\favicon.ico,0
>> "%ROOT_DIR%autorun.inf" echo label=TETHERACT pm
if exist "%ROOT_DIR%autorun.inf" (
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
start "" "%ROOT_DIR%Tetheract.exe"
exit /b 0

:CSC_FAIL
echo       [ERROR] Failed to compile Tetheract.exe.
echo               Launching via start.bat instead...
if defined NO_LAUNCH exit /b 1
call "%SCRIPT_DIR%start.bat"
exit /b 1
