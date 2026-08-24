@echo off
REM Siren Alarm - Plays loud siren sound through speakers
REM Usage: siren.bat [duration_seconds]

set DURATION=%1
if "%DURATION%"=="" set DURATION=30

echo Playing siren alarm for %DURATION% seconds...

powershell -Command ^
"Add-Type -AssemblyName System.Media; ^
$frequencies = @(800,1000,1200,1400,1200,1000,800); ^
$sampleRate = 44100; ^
$duration = %DURATION%; ^
$wav = New-Object System.IO.MemoryStream; ^
$writer = New-Object System.IO.BinaryWriter($wav); ^
$writer.Write([byte[]]@(82,73,70,70)); ^
$writer.Write([int]0); ^
$writer.Write([byte[]]@(87,65,86,69)); ^
$writer.Write([byte[]]@(102,109,116,32)); ^
$writer.Write([int]16); ^
$writer.Write([short]1); ^
$writer.Write([short]1); ^
$writer.Write([int]$sampleRate); ^
$writer.Write([int]($sampleRate*2)); ^
$writer.Write([short]2); ^
$writer.Write([short]16); ^
$writer.Write([byte[]]@(100,97,116,97)); ^
$writer.Write([int]($sampleRate*$duration*2)); ^
for($i=0; $i -lt $sampleRate*$duration; $i++) { ^
  $time=$i/$sampleRate; ^
  $fi=[Math]::Floor(($time*4)%%$frequencies.Length); ^
  $freq=$frequencies[$fi]; ^
  $sample=[Math]::Sin(2*[Math]::PI*$freq*$time)*32767*0.8; ^
  $writer.Write([short]$sample) ^
}; ^
$wavPath=\"$env:TEMP\siren.wav\"; ^
[System.IO.File]::WriteAllBytes($wavPath,$wav.ToArray()); ^
$player=New-Object System.Media.SoundPlayer; ^
$player.SoundLocation=$wavPath; ^
$player.PlaySync()"

echo Siren complete.
