@echo off
setlocal
chcp 65001 >nul 2>&1

title Photo Manager - Build Distribution

:: ================================================================
:: Distribution package builder
::
:: Excluded:
::   cache/       - User photo DB & thumbnails (and legacy .cache/)
::   carry/       - Temporary imported files
::   take_out/    - Export preparation files
::   docs/        - Dev documentation
::   scratch/     - Debug scripts
::   .agents/     - AI customization
::   dist/        - Previous output
::   __pycache__/ - Python cache
:: ================================================================

set "SRC=%~dp0"
set "DIST=%~dp0dist"

echo.
echo ============================================================
echo   Photo Manager - Build Distribution Package
echo ============================================================
echo.
echo   Source: %SRC%
echo   Output: %DIST%
echo.

:: --- Verify this script is in the right place ---
if not exist "%SRC%run.py" (
    echo [ERROR] run.py not found.
    echo         Place this script in the photo-manager root folder.
    echo.
    pause
    exit /b 1
)
if not exist "%SRC%frontend" (
    echo [ERROR] frontend/ folder not found.
    echo.
    pause
    exit /b 1
)
if not exist "%SRC%server" (
    echo [ERROR] server/ folder not found.
    echo.
    pause
    exit /b 1
)

:: --- Check for portable python (warn only) ---
if not exist "%SRC%python" (
    echo [WARN] python/ folder not found.
    echo        The recipient will need to run setup_portable_python.bat.
    echo.
)

:: --- Remove previous output in dist/ ---
if not exist "%DIST%" goto :MKDIR_DIST

echo Removing previous output in dist/...
rmdir /s /q "%DIST%" 2>nul
ping -n 2 127.0.0.1 >nul
if exist "%DIST%" (
    echo [WARN] Could not remove dist/ folder directly, cleaning contents...
    del /f /q /s "%DIST%\*" >nul 2>&1
    for /d %%p in ("%DIST%\*") do rmdir /s /q "%%p" 2>nul
)

:MKDIR_DIST
if not exist "%DIST%" mkdir "%DIST%" 2>nul

:START_COPY
echo [1/4] Copying folders...

:: --- frontend/ ---
echo        frontend/
robocopy "%SRC%frontend" "%DIST%\frontend" /E /XD __pycache__ /XF *.orig_backup /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_FRONTEND
goto :COPY_SERVER

:ERR_FRONTEND
echo [ERROR] Failed to copy frontend/.
goto :FAILED

:COPY_SERVER
echo        server/
robocopy "%SRC%server" "%DIST%\server" /E /XD __pycache__ cache .cache /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_SERVER
goto :COPY_MODELS

:ERR_SERVER
echo [ERROR] Failed to copy server/.
goto :FAILED

:: --- models/ (AI auto-tagging) ---
:COPY_MODELS
if not exist "%SRC%models" goto :COPY_PYTHON
echo        models/ (AI tagger models - please wait...)
robocopy "%SRC%models" "%DIST%\models" /E /XD __pycache__ /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_MODELS

:: tags_embeddings.json の自動補完（models側になくてもserver/ai/から救済）
if not exist "%DIST%\models\clip\tags_embeddings.json" (
    if exist "%SRC%server\ai\tags_embeddings.json" (
        if not exist "%DIST%\models\clip" mkdir "%DIST%\models\clip" 2>nul
        copy /y "%SRC%server\ai\tags_embeddings.json" "%DIST%\models\clip\tags_embeddings.json" >nul 2>&1
        echo        models/clip/tags_embeddings.json (restored from server/ai)
    )
)
goto :COPY_PYTHON

:ERR_MODELS
echo [ERROR] Failed to copy models/.
goto :FAILED

:COPY_PYTHON
if not exist "%SRC%python" goto :COPY_LICENSES
echo        python/ (4000+ files - please wait...)
robocopy "%SRC%python" "%DIST%\python" /E /XD __pycache__ /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_PYTHON
goto :COPY_LICENSES

:ERR_PYTHON
echo [ERROR] Failed to copy python/.
goto :FAILED

:COPY_LICENSES
if not exist "%SRC%LICENSES" goto :COPY_FILES
echo        LICENSES/
robocopy "%SRC%LICENSES" "%DIST%\LICENSES" /E /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_LICENSES
goto :COPY_FILES

:ERR_LICENSES
echo [ERROR] Failed to copy LICENSES/.
goto :FAILED

:COPY_FILES
echo.
echo [2/4] Copying startup and setup files...

:: --- Backend core scripts ---
echo        server\run.py
copy /y "%SRC%run.py" "%DIST%\server\run.py" >nul 2>&1
echo        run.py
copy /y "%SRC%run.py" "%DIST%\run.py" >nul 2>&1
if not exist "%DIST%\server\run.py" goto :ERR_FILES

:: --- Optional fallback start.bat ---
echo        server\start.bat
copy /y "%SRC%start.bat" "%DIST%\server\start.bat" >nul 2>&1
copy /y "%SRC%start.bat" "%DIST%\start.bat" >nul 2>&1

