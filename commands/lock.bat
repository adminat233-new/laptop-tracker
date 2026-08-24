@echo off
REM Lock Laptop - Immediately locks the Windows session
echo Locking laptop...
rundll32.exe user32.dll,LockWorkStation
echo Laptop locked.
