@echo off
REM Get System Info - Returns CPU, RAM, Battery, Disk info
echo Collecting system info...

echo === CPU ===
wmic cpu get LoadPercentage,Name /format:list

echo === MEMORY ===
wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /format:list

echo === BATTERY ===
WMIC Path Win32_Battery Get BatteryStatus,EstimatedChargeRemaining /format:list 2>nul || echo No battery detected

echo === DISK ===
wmic logicaldisk where "DeviceID='C:'" get FreeSpace,Size /format:list

echo === PROCESSES ===
tasklist /fo csv /nh | find /c /v ""

echo === HOSTNAME ===
hostname

echo === IP ===
ipconfig | findstr /i "IPv4"

echo Collection complete.
