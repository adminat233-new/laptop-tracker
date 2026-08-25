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
const DEVICE_TYPE = 'agent';
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
  const services = [
    { url: 'https://ip-api.com/json/', parse: (d) => ({ lat: d.lat, lng: d.lon, city: d.city, region: d.regionName, country: d.country }) },
    { url: 'https://ipapi.co/json/', parse: (d) => ({ lat: d.latitude, lng: d.longitude, city: d.city, region: d.region, country: d.country_name }) },
    { url: 'https://ipwho.is/', parse: (d) => ({ lat: d.latitude, lng: d.longitude, city: d.city, region: d.region, country: d.country }) },
    { url: 'https://freeipapi.com/api/json', parse: (d) => ({ lat: d.latitude, lng: d.longitude, city: d.city, region: d.regionName, country: d.countryName }) },
  ];

  for (const svc of services) {
    try {
      const result = await runCommand(`curl -s --max-time 5 "${svc.url}"`, 8000);
      if (result.success && result.stdout && result.stdout.startsWith('{')) {
        const data = JSON.parse(result.stdout);
        const parsed = svc.parse(data);
        if (parsed.lat && parsed.lng && parsed.lat !== 0) {
          log('info', `IP location: ${parsed.city}, ${parsed.country} via ${svc.url}`);
          return { ...parsed, accuracy: 5000, source: 'ip-geolocation' };
        }
      }
    } catch (e) {}
  }
  log('warn', 'All IP geolocation services failed');
  return null;
}

async function getLocation() {
  const now = Date.now();
  if (now - lastLocationUpdate < LOCATION_RATE_LIMIT) {
    return null;
  }
  lastLocationUpdate = now;

  let location = await getWindowsLocation();
  if (!location || location.lat === 0) location = await getWifiLocation();
  if (!location || location.lat === 0) location = await getIpLocation();
  if (!location || location.lat === 0) {
    location = null; // Never return 0,0 as valid
  }

  if (!location) return null;

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

// ─── Windows Location Service (force enable + query) ───────────────────────
async function getWindowsLocation() {
  try {
    // Step 1: Check if Windows Location Service is running, force start it
    const svcCheck = await runPowerShell(`
      $svc = Get-Service -Name "lfsvc" -ErrorAction SilentlyContinue
      if ($svc) {
        if ($svc.Status -ne "Running") {
          Start-Service -Name "lfsvc" -Force -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 2
        }
        Write-Output "SERVICE_RUNNING"
      } else {
        Write-Output "SERVICE_NOT_FOUND"
      }
    `, 8000);

    log('info', 'Location Service status:', svcCheck.stdout ? svcCheck.stdout.trim() : 'unknown');

    // Step 2: Try Windows.Devices.Geolocation (modern API via PowerShell UWP bridge)
    const geoResult = await runPowerShell(`
      Add-Type -AssemblyName System.Device
      $watcher = New-Object System.Device.Location.GeoCoordinateWatcher
      $watcher.Start()
      Start-Sleep -Seconds 5
      $loc = $watcher.Position.Location
      if ($loc.IsUnknown -eq $false) {
        $lat = $loc.Latitude
        $lng = $loc.Longitude
        $acc = $loc.HorizontalAccuracy
        Write-Output "GEO|$lat|$lng|$acc"
      } else {
        # Try Windows Location Provider directly via registry
        $regPath = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location"
        $val = (Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue).Value
        if ($val -eq "Allow") {
          Write-Output "LOCATION_ALLOWED_BUT_NO_FIX"
        } else {
          # Force enable location access
          Set-ItemProperty -Path $regPath -Name "Value" -Value "Allow" -Force -ErrorAction SilentlyContinue
          Write-Output "LOCATION_WAS_DISABLED_NOW_ENABLED"
        }
      }
    `, 12000);

    if (geoResult.success && geoResult.stdout) {
      const output = geoResult.stdout.trim();
      log('info', 'Location query result:', output);

      if (output.startsWith('GEO|')) {
        const parts = output.split('|');
        const lat = parseFloat(parts[1]);
        const lng = parseFloat(parts[2]);
        const accuracy = parseFloat(parts[3]) || 50;
        if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
          log('info', `Windows Location: ${lat}, ${lng} (±${accuracy}m)`);
          return { lat, lng, accuracy, source: 'windows-location-api' };
        }
      }

      if (output.includes('LOCATION_WAS_DISABLED_NOW_ENABLED')) {
        log('info', 'Location was disabled — now enabled. Retrying...');
        // Retry after enabling
        const retry = await runPowerShell(`
          $watcher = New-Object System.Device.Location.GeoCoordinateWatcher
          $watcher.Start()
          Start-Sleep -Seconds 5
          $loc = $watcher.Position.Location
          if ($loc.IsUnknown -eq $false) {
            Write-Output "GEO|$($loc.Latitude)|$($loc.Longitude)|$($loc.HorizontalAccuracy)"
          } else {
            Write-Output "STILL_NO_FIX"
          }
        `, 10000);
        if (retry.success && retry.stdout.startsWith('GEO|')) {
          const p = retry.stdout.split('|');
          const lat = parseFloat(p[1]), lng = parseFloat(p[2]);
          if (!isNaN(lat) && !isNaN(lng) && lat !== 0) {
            return { lat, lng, accuracy: parseFloat(p[3]) || 50, source: 'windows-location-retry' };
          }
        }
      }
    }
  } catch (e) {
    log('warn', 'Windows Location API failed:', e.message);
  }
  return null;
}

