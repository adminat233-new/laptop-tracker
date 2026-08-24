@echo off
REM Get Location - Fetches IP-based geolocation
echo Fetching location...

for /f "tokens=*" %%i in ('powershell -Command "Invoke-RestMethod -Uri 'https://ipapi.co/json/' | ConvertTo-Json"') do set LOCATION=%%i

echo %LOCATION%
