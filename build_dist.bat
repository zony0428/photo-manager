@echo off
setlocal
chcp 65001 >nul 2>&1

title Tetheract Photo Manager - Build Distribution (Full ^& Lightweight Update)

:: ================================================================
:: Distribution package builder
::
:: Outputs:
::   1. dist/        - Full standalone package (includes python/ & models/)
::                     Uses robocopy /MIR differential sync so unchanged
::                     python/ and models/ are not re-copied from scratch!
::   2. dist_update/ - Lightweight update package (~few MBs, excludes
::                     python/ and models/ for fast overwrite updates)
::
:: Excluded from both:
::   cache/       - User photo DB & thumbnails (and legacy .cache/)
::   storage/     - App internal storage (and legacy carry/)
::   take_out/    - Export preparation files
::   docs/        - Dev documentation
::   scratch/     - Debug scripts
::   .agents/     - AI customization
::   __pycache__/ - Python cache
:: ================================================================

set "SRC=%~dp0"
set "DIST=%~dp0dist"
set "DIST_UPD=%~dp0dist_update"

echo.
echo ============================================================
echo   Tetheract Photo Manager - Build Distribution Packages
echo ============================================================
echo.
echo   Source          : %SRC%
echo   Full Output     : %DIST%
echo   Lightweight Out : %DIST_UPD%
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

:: --- Prepare output directories ---
:: Note: dist/ is NOT wiped completely so that unchanged python/ and models/
:: can be incrementally synced via robocopy /MIR in under 1 second!
if not exist "%DIST%" mkdir "%DIST%" 2>nul

:: Clean & recreate lightweight dist_update/
if exist "%DIST_UPD%" rmdir /s /q "%DIST_UPD%" 2>nul
if not exist "%DIST_UPD%" mkdir "%DIST_UPD%" 2>nul

:START_COPY
echo [1/4] Syncing folders (Incremental /MIR)...

:: --- frontend/ ---
echo        frontend/       -^> dist/ ^& dist_update/
robocopy "%SRC%frontend" "%DIST%\frontend" /MIR /XD __pycache__ /XF *.orig_backup /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_FRONTEND
robocopy "%SRC%frontend" "%DIST_UPD%\frontend" /MIR /XD __pycache__ /XF *.orig_backup /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_FRONTEND

:: --- server/ ---
echo        server/         -^> dist/ ^& dist_update/
robocopy "%SRC%server" "%DIST%\server" /MIR /XD __pycache__ cache .cache /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_SERVER
robocopy "%SRC%server" "%DIST_UPD%\server" /MIR /XD __pycache__ cache .cache /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_SERVER
goto :COPY_MODELS

:ERR_FRONTEND
echo [ERROR] Failed to copy frontend/.
goto :FAILED

:ERR_SERVER
echo [ERROR] Failed to copy server/.
goto :FAILED

:: --- models/ (Full dist only, incremental /MIR) ---
:COPY_MODELS
if not exist "%SRC%models" goto :COPY_PYTHON
echo        models/         -^> dist/ (incremental sync)
robocopy "%SRC%models" "%DIST%\models" /MIR /XD __pycache__ /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_MODELS

:: Restore tags_embeddings.json from server/ai if missing in models/clip
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

:: --- python/ (Full dist only, incremental /MIR) ---
:COPY_PYTHON
if not exist "%SRC%python" goto :COPY_LICENSES
echo        python/         -^> dist/ (incremental sync)
robocopy "%SRC%python" "%DIST%\python" /MIR /XD __pycache__ /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_PYTHON
goto :COPY_LICENSES

:ERR_PYTHON
echo [ERROR] Failed to copy python/.
goto :FAILED

:COPY_LICENSES
if not exist "%SRC%LICENSES" goto :COPY_FILES
echo        LICENSES/       -^> dist/ ^& dist_update/
robocopy "%SRC%LICENSES" "%DIST%\LICENSES" /MIR /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_LICENSES
robocopy "%SRC%LICENSES" "%DIST_UPD%\LICENSES" /MIR /R:1 /W:1 /NJH /NJS /NDL /NFL /NC /NS >nul
if %errorlevel% geq 8 goto :ERR_LICENSES
goto :COPY_FILES

:ERR_LICENSES
echo [ERROR] Failed to copy LICENSES/.
goto :FAILED

:COPY_FILES
echo.
echo [2/4] Copying startup, docs and setup files...

:: --- Remove legacy filenames from dist/ if present ---
if exist "%DIST%\PhotoManager.exe" del /q "%DIST%\PhotoManager.exe" >nul 2>&1
if exist "%DIST%\PhotoManager_Mobile.html" del /q "%DIST%\PhotoManager_Mobile.html" >nul 2>&1

:: --- Backend core scripts ---
copy /y "%SRC%run.py" "%DIST%\server\run.py" >nul 2>&1
copy /y "%SRC%run.py" "%DIST%\run.py" >nul 2>&1
copy /y "%SRC%run.py" "%DIST_UPD%\server\run.py" >nul 2>&1
copy /y "%SRC%run.py" "%DIST_UPD%\run.py" >nul 2>&1
if not exist "%DIST%\server\run.py" goto :ERR_FILES

:: --- Optional fallback start.bat ---
copy /y "%SRC%start.bat" "%DIST%\server\start.bat" >nul 2>&1
copy /y "%SRC%start.bat" "%DIST%\start.bat" >nul 2>&1
copy /y "%SRC%start.bat" "%DIST_UPD%\server\start.bat" >nul 2>&1
copy /y "%SRC%start.bat" "%DIST_UPD%\start.bat" >nul 2>&1

