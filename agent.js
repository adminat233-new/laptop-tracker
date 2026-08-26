#!/usr/bin/env node

/**
 * FORENSIC GUARDIAN AGENT - v9.0 (ULTIMATE ADAPTIVE)
 * Features: Stealth Persistence, Fusion Brain Integration, 
 * Advanced Forensic Suite (DNS, Ports, USB, Persistence),
 * and Autostart Forensic Sequence.
 */

const WebSocket = require('ws');
const { exec } = require('child_process');
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
const RECONNECT_DELAY = 5000;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

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
    lines.forEach((l, i) => {
        if (l.includes('SSID')) ssid = l.split(':')[1]?.trim() || '';
        if (l.includes('BSSID')) {
            const mac = l.split(':').slice(1).join(':').trim();
            const sigLine = lines[i+1]?.trim() || '';
            const sig = parseInt(sigLine.split(':')[1]) || 0;
            bssids.push({ ssid, bssid: mac, rssi: Math.round((sig/2)-100), signal: sig });
        }
    });
  }
  return bssids;
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

async function getPreciseLocation(force = false) {
  log('info', 'Engaging TTAL coordinate fusion...');
  
  const gps = await getWindowsGps();
  if (gps) return gps;

  try {
    const res = await runCommand('curl -s https://ipapi.co/json/', 8000);
    if (res.success) {
      const d = JSON.parse(res.stdout);
      return { lat: d.latitude, lng: d.longitude, accuracy: 5000, speed: 0, source: 'ip-geo', timestamp: Date.now() };
    }
  } catch (e) {}

  return null;
}

// ─── COMMAND HANDLER ─────────────────────────────────────────────────────────

async function handleCommand(msg) {
  const { commandId, commandType, params = {} } = msg;
  log('info', `Executing Forensic Operation: ${commandType}`);
  let result = { success: false };

  try {
    switch (commandType) {
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
            getPreciseLocation(true).then(l => l && send({ type: 'location', deviceId, location: l }))
        ]);
        result = { success: true, message: 'Forensic Sequence Completed' };
        break;

      case 'dns-dump': result = { success: true, data: await getDnsDump() }; break;
      case 'port-audit': result = { success: true, data: await getPortAudit() }; break;
      case 'usb-audit': result = { success: true, data: await getUsbAudit() }; break;
      case 'persistence': result = { success: true, data: await getPersistenceCheck() }; break;

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
        await runCommand('rundll32.exe user32.dll,LockWorkStation');
        result = { success: true, message: 'Terminal Locked' };
        await reportLog('system', 'Terminal Locked', 'warning');
        break;

      case 'siren':
        await runPowerShell(`(New-Object -ComObject WScript.Shell).SendKeys([char]173); (New-Object -ComObject WScript.Shell).SendKeys([char]175)`);
        await runPowerShell(`for($i=0;$i-lt 15;$i++){ [Console]::Beep(2000,200); Start-Sleep -ms 50 }`);
        result = { success: true, message: 'Acoustic Deterrent Activated' };
        await reportLog('system', 'Siren Activated', 'warning');
        break;

      default:
        result = { success: false, error: 'Unknown Forensic Module' };
    }
  } catch (e) { result = { success: false, error: e.message }; }

  send({ type: 'commandResult', deviceId, commandId, commandType, result: JSON.stringify(result) });
}

function send(data) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }

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
  const stats = await getSystemStats();

  // Include sensor simulations if real sensors are missing on laptop
  const payload = {
    deviceId,
    location: loc || { source: 'heartbeat-only' },
    systemInfo: stats,
    forensicData: {
        wifi,
        motion: { velocity: 0, speed: 0, status: 'stationary' }
    }
  };
  send({ type: 'location', ...payload }); // Send as location update for real-time tracking
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    reconnectAttempts = 0;
    log('info', 'Forensic Tunnel Synchronized');
    send({ type: 'register', deviceId });
    sendForensicHeartbeat();
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'command') handleCommand(msg);
      if (msg.type === 'locationRequest') sendForensicHeartbeat();
    } catch (e) {}
  });
  ws.on('close', () => setTimeout(connect, Math.min(RECONNECT_DELAY * ++reconnectAttempts, 30000)));
  ws.on('error', () => {});
}

async function start() {
  await ensurePersistence();
  if (fs.existsSync(CONFIG_FILE)) {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE));
    deviceId = data.deviceId; pairCode = data.pairCode;
  } else {
    log('warn', 'Agent not initialized. Please run setup.bat first.');
    setTimeout(start, 5000);
    return;
  }
  
  connect();
  setInterval(sendForensicHeartbeat, 10000); // 10-second pulse for brain learning and real-time intelligence
}

start();