// ─── WiFi Scanning ────────────────────────────────────────────────────────────

async function scanWifi() {
  const networks = [];
  let tool = 'netsh';

  // Method 1: netsh (always available on Windows)
  try {
    const result = await runCommand('netsh wlan show networks mode=bssid', 10000);
    if (result.success && result.stdout) {
      const blocks = result.stdout.split(/(?=SSID \d)/i).filter(b => b.trim());
      for (const block of blocks) {
        const ssidMatch = block.match(/SSID\s+\d+\s*:\s*(.*)/i);
        const signalMatch = block.match(/Signal\s*:\s*(\d+)%/i);
        const authMatch = block.match(/Authentication\s*:\s*(.*)/i);
        const encryptionMatch = block.match(/Encryption\s*:\s*(.*)/i);
        const channelMatch = block.match(/Channel\s*:\s*(\d+)/i);

        const bssids = [];
        const bssidBlocks = block.split(/BSSID\s+\d/i).slice(1);
        for (const bssidBlock of bssidBlocks) {
          const macMatch = bssidBlock.match(/(\w{2}[:-]\w{2}[:-]\w{2}[:-]\w{2}[:-]\w{2}[:-]\w{2})/i);
          const bssidChannelMatch = bssidBlock.match(/Channel\s*:\s*(\d+)/i);
          const rssiMatch = bssidBlock.match(/Signal\s*:\s*(\d+)%/i);
          if (macMatch) {
            const pct = rssiMatch ? parseInt(rssiMatch[1]) : 0;
            bssids.push({
              bssid: macMatch[1],
              channel: bssidChannelMatch ? parseInt(bssidChannelMatch[1]) : null,
              signalPercent: pct,
              rssi: pct > 0 ? Math.round((pct / 2) - 100) : null
            });
          }
        }

        if (ssidMatch) {
          const pct = signalMatch ? parseInt(signalMatch[1]) : 0;
          networks.push({
            ssid: ssidMatch[1].trim() || '<Hidden>',
            signalPercent: pct,
            rssi: pct > 0 ? Math.round((pct / 2) - 100) : null,
            authentication: authMatch ? authMatch[1].trim() : null,
            encryption: encryptionMatch ? encryptionMatch[1].trim() : null,
            channel: channelMatch ? parseInt(channelMatch[1]) : null,
            bssids
          });
        }
      }
    }
  } catch (e) { log('warn', 'netsh scan failed:', e.message); }

  // Method 2: tshark (Wireshark CLI) — captures probe requests for hidden networks
  if (networks.length === 0) {
    try {
      const tsharkCheck = await runCommand('where tshark', 3000);
      if (tsharkCheck.success) {
        tool = 'tshark';
        const result = await runCommand(
          'tshark -i 1 -a duration:5 -Y "wlan.fc.type_subtype == 0x04 || wlan.fc.type_subtype == 0x05" -T fields -e wlan.ssid -e wlan.sa -e radiotap.dbm.antsignal 2>nul',
          15000
        );
        if (result.success && result.stdout) {
          const seen = new Set();
          for (const line of result.stdout.split('\n')) {
            const parts = line.trim().split('\t');
            if (parts.length >= 2 && parts[0] && !seen.has(parts[0])) {
              seen.add(parts[0]);
              networks.push({
                ssid: parts[0] || '<Hidden>',
                bssid: parts[1] || null,
                rssi: parts[2] ? parseInt(parts[2]) : null,
                source: 'tshark-probe'
              });
            }
          }
        }
      }
    } catch (e) { log('warn', 'tshark scan failed:', e.message); }
  }

  // Method 3: airodump-ng (aircrack-ng suite) — monitor mode scan
  if (networks.length === 0) {
    try {
      const airCheck = await runCommand('where airodump-ng', 3000);
      if (airCheck.success) {
        tool = 'airodump-ng';
        const result = await runCommand(
          'airodump-ng --write-interval 3 --output-format csv -f 500 1 2>nul',
          12000
        );
        if (result.success && result.stdout) {
          const lines = result.stdout.split('\n');
          for (const line of lines) {
            const parts = line.split(',');
            if (parts.length >= 14 && parts[0].match(/^[\w:]{17}$/)) {
              networks.push({
                bssid: parts[0].trim(),
                signal: parts[8] ? parseInt(parts[8]) : null,
                channel: parts[3] ? parseInt(parts[3]) : null,
                ssid: parts[13] ? parts[13].trim() : '<Hidden>',
                privacy: parts[5] ? parts[5].trim() : null,
                source: 'airodump-ng'
              });
            }
          }
        }
      }
    } catch (e) { log('warn', 'airodump-ng scan failed:', e.message); }
  }

  // Add MAC vendor lookup
  for (const net of networks) {
    if (net.bssid) {
      net.vendor = lookupMacVendor(net.bssid);
    }
    if (net.bssids) {
      for (const b of net.bssids) {
        if (b.bssid) b.vendor = lookupMacVendor(b.bssid);
      }
    }
  }

  // Post results to server so phone can read them
  try {
    const http = require('http');
    const https = require('https');
    const postData = JSON.stringify({ deviceId: DEVICE_ID, networks, tool, raw: '' });
    const url = new URL(SERVER_URL.replace('wss:', 'https:').replace('ws:', 'http:') + '/api/netscan');
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } });
    req.write(postData);
    req.end();
  } catch (e) {}

  return { networks, count: networks.length, tool, timestamp: new Date().toISOString() };
}

