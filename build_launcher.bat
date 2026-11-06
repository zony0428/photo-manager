@echo off
setlocal
cd /d "%~dp0"

set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
    set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

if not exist "%CSC%" (
    echo [ERROR] C# compiler csc.exe not found.
    pause
    exit /b 1
)

echo [INFO] Compiling launcher using %CSC%...
if exist "%~dp0PhotoManager.exe" del /f /q "%~dp0PhotoManager.exe" >nul 2>&1
if exist "%~dp0Tetheract.exe" del /f /q "%~dp0Tetheract.exe" >nul 2>&1
"%CSC%" /nologo /target:winexe /optimize+ /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll /win32icon:"%~dp0frontend\favicon.ico" /out:"%~dp0Tetheract.exe" "%~dp0launcher\Launcher.cs"

if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

if exist "%~dp0python\python.exe" (
    "%~dp0python\python.exe" -c "import pathlib, run; run.refresh_windows_exe_icon(pathlib.Path('Tetheract.exe'))" >nul 2>&1
)

echo [SUCCESS] Tetheract.exe created successfully.