:: --- Launcher source & fallback Build.bat ---
if not exist "%DIST%\launcher" mkdir "%DIST%\launcher" 2>nul
if exist "%SRC%launcher\Launcher.cs" (
    echo        launcher\Launcher.cs
    copy /y "%SRC%launcher\Launcher.cs" "%DIST%\launcher\Launcher.cs" >nul 2>&1
)
if exist "%SRC%Build.bat" (
    echo        Build.bat
    copy /y "%SRC%Build.bat" "%DIST%\Build.bat" >nul 2>&1
)
if not exist "%DIST%\launcher\Launcher.cs" goto :ERR_FILES

:: --- User Documentation, License & Version ---
if exist "%SRC%README.md" (
    echo        README.md
    copy /y "%SRC%README.md" "%DIST%\README.md" >nul 2>&1
)
if exist "%SRC%README_EN.md" (
    echo        README_EN.md
    copy /y "%SRC%README_EN.md" "%DIST%\README_EN.md" >nul 2>&1
)
if exist "%SRC%MANUAL.md" (
    echo        MANUAL.md
    copy /y "%SRC%MANUAL.md" "%DIST%\MANUAL.md" >nul 2>&1
)
if exist "%SRC%README_USB.md" (
    echo        README_USB.md
    copy /y "%SRC%README_USB.md" "%DIST%\README_USB.md" >nul 2>&1
)
if exist "%SRC%LICENSE" (
    echo        LICENSE
    copy /y "%SRC%LICENSE" "%DIST%\LICENSE" >nul 2>&1
)
if exist "%SRC%VERSION" (
    echo        VERSION
    copy /y "%SRC%VERSION" "%DIST%\VERSION" >nul 2>&1
)

:: --- Standalone Mobile HTML (PhotoManager_Mobile.html) ---
if exist "%SRC%python\python.exe" (
    "%SRC%python\python.exe" "%SRC%server\mobile_bundle.py" >nul 2>&1
)
if exist "%SRC%PhotoManager_Mobile.html" (
    echo        PhotoManager_Mobile.html
    copy /y "%SRC%PhotoManager_Mobile.html" "%DIST%\PhotoManager_Mobile.html" >nul 2>&1
)

:: --- Working directories for portable USB (carry & take_out) ---
if not exist "%DIST%\carry" mkdir "%DIST%\carry" 2>nul
if not exist "%DIST%\take_out" mkdir "%DIST%\take_out" 2>nul

goto :BUILD_LAUNCHER

:ERR_FILES
echo [ERROR] Failed to copy startup files.
goto :FAILED

:: --- Build / Copy PhotoManager.exe ---
:BUILD_LAUNCHER
echo.
echo [3/4] Generating PhotoManager.exe...

:: Build PhotoManager.exe (or copy existing if compiler unavailable)
set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
    set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

if exist "%CSC%" (
    "%CSC%" /nologo /target:winexe /optimize+ /win32icon:"%SRC%frontend\favicon.ico" /out:"%DIST%\PhotoManager.exe" "%SRC%launcher\Launcher.cs" >nul 2>&1
    if exist "%DIST%\PhotoManager.exe" (
        copy /y "%DIST%\PhotoManager.exe" "%SRC%PhotoManager.exe" >nul 2>&1
        echo        [OK] PhotoManager.exe compiled and bundled.
        goto :VERIFY
    )
)

if exist "%SRC%PhotoManager.exe" (
    copy /y "%SRC%PhotoManager.exe" "%DIST%\PhotoManager.exe" >nul 2>&1
    echo        [OK] PhotoManager.exe copied from root.
    goto :VERIFY
)

echo [ERROR] Failed to build or copy PhotoManager.exe.
goto :FAILED

:: --- Verify output ---
:VERIFY
echo.
echo [4/4] Verifying output...

set "OK=1"
if not exist "%DIST%\frontend" set "OK=0"
if not exist "%DIST%\server" set "OK=0"
if not exist "%DIST%\server\run.py" set "OK=0"
if not exist "%DIST%\run.py" set "OK=0"
if not exist "%DIST%\PhotoManager.exe" set "OK=0"
if not exist "%DIST%\MANUAL.md" set "OK=0"
if exist "%SRC%models" (
    if not exist "%DIST%\models" set "OK=0"
)

if "%OK%"=="0" goto :VERIFY_FAIL

echo.
echo ============================================================
echo   [OK] Distribution package created successfully!
echo ============================================================
echo.
echo   Output: %DIST%
echo.
echo   Included launcher files:
echo     - PhotoManager.exe (Native GUI launcher with icon)
echo     - Build.bat        (Fallback launcher re-builder ^& optional USB icon setup)
echo.
echo   How to use / distribute:
echo   1. Zip the contents of "dist" for GitHub Releases, or copy to USB.
echo   2. Double-click "PhotoManager.exe" to launch immediately!
echo ============================================================
echo.
if not defined NO_PAUSE pause
exit /b 0

:VERIFY_FAIL
echo [ERROR] Output folder contents are incomplete.
goto :FAILED

:FAILED
echo.
echo ============================================================
echo   [FAILED] Package build failed. See errors above.
echo ============================================================
echo.
if not defined NO_PAUSE pause
exit /b 1