function lookupMacVendor(mac) {
  if (!mac) return null;
  const prefix = mac.replace(/[:-]/g, '').substring(0, 6).toUpperCase();
  const VENDORS = {
    '00146C': 'Cisco', '001A2B': 'Alcatel', '0026AB': 'Apple', '3C22FB': 'Apple',
    'A483E7': 'Apple', 'F01898': 'Apple', 'DC4F22': 'Apple', '787B8A': 'Apple',
    '00904C': 'Epigram', '001B2F': 'Belkin', 'C056E3': 'Belkin', 'B4750E': 'Belkin',
    '94103E': 'Belkin', 'EC1A59': 'Belkin', '083669': 'Belkin', 'B01123': 'Belkin',
    'E063DA': 'Ubiquiti', '24A43C': 'Ubiquiti', 'F4E2C6': 'Ubiquiti',
    '000C29': 'VMware', '005056': 'VMware', '000569': 'VMware',
    '080027': 'Oracle', '525400': 'QEMU',
    '00155D': 'Microsoft', '281878': 'Microsoft', '7C1E52': 'Microsoft',
    '000D3A': 'Microsoft', 'B831B5': 'Microsoft', '281878': 'Microsoft',
    '6045BD': 'Microsoft', '5882A8': 'Microsoft', '7C1E52': 'Microsoft',
  };
  return VENDORS[prefix] || null;
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

// ─── Network Ping & Traceroute ────────────────────────────────────────────────

async function runPingTrace() {
  const targets = [
    '8.8.8.8',        // Google DNS
    '1.1.1.1',        // Cloudflare DNS
    '208.67.222.222', // OpenDNS
    '9.9.9.9',        // Quad9
  ];

  const hops = [];
  const pingResults = [];

  // Ping each target for latency
  for (const target of targets) {
    try {
      const result = await runCommand(`ping -n 3 -w 2000 ${target}`, 8000);
      if (result.success) {
        const avgMatch = result.stdout.match(/Average\s*=\s*(\d+)ms/i);
        const minMatch = result.stdout.match(/Minimum\s*=\s*(\d+)ms/i);
        const maxMatch = result.stdout.match(/Maximum\s*=\s*(\d+)ms/i);
        const lossMatch = result.stdout.match(/(\d+)%\s*loss/i);
        pingResults.push({
          target,
          avgMs: avgMatch ? parseInt(avgMatch[1]) : null,
          minMs: minMatch ? parseInt(minMatch[1]) : null,
          maxMs: maxMatch ? parseInt(maxMatch[1]) : null,
          lossPercent: lossMatch ? parseInt(lossMatch[1]) : 100,
        });
      }
    } catch (e) {}
  }

  // Traceroute to Google DNS
  try {
    const result = await runCommand('tracert -d -h 15 8.8.8.8', 30000);
    if (result.success && result.stdout) {
      const lines = result.stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*(\d+)\s+(<?\d+)\s*ms\s+(<?\d+)\s*ms\s+(<?\d+)\s*ms\s+([\d.]+)/);
        if (match) {
          hops.push({
            hop: parseInt(match[1]),
            ms1: match[2] === '<1' ? 0 : parseInt(match[2]),
            ms2: match[3] === '<1' ? 0 : parseInt(match[3]),
            ms3: match[4] === '<1' ? 0 : parseInt(match[4]),
            ip: match[5],
          });
        }
      }
    }
  } catch (e) {}

  // Get local network info for context
  let localNet = {};
  try {
    const result = await runCommand('ipconfig', 5000);
    if (result.success) {
      const gwMatch = result.stdout.match(/Default Gateway\s*:\s*([\d.]+)/);
      const ipMatch = result.stdout.match(/IPv4 Address\s*:\s*([\d.]+)/);
      localNet.gateway = gwMatch ? gwMatch[1] : null;
      localNet.ip = ipMatch ? ipMatch[1] : null;
    }
  } catch (e) {}

  const traceData = { hops, targets: pingResults, localNet, timestamp: new Date().toISOString() };

  // Post results to server
  try {
    const https = require('https');
    const http = require('http');
    const postData = JSON.stringify({ deviceId: DEVICE_ID, ...traceData });
    const url = new URL(SERVER_URL.replace('wss:', 'https:').replace('ws:', 'http:') + '/api/ping');
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } });
    req.write(postData);
    req.end();
  } catch (e) {}

  return traceData;
}

