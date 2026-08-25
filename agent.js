#!/usr/bin/env node

const WebSocket = require('ws');
const { exec } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const crypto = require('crypto');

const execAsync = promisify(exec);

// Configuration
const SERVER_URL = process.env.SERVER_URL || 'wss://laptop-tracker-k9vi.onrender.com';
const DEVICE_TYPE = 'laptop';
const DEVICE_ID = generateDeviceId();
const RECONNECT_DELAY = 5000;
const LOCATION_RATE_LIMIT = 30000;
const LOCATION_REQUEST_COOLDOWN = 10000;
const MAX_RECONNECT_ATTEMPTS = Infinity;
const LOG_DIR = path.join(os.homedir(), '.laptop-tracker');

// State
let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let lastLocationUpdate = 0;
let lastLocationRequest = 0;
let isShuttingDown = false;
let pendingCommands = new Map();

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function generateDeviceId() {
  const hostname = os.hostname();
  const mac = Object.values(os.networkInterfaces())
    .flat()
    .find(n => n && n.mac && n.mac !== '00:00:00:00:00:00')?.mac || hostname;
  return crypto.createHash('sha256').update(mac + hostname).digest('hex').slice(0, 16);
}

function log(level, ...args) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  console.log(prefix, ...args);

  try {
    const logFile = path.join(LOG_DIR, 'agent.log');
    const line = `${prefix} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`;
    fs.appendFileSync(logFile, line);
  } catch (e) {}
}

// ─── Command Execution Helpers ────────────────────────────────────────────────

async function runPowerShell(command, timeoutMs = 15000) {
  try {
    const { stdout, stderr } = await execAsync(
      `powershell -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`,
      { timeout: timeoutMs, windowsHide: true }
    );
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { success: false, stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || err.message };
  }
}

async function runCommand(command, timeoutMs = 15000) {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: timeoutMs, windowsHide: true });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return { success: false, stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || err.message };
  }
}

// ─── Location ─────────────────────────────────────────────────────────────────

async function getWifiLocation() {
  try {
    const result = await runPowerShell(`
      Add-Type -AssemblyName System.Device;
      $watcher = New-Object System.Device.Location.GeoCoordinateWatcher;
      $watcher.Start();
      Start-Sleep -Seconds 3;
      $loc = $watcher.Position.Location;
      if ($loc.IsUnknown -eq $false) {
        Write-Output "$($loc.Latitude)|$($loc.Longitude)|$($loc.HorizontalAccuracy)"
      } else {
        Write-Output "UNKNOWN"
      }
    `, 10000);

    if (result.success && result.stdout && !result.stdout.includes('UNKNOWN')) {
      const [lat, lng, accuracy] = result.stdout.split('|').map(Number);
      if (!isNaN(lat) && !isNaN(lng)) {
        return { lat, lng, accuracy: accuracy || 50, source: 'windows-location' };
      }
    }
  } catch (e) {
    log('warn', 'Windows Location API failed:', e.message);
  }
  return null;
}

async function getIpLocation() {
  try {
    const result = await runCommand('curl -s --max-time 5 https://ipapi.co/json/', 8000);
    if (result.success) {
      const data = JSON.parse(result.stdout);
      if (data.latitude && data.longitude) {
        return {
          lat: data.latitude,
          lng: data.longitude,
          accuracy: 5000,
          source: 'ip-geolocation',
          city: data.city,
          region: data.region,
          country: data.country_name
        };
      }
    }
  } catch (e) {
    log('warn', 'IP geolocation failed:', e.message);
  }
  return null;
}

async function getLocation() {
  const now = Date.now();
  if (now - lastLocationUpdate < LOCATION_RATE_LIMIT) {
    return null;
  }
  lastLocationUpdate = now;

  let location = await getWifiLocation();
  if (!location) {
    location = await getIpLocation();
  }
  if (!location) {
    location = { lat: 0, lng: 0, accuracy: 0, source: 'unavailable' };
  }

  return {
    type: 'location',
    deviceId: DEVICE_ID,
    location: {
      lat: location.lat,
      lng: location.lng,
      accuracy: location.accuracy,
      source: location.source,
      city: location.city,
      region: location.region,
      country: location.country,
      timestamp: new Date().toISOString()
    }
  };
}

