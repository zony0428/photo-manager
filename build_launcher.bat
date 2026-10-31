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
"%CSC%" /target:winexe /optimize+ /win32icon:frontend\favicon.ico /out:Tetheract.exe launcher\Launcher.cs

if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo [SUCCESS] Tetheract.exe created successfully.
