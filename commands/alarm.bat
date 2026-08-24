@echo off
REM Alarm Sound - Plays beeping alarm
echo Playing alarm...

powershell -Command ^
"for ($i=0; $i -lt 30; $i++) { ^
  [Console]::Beep(1000,200); ^
  [Console]::Beep(800,200); ^
  Start-Sleep -Milliseconds 100 ^
}"

echo Alarm complete.
