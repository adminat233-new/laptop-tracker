@echo off
title Guardian Ultimate - System Boot
color 0b

echo ===================================================
echo    GUARDIAN ULTIMATE - SYSTEM BOOT SEQUENCE
echo ===================================================
echo [SYSTEM] Initializing secure cloud relay...
start /b node cloud-server.js
timeout /t 3 >nul

echo [SYSTEM] Launching target intelligence agent...
start /b node agent.js
timeout /t 2 >nul

echo [SYSTEM] Uplink established. Opening control dashboard...
start http://localhost:9999

echo ===================================================
echo    SYSTEMS ACTIVE - MONITORING TRAJECTORY
echo ===================================================
echo Press Ctrl+C to shutdown all systems.
pause >nul