// ─── BSSID Geolocation Lookup ────────────────────────────────────────────────

async function lookupBssids(params) {
  const networks = params?.networks || [];
  if (networks.length === 0) {
    // Auto-scan first
    const scan = await scanWifi();
    if (scan.networks) {
      for (const n of scan.networks) {
        if (n.bssids) {
          for (const b of n.bssids) {
            if (b.bssid) networks.push({ bssid: b.bssid, rssi: b.rssi, frequency: 2437 });
          }
        }
        if (n.bssid) networks.push({ bssid: n.bssid, rssi: n.rssi, frequency: 2437 });
      }
    }
  }

  if (networks.length === 0) return { success: false, error: 'No BSSIDs to look up' };

  try {
    const https = require('https');
    const body = JSON.stringify({
      wifiAccessPoints: networks.slice(0, 10).map(n => ({
        key: n.bssid.toUpperCase().replace(/[:-]/g, ''),
        frequency: n.frequency || 2437,
        signal: n.rssi || n.signal || -50,
      }))
    });

    const result = await new Promise((resolve, reject) => {
      const r = https.request('https://location.services.mozilla.com/v1/geolocate?key=test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000,
      }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
      });
      r.on('error', reject);
      r.write(body);
      r.end();
    });

    if (result.location) {
      return {
        success: true,
        lat: result.location.lat,
        lng: result.location.lng,
        accuracy: result.accuracy,
        source: 'mozilla-bssid',
        bssidCount: networks.length,
      };
    }
  } catch (e) {
    log('warn', 'BSSID lookup failed:', e.message);
  }

  return { success: false, error: 'BSSID lookup failed' };
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
  // 1. Lock the workstation
  const lockResult = await runCommand('rundll32.exe user32.dll,LockWorkStation', 5000);

  // 2. Disable shutdown button via registry (prevents force shutdown from lock screen)
  try {
    await runPowerShell(`
      # Disable shutdown option on lock screen
      New-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" -Name "DisableLockWorkstation" -Value 0 -Force -ErrorAction SilentlyContinue
      # Disable Ctrl+Alt+Del shutdown option
      New-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" -Name "ShutdownWithoutLogon" -Value 0 -Force -ErrorAction SilentlyContinue
      # Hide shutdown button
      New-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" -Name "NoClose" -Value 1 -Type DWord -Force -ErrorAction SilentlyContinue
    `, 5000);
  } catch (e) { log('warn', 'Registry lock failed:', e.message); }

  // 3. Play alarm sound to alert
  try {
    await runPowerShell(`
      [Console]::Beep(800, 500)
      [Console]::Beep(1000, 500)
      [Console]::Beep(800, 500)
    `, 5000);
  } catch (e) {}

  return { success: true, stdout: 'PC locked, shutdown disabled', lockResult: lockResult.stdout };
}