// ─── WiFi Scanning ────────────────────────────────────────────────────────────

async function scanWifi() {
  try {
    const result = await runCommand('netsh wlan show networks mode=bssid', 10000);
    if (!result.success) return { error: 'WiFi scan failed', details: result.stderr };

    const networks = [];
    const blocks = result.stdout.split(/(?=SSID \d)/i).filter(b => b.trim());

    for (const block of blocks) {
      const ssidMatch = block.match(/SSID\s+\d+\s*:\s*(.*)/i);
      const signalMatch = block.match(/Signal\s*:\s*(\d+)%/i);
      const authMatch = block.match(/Authentication\s*:\s*(.*)/i);
      const encryptionMatch = block.match(/Encryption\s*:\s*(.*)/i);

      const bssids = [];
      const bssidBlocks = block.split(/BSSID\s+\d/i).slice(1);
      for (const bssidBlock of bssidBlocks) {
        const macMatch = bssidBlock.match(/(\w{2}[:-]\w{2}[:-]\w{2}[:-]\w{2}[:-]\w{2}[:-]\w{2})/i);
        const channelMatch = bssidBlock.match(/Channel\s*:\s*(\d+)/i);
        const rssiMatch = bssidBlock.match(/Signal\s*:\s*(\d+)%/i);
        if (macMatch) {
          bssids.push({
            bssid: macMatch[1],
            channel: channelMatch ? parseInt(channelMatch[1]) : null,
            signalPercent: rssiMatch ? parseInt(rssiMatch[1]) : null,
            rssi: rssiMatch ? Math.round((parseInt(rssiMatch[1]) / 2) - 100) : null
          });
        }
      }

      if (ssidMatch) {
        networks.push({
          ssid: ssidMatch[1].trim() || '<Hidden>',
          signalPercent: signalMatch ? parseInt(signalMatch[1]) : null,
          authentication: authMatch ? authMatch[1].trim() : null,
          encryption: encryptionMatch ? encryptionMatch[1].trim() : null,
          bssids
        });
      }
    }

    return { networks, count: networks.length, timestamp: new Date().toISOString() };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── BLE Scanning ─────────────────────────────────────────────────────────────

async function scanBle() {
  try {
    const psScript = `
      $devices = @()
      try {
        $radio = Get-Service -Name "bthserv" -ErrorAction SilentlyContinue
        if ($radio -and $radio.Status -ne "Running") {
          Start-Service bthserv -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 2
        }
        
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        
        $task = [Windows.Devices.Bluetooth.BluetoothAdapter, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]::DefaultAsync
        $adapter = $task.GetAwaiter().GetResult()
        
        if ($adapter -ne $null) {
          $scanTask = $adapter.GetLeScanResultsAsync()
          $results = $scanTask.GetAwaiter().GetResult()
          
          foreach ($r in $results) {
            $devices += @{
              Address = $r.BluetoothAddress.ToString("X12")
              Name = $r.Advertisement.LocalName
              RSSI = $r.RawSignalStrengthInDBm
            }
          }
        }
      } catch {}
      
      if ($devices.Count -gt 0) {
        $devices | ConvertTo-Json -Compress
      } else {
        Write-Output "[]"
      }
    `;

    const result = await runPowerShell(psScript, 12000);
    if (result.success) {
      try {
        const devices = JSON.parse(result.stdout);
        return { devices: Array.isArray(devices) ? devices : [], count: devices.length, timestamp: new Date().toISOString() };
      } catch {
        return { devices: [], count: 0, timestamp: new Date().toISOString(), note: 'BLE parsing failed' };
      }
    }
    return { devices: [], count: 0, error: result.stderr };
  } catch (e) {
    return { devices: [], count: 0, error: e.message };
  }
}

// ─── System Sounds ────────────────────────────────────────────────────────────

async function playSiren() {
  const psScript = `
    for ($i = 0; $i -lt 5; $i++) {
      [Console]::Beep(800, 300)
      [Console]::Beep(1000, 300)
      [Console]::Beep(1200, 300)
      [Console]::Beep(1000, 300)
    }
    try {
      Add-Type -AssemblyName PresentationCore;
      $player = New-Object System.Media.SoundPlayer;
      [System.Media.SystemSounds]::Hand.Play()
    } catch {}
  `;
  return await runPowerShell(psScript, 15000);
}

async function playAlarm() {
  const psScript = `
    for ($i = 0; $i -lt 10; $i++) {
      [Console]::Beep(1500, 200)
      Start-Sleep -Milliseconds 100
      [Console]::Beep(1000, 200)
      Start-Sleep -Milliseconds 100
    }
  `;
  return await runPowerShell(psScript, 15000);
}

async function playNoise() {
  const psScript = `
    Add-Type -AssemblyName System.Speech;
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;
    $synth.Rate = 2;
    for ($i = 0; $i -lt 3; $i++) {
      $synth.Speak("Warning. Unauthorized access detected. This device has been compromised.");
    }
    $synth.Dispose()
  `;
  return await runPowerShell(psScript, 20000);
}

// ─── System Commands ──────────────────────────────────────────────────────────

async function lockScreen() {
  return await runCommand('rundll32.exe user32.dll,LockWorkStation', 5000);
}

async function shutdownSystem() {
  setTimeout(async () => {
    await runCommand('shutdown /s /t 0', 5000);
  }, 2000);
  return { success: true, stdout: 'Shutdown initiated' };
}

async function networkScan() {
  const netstat = await runCommand('netstat -an', 15000);
  const arp = await runCommand('arp -a', 10000);
  return {
    netstat: netstat.success ? netstat.stdout : netstat.stderr,
    arp: arp.success ? arp.stdout : arp.stderr,
    timestamp: new Date().toISOString()
  };
}

async function getSystemInfo() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  let diskInfo = '';
  try {
    const result = await runPowerShell(
      'Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N="Used";E={[math]::Round($_.Used/1GB,2)}}, @{N="Free";E={[math]::Round($_.Free/1GB,2)}}, @{N="Total";E={[math]::Round(($_.Used+$_.Free)/1GB,2)}} | ConvertTo-Json'
    );
    if (result.success) diskInfo = JSON.parse(result.stdout);
  } catch {}

  let cpuUsage = 0;
  try {
    const result = await runPowerShell(
      '(Get-Counter "\\Processor(_Total)\\% Processor Time").CounterSamples.CookedValue'
    );
    if (result.success) cpuUsage = parseFloat(result.stdout);
  } catch {}

  let temperature = null;
  try {
    const result = await runPowerShell(
      'wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature'
    );
    if (result.success) {
      const match = result.stdout.match(/(\d+)/);
      if (match) temperature = Math.round((parseInt(match[1]) - 2732) / 10);
    }
  } catch {}

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    osVersion: os.release(),
    osType: os.type(),
    uptime: os.uptime(),
    cpu: {
      model: cpus[0]?.model || 'Unknown',
      cores: cpus.length,
      speed: cpus[0]?.speed || 0,
      usage: cpuUsage
    },
    memory: {
      total: totalMem,
      free: freeMem,
      used: totalMem - freeMem,
      usagePercent: Math.round(((totalMem - freeMem) / totalMem) * 100)
    },
    disk: diskInfo,
    temperature,
    network: Object.entries(os.networkInterfaces())
      .flatMap(([name, addrs]) => addrs
        .filter(a => !a.internal && a.family === 'IPv4')
        .map(a => ({ name, address: a.address, mac: a.mac }))),
    timestamp: new Date().toISOString()
  };
}

