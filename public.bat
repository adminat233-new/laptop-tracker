@echo off
title Public Access Tunnel
color 0B

echo ============================================
echo    CREATING PUBLIC TUNNEL...
echo ============================================
echo.
echo  Your public URL will appear below.
echo  Open this URL on your phone.
echo.
echo ============================================
echo.

ssh -o StrictHostKeyChecking=no -R 80:localhost:9999 serveo.net
