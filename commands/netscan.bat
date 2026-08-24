@echo off
REM Network Scan - Scans local network for devices
echo Scanning network...

REM Get local IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do set LOCAL_IP=%%a
set LOCAL_IP=%LOCAL_IP: =%

REM Extract subnet
for /f "tokens=1-4 delims=." %%a in ("%LOCAL_IP%") do set SUBNET=%%a.%%b.%%c

echo Local IP: %LOCAL_IP%
echo Scanning subnet: %SUBNET.0/24

echo Devices found:
for /L %%i in (1,1,254) do (
    ping -n 1 -w 100 %SUBNET%.%%i | findstr /i "Reply" >nul && echo %SUBNET%.%%i is online
)

echo Scan complete.