// ─── Screen Capture ───────────────────────────────────────────────────────────

async function captureScreen() {
  const tmpFile = path.join(os.tmpdir(), `screen_${Date.now()}.png`);

  try {
    const result = await runPowerShell(`
      Add-Type -AssemblyName System.Windows.Forms;
      Add-Type -AssemblyName System.Drawing;
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
      $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height);
      $graphics = [System.Drawing.Graphics]::FromImage($bmp);
      $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
      $bmp.Save('${tmpFile.replace(/\\/g, '\\\\')}');
      $graphics.Dispose();
      $bmp.Dispose();
    `, 15000);

    if (result.success && fs.existsSync(tmpFile)) {
      const data = fs.readFileSync(tmpFile);
      return { success: true, image: data.toString('base64'), format: 'png' };
    }
    return { success: false, error: result.stderr || 'Screenshot capture failed' };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
  }
}

// ─── Camera Access ────────────────────────────────────────────────────────────

async function captureCamera() {
  const tmpFile = path.join(os.tmpdir(), `camera_${Date.now()}.jpg`);

  try {
    let result = await runCommand(
      `ffmpeg -f dshow -i video="Integrated Camera" -frames:v 1 -y "${tmpFile}" 2>&1`,
      10000
    );

    if (!result.success || !fs.existsSync(tmpFile)) {
      result = await runCommand(
        `ffmpeg -f dshow -i video="USB Video Device" -frames:v 1 -y "${tmpFile}" 2>&1`,
        10000
      );
    }

    if (!result.success || !fs.existsSync(tmpFile)) {
      result = await runPowerShell(`
        Add-Type -AssemblyName System.Windows.Forms;
        Add-Type -AssemblyName System.Drawing;
        $devices = Get-PnpDevice -Class Camera -Status OK -ErrorAction SilentlyContinue;
        if ($devices) {
          Write-Output "Camera found: $($devices[0].FriendlyName)"
        } else {
          Write-Output "NO_CAMERA"
        }
      `, 8000);

      return { success: false, error: 'ffmpeg not available or no camera found', details: result.stdout || result.stderr };
    }

    const data = fs.readFileSync(tmpFile);
    return { success: true, image: data.toString('base64'), format: 'jpeg' };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
  }
}