:: --- Launcher source & fallback Build.bat ---
if not exist "%DIST%\launcher" mkdir "%DIST%\launcher" 2>nul
if not exist "%DIST_UPD%\launcher" mkdir "%DIST_UPD%\launcher" 2>nul
if exist "%SRC%launcher\Launcher.cs" (
    copy /y "%SRC%launcher\Launcher.cs" "%DIST%\launcher\Launcher.cs" >nul 2>&1
    copy /y "%SRC%launcher\Launcher.cs" "%DIST_UPD%\launcher\Launcher.cs" >nul 2>&1
)
if exist "%SRC%Build.bat" (
    copy /y "%SRC%Build.bat" "%DIST%\Build.bat" >nul 2>&1
    copy /y "%SRC%Build.bat" "%DIST_UPD%\Build.bat" >nul 2>&1
)
if not exist "%DIST%\launcher\Launcher.cs" goto :ERR_FILES

:: --- User Documentation, License & Version ---
:: (NOTICE.txt は LICENSES\NOTICE.txt として LICENSES/ ごと同梱済み)
for %%F in (README.md README_EN.md MANUAL.md README_USB.md RELEASE_NOTES.md LICENSE VERSION) do (
    if exist "%SRC%%%F" (
        copy /y "%SRC%%%F" "%DIST%\%%F" >nul 2>&1
        copy /y "%SRC%%%F" "%DIST_UPD%\%%F" >nul 2>&1
    )
)

:: --- Standalone Mobile HTML (Tetheract_Mobile.html) ---
if exist "%SRC%python\python.exe" (
    "%SRC%python\python.exe" "%SRC%server\mobile_bundle.py" >nul 2>&1
)
if exist "%SRC%Tetheract_Mobile.html" (
    echo        Tetheract_Mobile.html
    copy /y "%SRC%Tetheract_Mobile.html" "%DIST%\Tetheract_Mobile.html" >nul 2>&1
    copy /y "%SRC%Tetheract_Mobile.html" "%DIST_UPD%\Tetheract_Mobile.html" >nul 2>&1
)

:: --- Working directories for portable USB (storage & take_out) ---
if not exist "%DIST%\storage" mkdir "%DIST%\storage" 2>nul
if not exist "%DIST%\take_out" mkdir "%DIST%\take_out" 2>nul

goto :BUILD_LAUNCHER

:ERR_FILES
echo [ERROR] Failed to copy startup files.
goto :FAILED

:: --- Build / Copy Tetheract.exe ---
:BUILD_LAUNCHER
echo.
echo [3/4] Generating Tetheract.exe...

set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
    set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

if exist "%CSC%" (
    "%CSC%" /nologo /target:winexe /optimize+ /win32icon:"%SRC%frontend\favicon.ico" /out:"%DIST%\Tetheract.exe" "%SRC%launcher\Launcher.cs" >nul 2>&1
    if exist "%DIST%\Tetheract.exe" (
        copy /y "%DIST%\Tetheract.exe" "%SRC%Tetheract.exe" >nul 2>&1
        copy /y "%DIST%\Tetheract.exe" "%DIST_UPD%\Tetheract.exe" >nul 2>&1
        echo        [OK] Tetheract.exe compiled and bundled.
        goto :MAKE_ZIPS
    )
)

if exist "%SRC%Tetheract.exe" (
    copy /y "%SRC%Tetheract.exe" "%DIST%\Tetheract.exe" >nul 2>&1
    copy /y "%SRC%Tetheract.exe" "%DIST_UPD%\Tetheract.exe" >nul 2>&1
    echo        [OK] Tetheract.exe copied from root.
    goto :MAKE_ZIPS
)

echo [ERROR] Failed to build or copy Tetheract.exe.
goto :FAILED

:: --- Create Release ZIP packages ---
:MAKE_ZIPS
echo.
echo [4/5] Building Release ZIP archives...
if exist "%SRC%python\python.exe" (
    "%SRC%python\python.exe" "%SRC%server\make_release_zips.py"
)

:: --- Verify output ---
:VERIFY
echo.
echo [5/5] Verifying outputs...

set "OK=1"
if not exist "%DIST%\frontend" set "OK=0"
if not exist "%DIST%\server" set "OK=0"
if not exist "%DIST%\server\run.py" set "OK=0"
if not exist "%DIST%\run.py" set "OK=0"
if not exist "%DIST%\Tetheract.exe" set "OK=0"
if not exist "%DIST%\MANUAL.md" set "OK=0"
if not exist "%DIST_UPD%\frontend" set "OK=0"
if not exist "%DIST_UPD%\server" set "OK=0"
if not exist "%DIST_UPD%\Tetheract.exe" set "OK=0"
if exist "%SRC%models" (
    if not exist "%DIST%\models" set "OK=0"
)

if "%OK%"=="0" goto :MAKE_ZIPS_FAIL

echo.
echo ============================================================
echo   [OK] Distribution packages created successfully!
echo ============================================================
echo.
echo   1. Full Package (for first-time users):
echo      %DIST%
echo      (Includes python/ ^& models/)
echo.
echo   2. Lightweight Update Package (for existing users / USB update):
echo      %DIST_UPD%
echo      (Only frontend/, server/, launcher ^& docs - overwrites in 1 sec!)
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
