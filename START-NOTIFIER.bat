@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM غيّر الاسم هنا قبل ما تدي النسخة لحد (عمرو / علي / ...)
set "BOT_OWNER=WATCH DOGS TEAM"
title Almaviva Monitor - %BOT_OWNER%

echo ========================================
echo   Almaviva Appointment Monitor
echo   النسخة: %BOT_OWNER%
echo ========================================
echo.

if not exist "%~dp0appointment-notifier.js" (
    echo [!] appointment-notifier.js not found
    pause
    exit /b 1
)

set "NODE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODE (
    for /f "delims=" %%n in ('where node 2^>nul') do (
        echo %%n | findstr /i /c:"\WindowsApps\" >nul
        if errorlevel 1 if not defined NODE set "NODE=%%n"
    )
)

if not defined NODE (
    echo [!] Node.js not found. Install Node then try again.
    pause
    exit /b 1
)

echo Checking port 4185...
netstat -ano | findstr ":4185" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [!] Port 4185 is already in use. Close the old monitor window first, then run again.
    echo     To see it: netstat -ano ^| findstr ":4185"
    pause
    exit /b 1
)

echo Starting monitor in a visible window...
start "Almaviva Monitor - %BOT_OWNER%" "%NODE%" appointment-notifier.js
if errorlevel 1 (
    echo [!] Failed to start Node.
    pause
    exit /b 1
)

echo Waiting for dashboard...
set "OK="
for /L %%i in (1,1,15) do (
    netstat -ano | findstr ":4185" | findstr "LISTENING" >nul 2>&1
    if not errorlevel 1 (
        set "OK=1"
        goto :opened
    )
    timeout /t 1 /nobreak >nul
)

:opened
echo.
if not defined OK (
    echo [!] Monitor did not open on port 4185.
    echo     Check the "Almaviva Monitor" window for errors.
    echo     Or run manually: node appointment-notifier.js
    pause
    exit /b 1
)

echo   Dashboard: http://localhost:4185
echo   Monitor is running in its own visible window.
echo.
start "" "http://localhost:4185"
timeout /t 2 /nobreak >nul
exit /b 0