// ─── File Access ──────────────────────────────────────────────────────────────

async function readFile(params) {
  try {
    const filePath = path.resolve(params.path);
    if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };
    const stat = fs.statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) return { success: false, error: 'File too large (>10MB)' };
    const content = fs.readFileSync(filePath, { encoding: params.encoding || 'utf-8' });
    return { success: true, content, size: stat.size, modified: stat.mtime };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function writeFile(params) {
  try {
    const filePath = path.resolve(params.path);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, params.content, { encoding: params.encoding || 'utf-8' });
    return { success: true, path: filePath, size: Buffer.byteLength(params.content) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function listDirectory(params) {
  try {
    const dirPath = path.resolve(params.path || os.homedir());
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items = entries.slice(0, 200).map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      path: path.join(dirPath, e.name)
    }));
    return { success: true, items, count: items.length, path: dirPath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Command Handler ──────────────────────────────────────────────────────────

async function handleCommand(msg) {
  const { commandId, commandType, params } = msg;
  log('info', `Received command: ${commandType} (${commandId})`);

  let result;

  try {
    switch (commandType) {
      case 'siren':
      case 'alarm':
      case 'noise':
        result = commandType === 'siren' ? await playSiren()
               : commandType === 'alarm' ? await playAlarm()
               : await playNoise();
        break;

      case 'lock':
        result = await lockScreen();
        break;

      case 'shutdown':
        result = await shutdownSystem();
        break;

      case 'locate':
      case 'get-location':
        const loc = await getLocation();
        if (loc) send(loc);
        result = { success: true, location: 'sent' };
        break;

      case 'wifi-scan':
      case 'wifiscan':
        result = await scanWifi();
        break;

      case 'ble-scan':
      case 'blescan':
        result = await scanBle();
        break;

      case 'netscan':
      case 'network-scan':
        result = await networkScan();
        break;

      case 'sysinfo':
      case 'system-info':
        result = await getSystemInfo();
        break;

      case 'screenshot':
      case 'screen-capture':
        result = await captureScreen();
        break;

      case 'camera':
      case 'camera-capture':
        result = await captureCamera();
        break;

      case 'read-file':
        result = await readFile(params || {});
        break;

      case 'write-file':
        result = await writeFile(params || {});
        break;

      case 'list-dir':
      case 'list-directory':
        result = await listDirectory(params || {});
        break;

      case 'sensor':
      case 'temperature':
        const tempResult = await runPowerShell(
          'wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature'
        );
        if (tempResult.success) {
          const match = tempResult.stdout.match(/(\d+)/);
          result = { temperature: match ? Math.round((parseInt(match[1]) - 2732) / 10) : null, raw: tempResult.stdout };
        } else {
          result = { temperature: null, error: tempResult.stderr };
        }
        break;

      case 'exec':
      case 'shell':
        if (params && params.command) {
          result = await runCommand(params.command, params.timeout || 30000);
        } else {
          result = { success: false, error: 'No command provided' };
        }
        break;

      default:
        result = { success: false, error: `Unknown command: ${commandType}` };
    }
  } catch (e) {
    result = { success: false, error: e.message };
    log('error', `Command ${commandType} failed:`, e.message);
  }

  send({
    type: 'commandResult',
    deviceId: DEVICE_ID,
    commandId,
    commandType,
    result: typeof result === 'string' ? result : JSON.stringify(result),
    timestamp: new Date().toISOString()
  });
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      log('error', 'Failed to send message:', e.message);
    }
  }
}

