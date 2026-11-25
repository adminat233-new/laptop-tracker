@echo off
title LAPTOP AGENT
color 0B
cls

echo ============================================
echo    LAPTOP AGENT - Connect to Cloud
echo ============================================
echo.
echo  Enter the 8-character code from the app.
echo  Then paste the device token shown with the authenticated agent command.
echo.
echo ============================================
echo.

set /p PAIR_KEY="Enter Code: "

if "%PAIR_KEY%"=="" (
    echo No code entered. Exiting.
    pause
    exit /b 1
)

echo.
echo Enter cloud server URL (or press Enter for localhost):
set /p CLOUD_SERVER="URL: "

if "%CLOUD_SERVER%"=="" set CLOUD_SERVER=http://localhost:9999

echo.
set /p PAIR_TOKEN="Device token: "
if "%PAIR_TOKEN%"=="" (
    echo No device token entered. Generate an authenticated agent command in the browser.
    pause
    exit /b 1
)
echo.
echo Connecting to %CLOUD_SERVER% with code %PAIR_KEY%...
echo.

set PAIR_CODE=%PAIR_KEY%
set PAIR_TOKEN=%PAIR_TOKEN%
set CLOUD_SERVER=%CLOUD_SERVER%

node agent.js

pause
