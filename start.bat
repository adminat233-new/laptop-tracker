@echo off
title LAPTOP TRACKER v3
color 0A
cls

echo ============================================
echo    LAPTOP TRACKER v3 - UNIFIED
echo ============================================
echo.
echo  1. Open browser to: http://localhost:9999
echo  2. The page will show "Laptop Mode"  
echo  3. Click "Generate New Code"
echo  4. Open same URL on your phone
echo  5. Phone will show "Phone Mode"
echo  6. Enter the code from laptop
echo  7. They will pair automatically!
echo.
echo ============================================
echo.

taskkill /F /IM node.exe >nul 2>&1

set PORT=9999

echo Starting server...
echo.
echo ============================================
echo    OPEN http://localhost:9999
echo ============================================
echo.

node cloud-server.js