async function register() {
  send({
    type: 'register',
    deviceId: DEVICE_ID,
    deviceType: DEVICE_TYPE,
    hostname: os.hostname(),
    platform: os.platform(),
    osType: os.type(),
    osVersion: os.release(),
    arch: os.arch()
  });
  log('info', 'Sent registration for device:', DEVICE_ID);
}

async function sendLocationUpdate() {
  const loc = await getLocation();
  if (loc) send(loc);
}

function connect() {
  if (ws) {
    try { ws.terminate(); } catch {}
  }

  log('info', `Connecting to ${SERVER_URL}...`);
  ws = new WebSocket(SERVER_URL, {
    headers: { 'User-Agent': `LaptopTracker/${DEVICE_ID}` },
    handshakeTimeout: 10000
  });

  ws.on('open', () => {
    log('info', 'Connected to server');
    reconnectAttempts = 0;
    register();
    sendLocationUpdate();
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      log('info', `Received: ${msg.type}`);

      switch (msg.type) {
        case 'registered':
          log('info', `Registration confirmed for device: ${msg.deviceId}`);
          // Send initial location after registration
          setTimeout(() => sendLocationUpdate(), 3000);
          break;
        case 'command':
          await handleCommand(msg);
          break;
        case 'requestLocation':
        case 'locationRequest':
          const now = Date.now();
          if (now - lastLocationRequest > LOCATION_REQUEST_COOLDOWN) {
            lastLocationRequest = now;
            await sendLocationUpdate();
          }
          break;
        case 'ping':
          send({ type: 'pong', deviceId: DEVICE_ID, timestamp: new Date().toISOString() });
          break;
        case 'welcome':
          log('info', 'Server welcome:', msg.message || 'connected');
          break;
        default:
          log('warn', 'Unknown message type:', msg.type);
      }
    } catch (e) {
      log('error', 'Error processing message:', e.message);
    }
  });

  ws.on('close', (code, reason) => {
    log('warn', `Disconnected: code=${code} reason=${reason || 'none'}`);
    if (!isShuttingDown) scheduleReconnect();
  });

  ws.on('error', (err) => {
    log('error', 'WebSocket error:', err.message);
  });

  ws.on('ping', () => {
    if (ws.readyState === WebSocket.OPEN) ws.pong();
  });
}

function scheduleReconnect() {
  if (isShuttingDown) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectAttempts++;
  const delay = Math.min(RECONNECT_DELAY * Math.min(reconnectAttempts, 10), 60000);
  log('info', `Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
  reconnectTimer = setTimeout(connect, delay);
}

// ─── Location Heartbeat ───────────────────────────────────────────────────────

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendLocationUpdate();
  }
}, 120000);

// ─── Shutdown ─────────────────────────────────────────────────────────────────

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('info', `Received ${signal}, shutting down...`);

  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) {
    try { ws.close(1000, 'shutdown'); } catch {}
  }

  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection:', reason);
});

// ─── Start ────────────────────────────────────────────────────────────────────

log('info', '=== Laptop Tracker Agent Starting ===');
log('info', `Device ID: ${DEVICE_ID}`);
log('info', `Server: ${SERVER_URL}`);
log('info', `Platform: ${os.platform()} ${os.release()} (${os.arch()})`);
log('info', `Hostname: ${os.hostname()}`);

connect();
