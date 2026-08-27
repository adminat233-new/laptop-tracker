@echo off
echo ========================================
echo   FIND Agent - Auto Setup
echo ========================================
echo.

:: Check if running as admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: Create agent directory
if not exist "%USERPROFILE%\.laptop-tracker" mkdir "%USERPROFILE%\.laptop-tracker"

:: Copy agent files
echo Copying agent files...
copy /Y "%~dp0agent.js" "%USERPROFILE%\.laptop-tracker\agent.js" >nul 2>&1
copy /Y "%~dp0package.json" "%USERPROFILE%\.laptop-tracker\package.json" >nul 2>&1

:: Install dependencies
echo Installing dependencies...
cd /d "%USERPROFILE%\.laptop-tracker"
if not exist "node_modules" (
    npm install ws --save 2>nul
)

:: Create startup batch
echo Creating startup script...
(
    echo @echo off
    echo cd /d "%USERPROFILE%\.laptop-tracker"
    echo node agent.js
) > "%USERPROFILE%\.laptop-tracker\start-agent.bat"

:: Add to Windows startup via registry
echo Adding to Windows startup...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "FIND-Agent" /t REG_SZ /d "wscript.exe \"%USERPROFILE%\.laptop-tracker\start-agent.vbs\"" /f >nul 2>&1

:: Create VBScript launcher (hidden window)
(
    echo Set WshShell = CreateObject^("WScript.Shell"^)
    echo WshShell.Run chr(34^) ^& "%USERPROFILE%\.laptop-tracker\start-agent.bat" ^& chr(34^), 0, False
) > "%USERPROFILE%\.laptop-tracker\start-agent.vbs"

:: Start agent immediately
echo Starting agent...
start "" /B "%USERPROFILE%\.laptop-tracker\start-agent.bat"

echo.
echo ========================================
echo   Agent installed and started!
echo   It will auto-start on login.
echo ========================================
echo.
pause
