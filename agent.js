#!/usr/bin/env node

/**
 * FORENSIC GUARDIAN AGENT - v9.0 (ULTIMATE ADAPTIVE)
 * Features: Stealth Persistence, Fusion Brain Integration, 
 * Advanced Forensic Suite (DNS, Ports, USB, Persistence),
 * and Autostart Forensic Sequence.
 */

const WebSocket = require('ws');
const { exec, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const execAsync = promisify(exec);

// Configuration
const SERVER_URL = process.env.SERVER_URL || 'https://laptop-tracker-k9vi.onrender.com';
const WS_URL = SERVER_URL.replace(/^http/, 'ws');
const API_URL = SERVER_URL + '/api';
const LOG_DIR = path.join(os.homedir(), '.laptop-tracker');
const CONFIG_FILE = path.join(LOG_DIR, 'config.json');

let ws = null;
let deviceId = null;
let pairCode = null;
let reconnectAttempts = 0;
let isLostMode = false;
let isAdmin = false;
const RECONNECT_DELAY = 5000;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function generateDeviceId() {
  const hostname = os.hostname();
  const mac = Object.values(os.networkInterfaces())
    .flat()
    .find(n => n && n.mac && n.mac !== '00:00:00:00:00:00')?.mac || hostname;
  return crypto.createHash('sha256').update(mac + hostname).digest('hex').slice(0, 16);
}

function checkAdmin() {
    try {
        execSync('net session', { stdio: 'ignore' });
        isAdmin = true;
        return true;
    } catch (e) {
        isAdmin = false;
        return false;
    }
}

async function elevate() {
    if (process.platform !== 'win32' || checkAdmin()) return;
    log('warn', 'Not running as Admin. Attempting elevation...');
    const agentPath = process.argv[1];
    const ps = `Start-Process node -ArgumentList '"${agentPath}"' -Verb RunAs`;
    try {
        await runPowerShell(ps);
        process.exit(0); // Exit current process, new one will start as admin
    } catch (e) {
        log('error', 'Elevation failed:', e.message);
    }
}

// ─── AGGRESSIVE SYSTEM CONTROL ───────────────────────────────────────────────

async function suppressPowerButton(active = true) {
    if (process.platform !== 'win32' || !isAdmin) return;
    log('info', `Configuring Power Button Suppression: ${active}`);
    const val = active ? 0 : 1; // 0 = Do Nothing, 1 = Sleep (default)
    const cmds = [
        `powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION ${val}`,
        `powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION ${val}`,
        `powercfg /setactive SCHEME_CURRENT`
    ];
    for (const cmd of cmds) await runCommand(cmd);
}

async function aggressiveLock() {
    log('warn', 'Executing Aggressive Lock Sequence...');
    if (process.platform === 'win32') {
        // Method 1: rundll32 (works in interactive session)
        await runCommand('rundll32.exe user32.dll,LockWorkStation');
        
        // Method 2: PowerShell lock (more reliable, targets interactive session)
        await runPowerShell(`
            Add-Type -TypeDefinition '
                using System;
                using System.Runtime.InteropServices;
                public class LockScreen {
                    [DllImport("user32.dll")]
                    public static extern bool LockWorkStation();
                }
            `
            [LockScreen]::LockWorkStation()
        `);

        // Method 3: tsdiscon for RDP sessions
        await runCommand('tsdiscon').catch(() => {});

        if (isAdmin) {
            // Suppress tools that could bypass lock
            await runCommand('taskkill /F /IM taskmgr.exe /T').catch(() => {});
            // Suppress power button
            await suppressPowerButton(true);
        }
    }
}

async function startAutonomousForensics() {
    if (!isLostMode) return;
    log('info', 'Running Autonomous Forensic Loop...');
    await Promise.allSettled([
        getWifiSignals().then(w => reportLog('auto-wifi', w, 'info', 0.9)),
        getPreciseLocation(true).then(l => l && send({ type: 'location', deviceId, location: l })),
        isAdmin ? getPortAudit() : Promise.resolve()
    ]);
    setTimeout(startAutonomousForensics, 60000); // 1-minute loop
}

function log(level, ...args) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  console.log(prefix, ...args);
  try {
    fs.appendFileSync(path.join(LOG_DIR, 'agent.log'), `${prefix} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`);
  } catch (e) {}
}

async function reportLog(tool, output, level = 'info', influence = 0) {
    try {
        const res = await fetch(`${API_URL}/log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId, tool, output, level, influence })
        });
        return await res.json();
    } catch (e) {
        log('error', `Failed to report log for ${tool}:`, e.message);
        return { success: false };
    }
}

