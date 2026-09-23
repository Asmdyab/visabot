@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "BOT_OWNER=WATCH DOGS TEAM"
title "Visa Bot API Manager - %BOT_OWNER%"

echo ========================================
echo   Visa Bot API Manager
if defined BOT_OWNER echo   النسخة: %BOT_OWNER%
echo ========================================
echo.
echo Starting configuration server...
echo.

REM If port 3004 is already in use, warn instead of killing (AV-safe)
netstat -ano | findstr ":3004" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [!] Port 3004 is already in use. Close the old manager window first, then run again.
    pause
    exit /b 1
)

timeout /t 2 >nul

setlocal EnableDelayedExpansion

set "CHROME="
set "EDGE="
set "FIREFOX="

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"

if exist "%ProgramFiles%\Mozilla Firefox\firefox.exe" set "FIREFOX=%ProgramFiles%\Mozilla Firefox\firefox.exe"
if exist "%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe" set "FIREFOX=%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"

set "BROWSER_INDEX=0"
if defined CHROME set /a BROWSER_INDEX+=1
if defined EDGE set /a BROWSER_INDEX+=1
if defined FIREFOX set /a BROWSER_INDEX+=1

if "%BROWSER_INDEX%"=="0" (
    echo   [!] No supported browser found - opening with default browser.
    echo.
    echo ========================================
    echo Server started!
    echo ========================================
    echo.
    echo Opening: http://localhost:3004
    echo.
    start "" http://localhost:3004
    echo.
    echo Features:
    echo   - Multi account management
    echo   - Form data control
    echo   - Proxy settings
    echo   - Requests per minute control
    echo   - Rate limiting management
    echo   - Start bot from browser
    echo   - Live logs
    echo.
    echo Press Ctrl+C to stop the server
    echo ========================================
    echo.
    set "PUPPETEER_CACHE_DIR=%~dp0.puppeteer"
    node visa-bot-api-config-server.js
    pause
    exit /b
)

echo.
echo ========================================
echo   Choose browser to open the interface:
echo ========================================
echo.

set "OPTION_NUM=0"
if defined CHROME (
    set /a OPTION_NUM+=1
    echo   [!OPTION_NUM!] Google Chrome
)
if defined EDGE (
    set /a OPTION_NUM+=1
    echo   [!OPTION_NUM!] Microsoft Edge
)
if defined FIREFOX (
    set /a OPTION_NUM+=1
    echo   [!OPTION_NUM!] Mozilla Firefox
)

echo.
echo   [0] Default browser (recommended)
echo.
set /p "BROWSER_CHOICE=Enter browser number then press Enter: "

if not defined BROWSER_CHOICE set "BROWSER_CHOICE=0"

set "OPEN_CMD="
if "%BROWSER_CHOICE%"=="1" if defined CHROME set "OPEN_CMD=%CHROME%"
if "%BROWSER_CHOICE%"=="2" if defined EDGE set "OPEN_CMD=%EDGE%"
if "%BROWSER_CHOICE%"=="3" if defined FIREFOX set "OPEN_CMD=%FIREFOX%"

if "%BROWSER_CHOICE%" neq "0" if not defined OPEN_CMD (
    echo [!] Choice not matched - using default browser.
)

echo.
echo ========================================
echo Server started!
echo ========================================
echo.
echo Opening: http://localhost:3004
echo.

if defined OPEN_CMD (
    start "" "%OPEN_CMD%" "http://localhost:3004"
) else (
    start "" http://localhost:3004
)

echo.
echo Features:
echo   - Multi account management
echo   - Form data control
echo   - Proxy settings
echo   - Requests per minute control
echo   - Rate limiting management
echo   - Start bot from browser
echo   - Live logs
echo.
echo Press Ctrl+C to stop the server
echo ========================================
echo.

set "MANAGER_BROWSER=%OPEN_CMD%"
set "PUPPETEER_CACHE_DIR=%~dp0.puppeteer"
node visa-bot-api-config-server.js

pause
endlocal