async function unlockScreen() {
  // Re-enable shutdown and close button
  try {
    await runPowerShell(`
      Remove-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" -Name "NoClose" -Force -ErrorAction SilentlyContinue
      New-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" -Name "ShutdownWithoutLogon" -Value 1 -Force -ErrorAction SilentlyContinue
    `, 5000);
  } catch (e) {}
  return { success: true, stdout: 'Shutdown re-enabled' };
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

// ─── Auto-connect to open WiFi when no internet ──────────────────────────────

let lastInternetCheck = 0;
let internetConnected = true;

async function checkInternet() {
  try {
    const result = await runCommand('ping -n 1 -w 2000 8.8.8.8', 5000);
    internetConnected = result.success && result.stdout && !result.stdout.includes('100% loss');
  } catch (e) {
    internetConnected = false;
  }
  return internetConnected;
}

async function autoConnectOpenWifi() {
  if (Date.now() - lastInternetCheck < 60000) return internetConnected;
  lastInternetCheck = Date.now();

  const hasInternet = await checkInternet();
  if (hasInternet) return true;

  log('warn', 'No internet — scanning for open WiFi networks to auto-connect...');

  // Scan for available networks
  const scanResult = await runCommand('netsh wlan show networks mode=bssid', 10000);
  if (!scanResult.success) return false;

  const openNetworks = [];
  let current = {};
  for (const line of scanResult.stdout.split('\n')) {
    const t = line.trim();
    if (t.startsWith('SSID') && !t.includes('BSSID')) {
      if (current.ssid) openNetworks.push(current);
      current = { ssid: t.split(':').slice(1).join(':').trim() };
    } else if (t.startsWith('Authentication')) {
      current.auth = t.split(':').slice(1).join(':').trim();
    } else if (t.startsWith('Encryption')) {
      current.enc = t.split(':').slice(1).join(':').trim();
    } else if (t.startsWith('Signal')) {
      current.signal = parseInt(t.split(':').pop().trim().replace('%', ''));
    }
  }
  if (current.ssid) openNetworks.push(current);

  // Filter: open = Open authentication + no encryption, with decent signal
  const open = openNetworks
    .filter(n => n.auth && (n.auth.includes('Open') || n.auth.includes('None')) && n.signal > 30)
    .sort((a, b) => (b.signal || 0) - (a.signal || 0));

  if (open.length === 0) {
    log('warn', 'No open WiFi networks found');
    return false;
  }

  // Try connecting to the strongest open network
  for (const net of open) {
    log('info', `Auto-connecting to open network: ${net.ssid} (signal: ${net.signal}%)`);

    // Create a network profile XML for open network
    const profileXml = `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${net.ssid}</name>
  <SSIDConfig><SSID><name>${net.ssid}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security><authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption></security></MSM>
</WLANProfile>`;

    const profilePath = `C:\\Windows\\Temp\\wifi_${Date.now()}.xml`;
    try {
      fs.writeFileSync(profilePath, profileXml);
      await runCommand(`netsh wlan add profile filename="${profilePath}"`, 5000);
      const connectResult = await runCommand(`netsh wlan connect name="${net.ssid}"`, 8000);
      fs.unlinkSync(profilePath);

      if (connectResult.success && connectResult.stdout.includes('success')) {
        log('info', `Connected to ${net.ssid} — checking internet...`);
        await new Promise(r => setTimeout(r, 5000));
        if (await checkInternet()) {
          log('info', `Internet restored via ${net.ssid}!`);
          return true;
        }
      }
    } catch (e) {
      log('warn', `Failed to connect to ${net.ssid}: ${e.message}`);
    }
  }

  log('warn', 'Could not auto-connect to any open network with internet');
  return false;
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

      case 'unlock':
        result = await unlockScreen();
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

      case 'ping':
      case 'traceroute':
      case 'nettrace':
        result = await runPingTrace();
        break;

      case 'bssid-lookup':
        result = await lookupBssids(msg.params);
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
  // First register with the server to get a pairCode
  try {
    const http = require('http');
    const https = require('https');
    const postData = JSON.stringify({ deviceId: DEVICE_ID, hostname: os.hostname(), platform: os.platform() });
    const url = new URL(SERVER_URL.replace('wss:', 'https:').replace('ws:', 'http:') + '/api/agent-register');
    const client = url.protocol === 'https:' ? https : http;
    await new Promise((resolve) => {
      const req = client.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.success) {
              log('info', `Agent registered with pairCode: ${data.pairCode}`);
            } else {
              log('warn', 'Agent register response:', data.error);
            }
          } catch (e) {}
          resolve();
        });
      });
      req.on('error', () => resolve());
      req.write(postData);
      req.end();
    });
  } catch (e) {
    log('warn', 'Agent register HTTP failed:', e.message);
  }

  // Then register via WebSocket
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
  // Check internet and auto-connect to open WiFi if offline
  autoConnectOpenWifi().catch(() => {});
}, 120000);

// Faster internet check every 30s for auto-connect
setInterval(async () => {
  if (!internetConnected) {
    await autoConnectOpenWifi().catch(() => {});
  } else {
    await checkInternet().catch(() => {});
  }
}, 30000);

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