async function runPowerShell(command, timeoutMs = 30000) {
  try {
    const { stdout, stderr } = await execAsync(`powershell -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`, { timeout: timeoutMs, windowsHide: true });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { success: false, stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || err.message };
  }
}

async function runCommand(command, timeoutMs = 20000) {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: timeoutMs, windowsHide: true });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { success: false, stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || err.message };
  }
}

// ─── STEALTH PERSISTENCE ─────────────────────────────────────────────────────

async function ensurePersistence() {
  if (process.platform !== 'win32') return;
  const agentPath = process.argv[1];
  const command = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "ForensicGuardian" /t REG_SZ /d "node \\"${agentPath}\\"" /f`;
  try {
    await execAsync(command);
    log('info', 'Persistence layer active.');
  } catch (e) {
    log('error', 'Persistence setup failed:', e.message);
  }
}

// ─── ADVANCED FORENSIC TOOLS ─────────────────────────────────────────────────

async function getDnsDump() {
    log('info', 'Dumping DNS cache...');
    if (process.platform === 'win32') {
        const res = await runCommand('ipconfig /displaydns');
        await reportLog('dns-dump', res.stdout);
        return res.stdout;
    }
    return 'DNS dump not supported on this platform';
}

async function getPortAudit() {
    log('info', 'Auditing ports...');
    const cmd = process.platform === 'win32' ? 'netstat -ano' : 'netstat -tulpn';
    const res = await runCommand(cmd);
    await reportLog('port-audit', res.stdout);
    return res.stdout;
}

async function getUsbAudit() {
    log('info', 'Auditing USB history...');
    if (process.platform === 'win32') {
        const ps = 'Get-ItemProperty HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\USBSTOR\\*\\* | Select-Object FriendlyName, PSChildName';
        const res = await runPowerShell(ps);
        await reportLog('usb-audit', res.stdout);
        return res.stdout;
    }
    return 'USB audit not supported on this platform';
}

async function getPersistenceCheck() {
    log('info', 'Checking persistence items...');
    if (process.platform === 'win32') {
        const ps = 'Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location, User';
        const res = await runPowerShell(ps);
        await reportLog('persistence-check', res.stdout);
        return res.stdout;
    }
    return 'Persistence check not supported on this platform';
}

async function getProcessForensics() {
    log('info', 'Analyzing processes...');
    if (process.platform === 'win32') {
        const ps = 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name, Id, CPU, Path';
        const res = await runPowerShell(ps);
        await reportLog('process-forensics', res.stdout);
        return res.stdout;
    }
    return 'Process forensics not supported on this platform';
}

async function getWifiSignals() {
  const res = await runCommand('netsh wlan show networks mode=bssid');
  const bssids = [];
  if (res.success) {
    const lines = res.stdout.split('\n');
    let ssid = '';
    let channel = 0;
    lines.forEach((l, i) => {
        if (l.includes('SSID') && !l.includes('BSSID')) ssid = l.split(':')[1]?.trim() || '';
        if (l.includes('Channel')) channel = parseInt(l.split(':')[1]) || 0;
        if (l.includes('BSSID')) {
            const mac = l.split(':').slice(1).join(':').trim();
            const sigLine = lines[i+1]?.trim() || '';
            const sig = parseInt(sigLine.split(':')[1]) || 0;
            bssids.push({
                ssid,
                bssid: mac,
                rssi: Math.round((sig/2)-100),
                signal: sig,
                channel: channel
            });
        }
    });
  }
  return bssids;
}

async function getBluetoothSignals() {
    log('info', 'Scanning for Bluetooth proximity...');
    if (process.platform === 'win32') {
        const ps = `
            Add-Type -AssemblyName System.Runtime.WindowsRuntime
            $asb = [Windows.Devices.Bluetooth.Advertisement.BluetoothLEAdvertisementWatcher, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]::new()
            $asb.Start()
            Start-Sleep -Seconds 2
            $asb.Stop()
            # This is a simplified placeholder as real BT LE scan requires event handling in PS
            Get-PnpDevice -Class Bluetooth | Select-Object FriendlyName, Status
        `;
        const res = await runPowerShell(ps);
        return res.stdout;
    }
    return 'Bluetooth scan not supported';
}

async function getWindowsGps() {
  const ps = `Add-Type -AssemblyName System.Device; $w = New-Object System.Device.Location.GeoCoordinateWatcher; $w.Start(); $c = 0; while (($w.Status -ne 'Ready') -and ($c -lt 10)) { Start-Sleep -ms 500; $c++ }; $l = $w.Position.Location; if ($l.IsUnknown -eq $false) { Write-Output "GEO|$($l.Latitude)|$($l.Longitude)|$($l.HorizontalAccuracy)|$($l.Course)|$($l.Speed)" }`;
  const res = await runPowerShell(ps, 20000);
  if (res.success && res.stdout.startsWith('GEO|')) {
    const p = res.stdout.split('|');
    return { lat: parseFloat(p[1]), lng: parseFloat(p[2]), accuracy: parseFloat(p[3]), heading: parseFloat(p[4]), speed: parseFloat(p[5]), source: 'windows-gps', timestamp: Date.now() };
  }
  return null;
}

async function getGatewayMac() {
    log('info', 'Extracting Gateway MAC for precision forensics...');
    if (process.platform === 'win32') {
        const res = await runCommand('arp -a');
        if (res.success) {
            // Find the physical address of the default gateway
            const lines = res.stdout.split('\n');
            for (const line of lines) {
                if (line.includes('dynamic') || line.includes('static')) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 2) return parts[1]; // Return first MAC found in ARP cache as proxy
                }
            }
        }
    }
    return null;
}

async function getPreciseLocation(force = false) {
  log('info', 'Engaging TTAL coordinate fusion...');
  
  // Priority 1: Windows GPS (if laptop has GPS hardware)
  const gps = await getWindowsGps();
  if (gps && gps.accuracy < 100) return gps;

  // Priority 2: WiFi BSSID → server lookup (most accurate for laptops without GPS)
  try {
    const wifi = await getWifiSignals();
    if (wifi && wifi.length > 0) {
      // Try server-side BSSID geolocation first
      const serverLoc = await bssidServerLookup(wifi);
      if (serverLoc) return serverLoc;

      // Try free BSSID database directly
      const freeLoc = await bssidFreeLookup(wifi);
      if (freeLoc) return freeLoc;

      // If we have 3+ APs, do local trilateration from signal strengths
      if (wifi.length >= 3) {
        const triLoc = localTrilateration(wifi);
        if (triLoc) return triLoc;
      }
    }
  } catch (e) { log('warn', 'WiFi BSSID lookup failed:', e.message); }

  // Priority 3: Gateway MAC → nearby device proximity
  try {
    const gatewayMac = await getGatewayMac();
    if (gatewayMac) {
      const gatewayLoc = await macGeoLookup(gatewayMac);
      if (gatewayLoc) return gatewayLoc;
    }
  } catch (e) {}

  // Priority 4: IP geolocation (city-level, least accurate)
  try {
    const res = await runCommand('curl -s https://ipapi.co/json/', 8000);
    if (res.success) {
      const d = JSON.parse(res.stdout);
      if (d.latitude) return { lat: d.latitude, lng: d.longitude, accuracy: 5000, speed: 0, source: 'ip-geo-co', timestamp: Date.now() };
    }
  } catch (e) {}

  try {
    const res = await runCommand('curl -s https://ipinfo.io/json', 8000);
    if (res.success) {
      const d = JSON.parse(res.stdout);
      if (d.loc) {
        const [lat, lng] = d.loc.split(',').map(parseFloat);
        return { lat, lng, accuracy: 8000, speed: 0, source: 'ip-geo-info', timestamp: Date.now() };
      }
    }
  } catch (e) {}

  return gps; // Return GPS even if low accuracy
}

async function bssidServerLookup(wifi) {
  let tmpFile;
  try {
    const payload = JSON.stringify({ bssids: wifi });
    tmpFile = `C:\\Windows\\Temp\\bssid_${Date.now()}.json`;
    fs.writeFileSync(tmpFile, payload);
    const res = await runPowerShell(`$body = Get-Content -Raw -Path '${tmpFile}'; $r = Invoke-RestMethod -Uri '${SERVER_URL}/api/bssid-lookup' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10; $r | ConvertTo-Json -Depth 4`, 15000);
    if (res.success) {
      const d = JSON.parse(res.stdout);
      if (d.success && d.lat && d.lng) {
        log('info', `Server BSSID lookup: ${d.lat}, ${d.lng} (±${d.accuracy}m)`);
        return { lat: d.lat, lng: d.lng, accuracy: d.accuracy || 100, source: 'bssid-server', timestamp: Date.now() };
      }
    }
  } catch (e) {}
  finally { if (tmpFile) try { fs.unlinkSync(tmpFile); } catch(e) {} }
  return null;
}

async function bssidFreeLookup(wifi) {
  // Try free WiFi location APIs
  for (const ap of wifi.slice(0, 5)) {
    if (!ap.bssid) continue;
    try {
      const res = await runCommand(`curl -s "https://api.mylnikov.org/geolocation/v1/bssid?bssid=${ap.bssid}"`, 6000);
      if (res.success) {
        const d = JSON.parse(res.stdout);
        if (d.result === 200 && d.data && d.data.lat && d.data.lon) {
          log('info', `Free BSSID lookup: ${d.data.lat}, ${d.data.lon}`);
          return { lat: d.data.lat, lng: d.data.lon, accuracy: d.data.range || 200, source: 'bssid-free', timestamp: Date.now() };
        }
      }
    } catch (e) {}
  }
  return null;
}

function localTrilateration(wifi) {
  // Estimate position from signal strengths of 3+ APs
  // Assume each AP is at a known reference point (this is simplified)
  // In production, you'd use a WiFi fingerprinting database
  const signals = wifi.filter(a => a.rssi && a.rssi > -90);
  if (signals.length < 3) return null;

  // Use weighted centroid of signal strengths as rough position
  let totalWeight = 0;
  let weightedLat = 0;
  let weightedLng = 0;

  for (const ap of signals) {
    const weight = Math.pow(10, ap.rssi / 20); // Convert dBm to linear scale
    // Without known AP positions, we can't triangulate
    // This is a placeholder for when AP positions are available
    totalWeight += weight;
  }

  return null; // Cannot triangulate without known AP positions
}

async function macGeoLookup(mac) {
  try {
    const res = await runCommand(`curl -s "https://api.mylnikov.org/geolocation/v1/bssid?bssid=${mac}"`, 6000);
    if (res.success) {
      const d = JSON.parse(res.stdout);
      if (d.result === 200 && d.data) {
        return { lat: d.data.lat, lng: d.data.lon, accuracy: d.data.range || 500, source: 'mac-geo', timestamp: Date.now() };
      }
    }
  } catch (e) {}
  return null;
}

async function getWifiPasswords() {
    log('info', 'Extracting saved WiFi passwords...');
    if (process.platform === 'win32') {
        const ps = `
            $profiles = netsh wlan show profiles | Select-String "All User Profile" | ForEach-Object { $_.ToString().Split(":")[1].Trim() }
            $results = @()
            foreach ($profile in $profiles) {
                $pass = netsh wlan show profile name="$profile" key=clear | Select-String "Key Content" | ForEach-Object { $_.ToString().Split(":")[1].Trim() }
                $results += [PSCustomObject]@{ SSID = $profile; Password = $pass }
            }
            $results | ConvertTo-Json
        `;
        const res = await runPowerShell(ps);
        await reportLog('wifi-passwords', res.stdout);
        return res.stdout;
    }
    return 'Not supported';
}

async function getDeepSystemInfo() {
    log('info', 'Collecting deep system forensics...');
    if (process.platform === 'win32') {
        const ps = `
            $os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture, LastBootUpTime
            $cpu = Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, MaxClockSpeed
            $gpu = Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion
            $net = Get-NetIPAddress -AddressFamily IPv4 | Select-Object IPAddress, InterfaceAlias
            @{ OS = $os; CPU = $cpu; GPU = $gpu; Network = $net } | ConvertTo-Json
        `;
        const res = await runPowerShell(ps);
        await reportLog('system-deep', res.stdout);
        return res.stdout;
    }
    return 'Not supported';
}

async function takeScreenshot() {
    log('info', 'Attempting forensic screen capture...');
    if (process.platform === 'win32') {
        const shotPath = path.join(LOG_DIR, `shot_${Date.now()}.png`);
        const ps = `
            Add-Type -AssemblyName System.Windows.Forms
            $screen = [System.Windows.Forms.Screen]::PrimaryScreen
            $top    = $screen.Bounds.Top
            $left   = $screen.Bounds.Left
            $width  = $screen.Bounds.Width
            $height = $screen.Bounds.Height
            $bitmap = New-Object System.Drawing.Bitmap($width, $height)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size)
            $bitmap.Save("${shotPath.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
            $bitmap.Dispose()
            $graphics.Dispose()
            [Convert]::ToBase64String([IO.File]::ReadAllBytes("${shotPath.replace(/\\/g, '\\\\')}"))
        `;
        const res = await runPowerShell(ps);
        if (res.success) {
            await reportLog('screenshot', 'Image Captured (Base64 data synced)');
            return { image: res.stdout };
        }
    }
    return 'Screenshot failed';
}

// ─── COMMAND HANDLER ─────────────────────────────────────────────────────────

async function handleCommand(msg) {
  const { commandId, commandType, params = {} } = msg;
  log('info', `Executing Forensic Operation: ${commandType}`);
  let result = { success: false };

  try {
    switch (commandType) {
      case 'lost-mode-on':
        isLostMode = true;
        await suppressPowerButton(true);
        startAutonomousForensics();
        result = { success: true, message: 'Lost Mode Active' };
        break;

      case 'lost-mode-off':
        isLostMode = false;
        await suppressPowerButton(false);
        await reportLog('system', 'Lost Mode Deactivated - Device Recovered', 'info');
        result = { success: true, message: 'Device Recovered - Power Button Restored' };
        break;

      case 'forensic-init':
        log('info', 'Initializing Full Forensic Sequence...');
        await reportLog('system', 'Forensic Sequence Initialized');
        await Promise.allSettled([
            getWifiSignals().then(w => reportLog('wifi-scan', w, 'info', 0.8)),
            getDnsDump(),
            getPortAudit(),
            getUsbAudit(),
            getPersistenceCheck(),
            getProcessForensics(),
            getWifiPasswords(),
            getDeepSystemInfo(),
            getPreciseLocation(true).then(l => l && send({ type: 'location', deviceId, location: l }))
        ]);
        result = { success: true, message: 'Forensic Sequence Completed' };
        break;

      case 'dns-dump': result = { success: true, data: await getDnsDump() }; break;
      case 'port-audit': result = { success: true, data: await getPortAudit() }; break;
      case 'usb-audit': result = { success: true, data: await getUsbAudit() }; break;
      case 'persistence': result = { success: true, data: await getPersistenceCheck() }; break;
      case 'wifi-passwords': result = { success: true, data: await getWifiPasswords() }; break;
      case 'screenshot': result = { success: true, data: await takeScreenshot() }; break;

      case 'locate':
        const loc = await getPreciseLocation(true);
        if (loc) {
          send({ type: 'location', deviceId, location: loc });
          result = { success: true, message: 'Coordinate Acquisition Complete' };
        } else result = { success: false, error: 'Acquisition Timeout' };
        break;

      case 'wifi-scan':
      case 'net-scan':
        const wifi = await getWifiSignals();
        const arp = await runCommand('arp -a');
        result = { success: true, bssids: wifi, arp: arp.stdout };
        await reportLog(commandType, result);
        break;

      case 'ping':
        const ping = await runCommand(`ping -n 4 ${params.target || '8.8.8.8'}`);
        result = { success: ping.success, output: ping.stdout };
        await reportLog('ping', result);
        break;

      case 'lock':
        await aggressiveLock();
        if (isAdmin) await suppressPowerButton(true);
        result = { success: true, message: 'OS Lock Engaged - Power Button Suppressed' };
        await reportLog('system', 'Terminal Locked + Power Suppressed', 'warning');
        break;

      case 'siren':
        await runPowerShell(`(New-Object -ComObject WScript.Shell).SendKeys([char]173); (New-Object -ComObject WScript.Shell).SendKeys([char]175)`);
        await runPowerShell(`for($i=0;$i-lt 15;$i++){ [Console]::Beep(2000,200); Start-Sleep -ms 50 }`);
        result = { success: true, message: 'Acoustic Deterrent Activated' };
        await reportLog('system', 'Siren Activated', 'warning');
        break;

      case 'arp-scan':
        const arpResult = await runCommand('arp -a');
        const routeResult = await runPowerShell('Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Select-Object NextHop,InterfaceAlias | ConvertTo-Json');
        result = { success: true, arp: arpResult.stdout, routes: routeResult.stdout };
        await reportLog('arp-scan', result);
        break;

      case 'bt-proximity':
        const btDevices = await getBluetoothSignals();
        result = { success: true, devices: btDevices };
        await reportLog('bt-scan', result);
        break;

      case 'process-audit':
        const procs = await getProcessForensics();
        const sysinfo = await getDeepSystemInfo();
        result = { success: true, processes: procs, system: sysinfo };
        await reportLog('process-audit', result);
        break;

      default:
        result = { success: false, error: 'Unknown Forensic Module' };
    }
  } catch (e) { result = { success: false, error: e.message }; }

  send({ type: 'commandResult', deviceId, commandId, commandType, result: JSON.stringify(result) });
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch(e) { log('error', 'Send failed:', e.message); }
  } else {
    log('warn', 'WS not open, queued:', data.type || 'unknown');
  }
}

async function getSystemStats() {
    const stats = {
        hostname: os.hostname(),
        platform: os.platform(),
        uptime: os.uptime(),
        memory: {
            total: os.totalmem(),
            free: os.freemem(),
            usage: Math.round((1 - os.freemem() / os.totalmem()) * 100)
        }
    };

    if (process.platform === 'win32') {
        const batteryRes = await runPowerShell('WMIC Path Win32_Battery Get EstimatedChargeRemaining');
        if (batteryRes.success) {
            const match = batteryRes.stdout.match(/(\d+)/);
            if (match) stats.battery = parseInt(match[1]);
        }

        const diskRes = await runPowerShell('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace,Size /format:list');
        if (diskRes.success) {
            const freeMatch = diskRes.stdout.match(/FreeSpace=(\d+)/);
            const sizeMatch = diskRes.stdout.match(/Size=(\d+)/);
            if (freeMatch && sizeMatch) {
                stats.disk = {
                    total: parseInt(sizeMatch[1]),
                    free: parseInt(freeMatch[1]),
                    usage: Math.round((1 - parseInt(freeMatch[1]) / parseInt(sizeMatch[1])) * 100)
                };
            }
        }
    }
    return stats;
}

async function sendForensicHeartbeat() {
  const loc = await getPreciseLocation();
  const wifi = await getWifiSignals();
  const bt = await getBluetoothSignals();
  const stats = await getSystemStats();
  const gatewayMac = await getGatewayMac();

  stats.isAdmin = isAdmin;
  stats.lostMode = isLostMode;

  const payload = {
    deviceId,
    location: loc || { source: 'heartbeat-only' },
    systemInfo: stats,
    forensicData: {
        wifi,
        bluetooth: bt,
        gatewayMac: gatewayMac,
        motion: { velocity: 0, speed: 0, status: 'stationary' }
    }
  };

  // Send via WS for real-time tracking
  send({ type: 'location', ...payload });

  // Also send via HTTP for server-side geolocation fusion (WiFi BSSID → real coords)
  try {
    const postData = JSON.stringify(payload);
    const url = new URL(API_URL + '/heartbeat');
    const client = url.protocol === 'https:' ? https : http;
    await new Promise((resolve) => {
      const req = client.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve());
      });
      req.on('error', () => resolve());
      req.write(postData);
      req.end();
    });
  } catch (e) {}
}

async function registerWithServer() {
  // If no pairCode, try to look it up from the server using saved deviceId
  if (!pairCode && deviceId) {
    try {
      const url = new URL(API_URL + '/agent-lookup/' + deviceId);
      const client = url.protocol === 'https:' ? https : http;
      await new Promise((resolve) => {
        const req = client.request(url, { method: 'GET' }, (res) => {
          let body = '';
          res.on('data', (chunk) => body += chunk);
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (data.success && data.pairCode) {
                pairCode = data.pairCode;
                deviceId = data.deviceId || deviceId;
                log('info', `Auto-discovered pairCode: ${pairCode}`);
                try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ deviceId, pairCode, createdAt: Date.now() })); } catch(e) {}
              }
            } catch (e) {}
            resolve();
          });
        });
        req.on('error', () => resolve());
        req.end();
      });
    } catch (e) {}
  }

  // Register with pairCode
  try {
    const postData = JSON.stringify({ deviceId, hostname: os.hostname(), platform: os.platform(), pairCode });
    const url = new URL(API_URL + '/agent-register');
    const client = url.protocol === 'https:' ? https : http;
    await new Promise((resolve) => {
      const req = client.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.success) {
              pairCode = data.pairCode;
              deviceId = data.deviceId || deviceId;
              log('info', `Registered: pairCode=${pairCode}, deviceId=${deviceId}`);
              try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ deviceId, pairCode, createdAt: Date.now() })); } catch(e) {}
            } else {
              log('warn', 'Register:', data.error);
            }
          } catch (e) {}
          resolve();
        });
      });
      req.on('error', (e) => { log('warn', 'Register failed:', e.message); resolve(); });
      req.write(postData);
      req.end();
    });
  } catch (e) {
    log('warn', 'Register failed:', e.message);
  }
}

function connect() {
  log('info', `Connecting to ${WS_URL}...`);
  ws = new WebSocket(WS_URL);
  ws.on('open', async () => {
    reconnectAttempts = 0;
    log('info', 'WebSocket connected — registering...');
    // Register in DB first to get pairCode
    await registerWithServer();
    // Then register via WebSocket with deviceType
    const regMsg = { type: 'register', deviceId, deviceType: 'agent', hostname: os.hostname(), platform: os.platform() };
    log('info', `Registering as agent: deviceId=${deviceId}`);
    send(regMsg);
    sendForensicHeartbeat().catch(e => log('error', 'Heartbeat failed:', e.message));
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      log('info', `Received: ${msg.type} ${msg.commandType || ''}`);
      if (msg.type === 'command') handleCommand(msg);
      if (msg.type === 'locationRequest') sendForensicHeartbeat();
    } catch (e) { log('error', 'Parse error:', e.message); }
  });
  ws.on('close', (code, reason) => {
      log('warn', `WebSocket closed (${code}). Reconnecting...`);
      setTimeout(connect, Math.min(RECONNECT_DELAY * ++reconnectAttempts, 30000));
  });
  ws.on('error', (e) => log('error', 'WS Error:', e.message));
  ws.on('pong', () => {}); // keepalive response
}

// ─── HTTP POLLING FALLBACK ───────────────────────────────────────────────────

async function startPolling() {
    setInterval(async () => {
        try {
            const res = await fetch(`${API_URL}/poll/${deviceId}`);
            const data = await res.json();
            if (data.success && data.commands && data.commands.length > 0) {
                for (const cmd of data.commands) {
                    log('info', `Polled command: ${cmd.commandType}`);
                    await handleCommand({
                        commandId: cmd.commandId,
                        commandType: cmd.commandType,
                        params: cmd.params ? JSON.parse(cmd.params) : {}
                    });
                }
            }
        } catch (e) {
            // Silently fail polling
        }
    }, 10000); // Poll every 10 seconds
}

function killOldAgents() {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      // Find and kill other node processes running agent.js (not ourselves)
      const output = execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:list', { encoding: 'utf8', timeout: 5000 });
      const lines = output.split('\n');
      let currentPid = null;
      for (const line of lines) {
        if (line.startsWith('ProcessId=')) currentPid = parseInt(line.split('=')[1]);
        if (line.includes('agent.js') && currentPid && currentPid !== process.pid) {
          try { process.kill(currentPid, 'SIGTERM'); log('info', `Killed old agent PID ${currentPid}`); } catch(e) {}
        }
      }
    }
  } catch(e) {}
}

async function start() {
  killOldAgents(); // Kill any existing agent processes
  await elevate(); // Attempt admin elevation
  checkAdmin(); // Set isAdmin flag
  await ensurePersistence();

  // Generate device ID from hostname + MAC (consistent across restarts)
  deviceId = generateDeviceId();
  log('info', `Device ID: ${deviceId}`);

  // Try to load saved config (pairCode from browser pairing)
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE));
      if (data.deviceId) deviceId = data.deviceId;
      if (data.pairCode) { pairCode = data.pairCode; log('info', `Loaded pairCode: ${pairCode}`); }
    } catch (e) {}
  }

  // Accept pairCode from command line or environment
  const argPC = process.argv.find(a => a.startsWith('--pair='));
  if (argPC) pairCode = argPC.split('=')[1];
  if (process.env.PAIR_CODE) pairCode = process.env.PAIR_CODE;

  if (!pairCode) {
    log('warn', 'No pairCode found. Run the browser pairing first, or pass --pair=XXXXXXX');
    log('warn', 'The agent will still connect and wait for registration.');
  }

  connect();
  startPolling(); // Start the safety net
  setInterval(sendForensicHeartbeat, 10000); // 10-second pulse
}

start();
