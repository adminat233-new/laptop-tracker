# FIND Agent Auto-Installer
# Run: powershell -Command "IEX (Invoke-WebRequest -Uri 'https://laptop-tracker-k9vi.onrender.com/agent-installer.ps1' -UseBasicParsing).Content"
param([string]$PairCode, [string]$ServerUrl = "https://laptop-tracker-k9vi.onrender.com")

$ErrorActionPreference = "SilentlyContinue"
$AgentDir = "$env:USERPROFILE\.find-agent"
$AgentFile = "$AgentDir\agent.js"
$ConfigFile = "$AgentDir\config.json"
$TaskName = "FIND-Agent-Persistent"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  FIND Agent Auto-Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Get pair code
if (-not $PairCode) {
    $PairCode = Read-Host "Enter pair code"
}
if (-not $PairCode) {
    Write-Host "No pair code provided. Exiting." -ForegroundColor Red
    exit 1
}

Write-Host "`nPair code: $PairCode" -ForegroundColor Yellow
Write-Host "Server: $ServerUrl" -ForegroundColor Yellow

# Create directory
if (-not (Test-Path $AgentDir)) {
    New-Item -ItemType Directory -Path $AgentDir -Force | Out-Null
    Write-Host "[OK] Created $AgentDir" -ForegroundColor Green
}

# Download agent.js
Write-Host "[..] Downloading agent..." -ForegroundColor Yellow
try {
    Invoke-WebRequest -Uri "$ServerUrl/agent.js" -OutFile $AgentFile -UseBasicParsing -TimeoutSec 30
    Write-Host "[OK] Agent downloaded" -ForegroundColor Green
} catch {
    Write-Host "[FAIL] Download failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Install npm dependencies (ws module)
Write-Host "[..] Installing dependencies..." -ForegroundColor Yellow
Push-Location $AgentDir
try {
    if (-not (Test-Path "package.json")) {
        npm init -y 2>&1 | Out-Null
    }
    npm install ws 2>&1 | Out-Null
    Write-Host "[OK] Dependencies installed" -ForegroundColor Green
} catch {
    Write-Host "[WARN] npm install failed, trying alternative..." -ForegroundColor Yellow
}
Pop-Location

# Save config
$Config = @{
    pairCode = $PairCode
    deviceId = (-join ((1..16) | ForEach-Object { '{0:X}' -f (Get-Random -Maximum 16) }))
    createdAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
} | ConvertTo-Json
Set-Content -Path $ConfigFile -Value $Config
Write-Host "[OK] Config saved" -ForegroundColor Green

# Kill old agents
Write-Host "[..] Stopping old agents..." -ForegroundColor Yellow
Get-Process node -ErrorAction SilentlyContinue | Where-Object {
    try { $_.CommandLine -like "*agent.js*" } catch { $false }
} | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Register Task Scheduler (survives reboots)
Write-Host "[..] Setting up auto-start..." -ForegroundColor Yellow
$Action = New-ScheduledTaskAction -Execute "node" -Argument "`"$AgentFile`" --hidden"
$TriggerLogon = New-ScheduledTaskTrigger -AtLogon
$TriggerBoot = New-ScheduledTaskTrigger -AtStartup
$TriggerBoot.Delay = "PT30S"
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Lowest

try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($TriggerLogon,$TriggerBoot) -Settings $Settings -Principal $Principal -Force | Out-Null
    Write-Host "[OK] Task Scheduler registered" -ForegroundColor Green
} catch {
    # Fallback: registry Run key
    $RegPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    Set-ItemProperty -Path $RegPath -Name "FIND-Agent" -Value "node `"$AgentFile`" --hidden"
    Write-Host "[OK] Registry auto-start set" -ForegroundColor Green
}

# Start agent NOW
Write-Host "[..] Starting agent..." -ForegroundColor Yellow
$proc = Start-Process node -ArgumentList "`"$AgentFile`" --pair=$PairCode" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

# Verify connection
Write-Host "[..] Verifying connection..." -ForegroundColor Yellow
try {
    $status = Invoke-RestMethod -Uri "$ServerUrl/api/pair-info/$PairCode" -TimeoutSec 10
    if ($status.laptop -and $status.laptop.agentConnected) {
        Write-Host "[OK] Agent ONLINE and connected!" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Agent started but may not be connected yet. Check dashboard." -ForegroundColor Yellow
    }
} catch {
    Write-Host "[WARN] Could not verify. Check dashboard." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  DONE! Agent is running." -ForegroundColor Green
Write-Host "  PID: $($proc.Id)" -ForegroundColor Gray
Write-Host "  Auto-restarts on boot/login" -ForegroundColor Gray
Write-Host "  Close this window safely." -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
