const express = require('express');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Server } = require('ws');
const { PrismaClient } = require('@prisma/client');
const geolocationService = require('./geolocation-service');

const app = express();
const PORT = process.env.PORT || 9999;
const SERVER_URL = process.env.SERVER_URL || 'https://laptop-tracker-k9vi.onrender.com';
const prisma = new PrismaClient();
const server = http.createServer(app);
const wss = new Server({ server, pingInterval: 30000, pingTimeout: 10000 });
const agentSockets = new Map(); // deviceId -> ws (agent connection)
const browserSockets = new Map(); // deviceId -> ws (browser connection)
const APP_VERSION = '2.9.0';
const lostDevices = new Set();

// ─── REAL-TIME LOCATION SMOOTHING ───────────────────────────────────────────
// In-memory smoothed position per device. Blends new points against the last
// accepted position to remove GPS/IP jitter so markers don't "bounce" around.
const locState = new Map(); // deviceId -> { lat, lng, accuracy, source, ts, accepted }

function haversineMeters(aLat, aLng, bLat, bLng) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Smooth a raw location update. If it's a huge jump (> maxJumpMeters) it is
// blended toward the last good position instead of snapping, and the accuracy
// is widened. Returns the smoothed {lat,lng,accuracy,source} to persist/broadcast.
function smoothLocation(deviceId, loc) {
  if (loc == null || loc.lat == null || loc.lng == null) return loc;
  const s = locState.get(deviceId);
  const nowTs = Date.now();
  if (!s || s.lat == null) {
    locState.set(deviceId, { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy || 100, source: loc.source, ts: nowTs, accepted: true });
    return { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy || 100, source: loc.source };
  }
  const rawOk = Math.abs(loc.lat) < 90 && Math.abs(loc.lng) < 180 && !(loc.lat === 0 && loc.lng === 0);
  if (!rawOk) return { lat: s.lat, lng: s.lng, accuracy: s.accuracy * 2, source: loc.source || s.source };

  const jump = haversineMeters(s.lat, s.lng, loc.lat, loc.lng);
  const dtMs = nowTs - s.ts;
  const realistic = Math.max(80, (dtMs / 1000) * 80);
  const newAcc = loc.accuracy || 100;
  const maxJump = newAcc > 500 ? Math.max(12000, newAcc * 4) : Math.max(realistic * 2, 600);

  if (jump > maxJump) {
    // Outlier: fully rejected. Position stays pinned to last known good.
    const acc = Math.min(Math.max(s.accuracy, newAcc), 5000);
    locState.set(deviceId, { lat: s.lat, lng: s.lng, accuracy: acc, source: s.source, ts: nowTs, accepted: false });
    return { lat: s.lat, lng: s.lng, accuracy: acc, source: s.source };
  }

  // For GPS sources with good accuracy, use raw value (0 jitter from EMA).
  // For IP/less precise sources, use high-alpha EMA to track changes.
  const isPrecise = newAcc < 200 && loc.source && (loc.source.includes('gps') || loc.source.includes('phone'));
  const alpha = isPrecise ? 1.0 : 0.9;
  const lat = s.lat + (loc.lat - s.lat) * alpha;
  const lng = s.lng + (loc.lng - s.lng) * alpha;
  const acc = s.accuracy + (newAcc - s.accuracy) * alpha;
  locState.set(deviceId, { lat, lng, accuracy: Math.round(acc), source: loc.source || s.source, ts: nowTs, accepted: true });
  return { lat, lng, accuracy: Math.round(acc), source: loc.source || s.source };
}

app.use(express.json({ limit: '1mb' }));
// Handle malformed JSON gracefully
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    console.log(`Bad JSON from ${req.ip} on ${req.url}`);
    return res.status(400).json({ success: false, error: 'Invalid JSON' });
  }
  next(err);
});
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function sanitize(o) { if (o===null||o===undefined) return o; if (typeof o==='bigint') return Number(o); if (Array.isArray(o)) return o.map(sanitize); if (typeof o==='object') { const r={}; for (const [k,v] of Object.entries(o)) r[k]=sanitize(v); return r; } return o; }
function now() { return BigInt(Date.now()); }

// ============= PAIRING =============
app.post('/api/generate', async (req, res) => {
  try {
    const pairCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const laptopId = pairCode;

    // Upsert code record
    await prisma.code.upsert({
      where: { pairCode },
      create: { pairCode, binaryCode: pairCode, deviceId: laptopId, createdAt: now() },
      update: { deviceId: laptopId }
    });

    // Upsert laptop device
    await prisma.device.upsert({
      where: { deviceId: laptopId },
      create: { deviceId: laptopId, pairCode, deviceType: 'laptop', createdAt: now(), lastSeen: now() },
      update: { lastSeen: now() }
    });

    // Create initial location so /api/pair-info has something
    try {
      await prisma.location.upsert({
        where: { deviceId: laptopId },
        create: { deviceId: laptopId, lat: null, lng: null, source: 'init', updatedAt: now() },
        update: { updatedAt: now() }
      });
    } catch(e) { console.log('Location upsert skipped:', e.message.substring(0,80)); }

    console.log(`Generated pair code: ${pairCode} for laptop: ${laptopId}`);
    res.json({ success: true, pairCode, deviceId: laptopId });
  } catch (e) {
    console.error('Generate Error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/verify', async (req, res) => {
  try {
    const { pairCode } = req.body;
    console.log(`Verify attempt with code: ${pairCode}`);
    const code = await prisma.code.findUnique({ where: { pairCode } });
    if (!code) {
      console.log('Code not found:', pairCode);
      return res.json({ success: false, error: 'Invalid code' });
    }

    const phoneId = pairCode + '-phone';
    const laptopId = code.deviceId;

    // Create phone device
    await prisma.device.upsert({
      where: { deviceId: phoneId },
      create: { deviceId: phoneId, pairCode, deviceType: 'phone', createdAt: now(), lastSeen: now() },
      update: { lastSeen: now() }
    });

    // Create phone location record
    try {
      await prisma.location.upsert({
        where: { deviceId: phoneId },
        create: { deviceId: phoneId, lat: null, lng: null, source: 'init', updatedAt: now() },
        update: { updatedAt: now() }
      });
    } catch(e) { console.log('Phone location upsert skipped:', e.message.substring(0,80)); }

    console.log(`Phone ${phoneId} paired with laptop ${laptopId}`);

    // Notify laptop via WS
    broadcast(laptopId, { type: 'paired', phoneId });

    res.json({ success: true, laptopId, phoneId, pairCode });
  } catch (e) {
    console.error('Verify Error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= PAIR INFO (single endpoint for everything) =============
app.get('/api/pair-info/:pairCode', async (req, res) => {
  try {
    const pc = req.params.pairCode;
    const code = await prisma.code.findUnique({ where: { pairCode: pc } });
    if (!code) return res.json({ success: false, error: 'Code not found' });

    const devices = await prisma.device.findMany({ where: { pairCode: pc } });
    const laptop = devices.find(d => d.deviceType === 'laptop');
    const phone = devices.find(d => d.deviceType === 'phone');

    let laptopLocation = null, phoneLocation = null;
    if (laptop) { try { laptopLocation = await prisma.location.findUnique({ where: { deviceId: laptop.deviceId } }); } catch(e) { /* column missing */ } }
    if (phone) { try { phoneLocation = await prisma.location.findUnique({ where: { deviceId: phone.deviceId } }); } catch(e) { /* column missing */ } }

    const laptopOnline = laptop ? (Date.now() - Number(laptop.lastSeen) < 60000) : false;
    const phoneOnline = phone ? (Date.now() - Number(phone.lastSeen) < 60000) : false;

    res.json(sanitize({
      success: true,
      pairCode: pc,
      laptop: laptop ? { deviceId: laptop.deviceId, systemInfo: laptop.systemInfo ? JSON.parse(laptop.systemInfo) : null, online: laptopOnline, lastSeen: laptop.lastSeen, isLost: lostDevices.has(laptop.deviceId), agentConnected: agentSockets.has(laptop.deviceId) || agentSockets.has(pc) } : null,
      phone: phone ? { deviceId: phone.deviceId, online: phoneOnline, lastSeen: phone.lastSeen, isLost: lostDevices.has(phone.deviceId), agentConnected: agentSockets.has(phone.deviceId) || agentSockets.has(pc) } : null,
      laptopLocation: laptopLocation && laptopLocation.lat != null ? laptopLocation : null,
      phoneLocation: phoneLocation && phoneLocation.lat != null ? phoneLocation : null
    }));
  } catch (e) {
    console.error('PairInfo Error:', e);
    res.json({ success: false, error: e.message });
  }
});

// ============= HEARTBEAT =============
app.post('/api/heartbeat', async (req, res) => {
  const { deviceId, location, systemInfo } = req.body;
  try {
    // Update lastSeen + systemInfo
    await prisma.device.update({
      where: { deviceId },
      data: { lastSeen: now(), ...(systemInfo ? { systemInfo: JSON.stringify(systemInfo) } : {}) }
    });

    // Update location if provided
    if (location && location.lat != null) {
      const smoothed = smoothLocation(deviceId, location);
      try {
        await prisma.location.upsert({
          where: { deviceId },
          create: { deviceId, lat: smoothed.lat, lng: smoothed.lng, source: smoothed.source || location.source || 'heartbeat', updatedAt: now() },
          update: { lat: smoothed.lat, lng: smoothed.lng, source: smoothed.source || location.source || 'heartbeat', updatedAt: now() }
        });
      } catch(e) { console.log('Heartbeat location upsert error:', e.message.substring(0,80)); }

      const dev = await prisma.device.findUnique({ where: { deviceId } });
      if (dev) {
        const siblings = await prisma.device.findMany({ where: { pairCode: dev.pairCode } });
        for (const sib of siblings) {
          if (sib.deviceId !== deviceId) {
            broadcast(sib.deviceId, { type: 'location', fromDeviceId: deviceId, location: smoothed });
          }
        }
        const locMsg = JSON.stringify({ type: 'location', fromDeviceId: deviceId, location: smoothed });
        for (const [bId, bWs] of browserSockets) {
          try { bWs.send(locMsg); } catch(e) {}
        }
      }
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Heartbeat Error:', e);
    res.json({ success: false, error: e.message });
  }
});

// ============= PHONE LOCATION =============
app.post('/api/location/phone', async (req, res) => {
  const { deviceId, location } = req.body;
  try {
    if (location && location.lat != null) {
      const smoothed = smoothLocation(deviceId, location);
      await prisma.device.update({ where: { deviceId }, data: { lastSeen: now() } });
      try {
        await prisma.location.upsert({
          where: { deviceId },
          create: { deviceId, lat: smoothed.lat, lng: smoothed.lng, source: smoothed.source || location.source || 'phone-gps', updatedAt: now() },
          update: { lat: smoothed.lat, lng: smoothed.lng, source: smoothed.source || location.source || 'phone-gps', updatedAt: now() }
        });
      } catch(e) { console.log('Phone location upsert error:', e.message.substring(0,80)); }
      const dev = await prisma.device.findUnique({ where: { deviceId } });
      if (dev) {
        const siblings = await prisma.device.findMany({ where: { pairCode: dev.pairCode } });
        for (const sib of siblings) {
          if (sib.deviceId !== deviceId) {
            broadcast(sib.deviceId, { type: 'location', fromDeviceId: deviceId, location: smoothed });
          }
        }
        const locMsg = JSON.stringify({ type: 'location', fromDeviceId: deviceId, location: smoothed });
        for (const [bId, bWs] of browserSockets) {
          try { bWs.send(locMsg); } catch(e) {}
        }
      }
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ============= COMMANDS =============
app.post('/api/command', async (req, res) => {
  const { deviceId, commandType, params } = req.body;
  const commandId = crypto.randomBytes(8).toString('hex');
  try {
    await prisma.command.create({
      data: { commandId, deviceId, commandType, params: params ? JSON.stringify(params) : null, status: 'pending', createdAt: now() }
    });
    // Route to AGENT ONLY — browser can't execute native commands
    let sent = false;
    if (agentSockets.has(deviceId)) {
      try { agentSockets.get(deviceId).send(JSON.stringify({ type: 'command', commandId, commandType, params })); sent = true; } catch(e) {}
    }
    // Also notify all browsers watching this pair so they see the "sent" status
    const dev = await prisma.device.findUnique({ where: { deviceId } });
    if (dev) {
      const siblings = await prisma.device.findMany({ where: { pairCode: dev.pairCode } });
      for (const sib of siblings) {
        if (sib.deviceId !== deviceId) broadcast(sib.deviceId, { type: 'command-sent', commandId, commandType, targetDeviceId: deviceId });
      }
    }
    for (const [bId, bWs] of browserSockets) {
      try { bWs.send(JSON.stringify({ type: 'command-sent', commandId, commandType, targetDeviceId: deviceId })); } catch(e) {}
    }
    console.log(`Command ${commandType} sent to ${deviceId} (agent: ${sent})`);
    res.json({ success: true, commandId, sent, agentOnline: agentSockets.has(deviceId) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/result', async (req, res) => {
  const { commandId, result } = req.body;
  try {
    const cmd = await prisma.command.update({
      where: { commandId },
      data: { result: typeof result === 'object' ? JSON.stringify(result) : String(result), status: 'completed', completedAt: now() }
    });
    const dev = await prisma.device.findUnique({ where: { deviceId: cmd.deviceId } });
    if (dev) {
      const siblings = await prisma.device.findMany({ where: { pairCode: dev.pairCode } });
      const resultMsg = { type: 'commandResult', commandId, commandType: cmd.commandType, result: cmd.result };
      for (const sib of siblings) {
        if (sib.deviceId !== cmd.deviceId) broadcastAll(sib.deviceId, resultMsg);
      }
      const resultJson = JSON.stringify(resultMsg);
      for (const [bId, bWs] of browserSockets) {
        try { bWs.send(resultJson); } catch(e) {}
      }
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ============= AGENT REGISTER =============
app.post('/api/agent-register', async (req, res) => {
  try {
    const { deviceId: agentDeviceId, hostname, platform, pairCode } = req.body;
    if (!pairCode) return res.json({ success: false, error: 'No pairCode provided' });
    const code = await prisma.code.findUnique({ where: { pairCode } });
    if (!code) return res.json({ success: false, error: 'Invalid pairCode' });
    const devices = await prisma.device.findMany({ where: { pairCode } });
    const laptop = devices.find(d => d.deviceType === 'laptop');
    if (!laptop) return res.json({ success: false, error: 'No laptop found for this pairCode' });
    res.json({ success: true, pairCode, deviceId: laptop.deviceId, laptopId: laptop.deviceId });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Agent setup instructions
app.get('/api/agent-setup/:pairCode', async (req, res) => {
  try {
    const pc = req.params.pairCode;
    const code = await prisma.code.findUnique({ where: { pairCode: pc } });
    if (!code) return res.json({ success: false, error: 'Invalid pairCode' });
    const serverUrl = SERVER_URL;
    // One-liner: downloads agent, installs persistence, starts immediately
    const installerCmd = `powershell -Command "IEX (Invoke-WebRequest -Uri '${serverUrl}/agent-installer.ps1' -UseBasicParsing).Content"`;
    // Direct npx install (npm registry)
    const npxCmd = `npx -y laptop-tracker-agent --pair=${pc} --server=${serverUrl}`;
    // PowerShell inline (no download needed, runs directly)
    const inlineCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "& {$p='${pc}';$s='${serverUrl}';$d=\"$env:USERPROFILE\\.find-agent\";if(!(Test-Path $d)){New-Item -ItemType Directory -Path $d -Force|Out-Null};$a=\"$d\\agent.js\";Invoke-WebRequest -Uri \"$s/agent.js\" -OutFile $a -UseBasicParsing;Push-Location $d;if(!(Test-Path package.json)){npm init -y|Out-Null};npm install ws|Out-Null;Pop-Location;Start-Process node -ArgumentList \"\\\"$a\\\" --pair=$p\" -WindowStyle Hidden;Write-Host 'FIND Agent installed and running'}`;
    res.json({
      success: true,
      pairCode: pc,
      serverUrl,
      installerCmd,
      npxCmd,
      autoStartCmd: inlineCmd,
      installCmd: inlineCmd
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Agent looks up pairCode by deviceId (from config)
app.get('/api/agent-lookup/:deviceId', async (req, res) => {
  try {
    const dev = await prisma.device.findUnique({ where: { deviceId: req.params.deviceId } });
    if (dev) res.json({ success: true, pairCode: dev.pairCode, deviceId: dev.deviceId });
    else res.json({ success: false, error: 'Device not found' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/lost-mode', (req, res) => {
  try {
    const { deviceId, active } = req.body;
    if (active) {
      lostDevices.add(deviceId);
      broadcastAll(deviceId, { type: 'command', commandType: 'lost-mode-on', commandId: 'lm-' + Date.now() });
    } else {
      lostDevices.delete(deviceId);
      broadcastAll(deviceId, { type: 'command', commandType: 'lost-mode-off', commandId: 'lm-' + Date.now() });
    }
    res.json({ success: true, isLost: lostDevices.has(deviceId) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ============= APK DOWNLOAD =============
app.get('/FIND.apk', (req, res) => {
  const fs = require('fs');
  const apkPath = path.join(__dirname, 'public', 'FIND.apk');
  const altPath = path.join(__dirname, 'android-app', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  const file = fs.existsSync(apkPath) ? apkPath : (fs.existsSync(altPath) ? altPath : null);
  if (file) {
    res.setHeader('Content-Disposition', 'attachment; filename="FIND.apk"');
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    fs.createReadStream(file).pipe(res);
  } else {
    res.status(404).send('APK not found');
  }
});

// ============= LAPTOP TRACKER APK DOWNLOAD =============
app.get('/LaptopTracker.apk', (req, res) => {
  const fs = require('fs');
  const apkPath = path.join(__dirname, 'public', 'LaptopTracker.apk');
  const altPath = path.join(__dirname, 'LaptopTracker', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  const altPathDebug = path.join(__dirname, 'LaptopTracker', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  const file = fs.existsSync(apkPath) ? apkPath : (fs.existsSync(altPath) ? altPath : (fs.existsSync(altPathDebug) ? altPathDebug : null));
  if (file) {
    res.setHeader('Content-Disposition', 'attachment; filename="LaptopTracker.apk"');
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    fs.createReadStream(file).pipe(res);
  } else {
    res.status(404).send('LaptopTracker APK not found');
  }
});

// ============= VERSION CHECK =============
app.get('/api/version', (req, res) => {
  res.json({
    version: APP_VERSION,
    versionCode: 20900,
    apkUrl: '/FIND.apk',
    laptopTrackerApkUrl: '/LaptopTracker.apk',
    windowsUrl: '/FIND-Windows.zip',
    releaseNotes: 'v' + APP_VERSION + ': Real-time tracking enhancements, automatic update delivery, low-latency live telemetry, forensic acquisition, and security updates.'
  });
});

// ============= STATIC =============
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => { if (!req.url.startsWith('/api/')) res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ============= WEBSOCKET =============
function broadcast(targetId, data, preferAgent=true) {
  const msg = JSON.stringify(data);
  if (preferAgent && agentSockets.has(targetId)) {
    try { agentSockets.get(targetId).send(msg); } catch(e) {}
    return true;
  }
  if (browserSockets.has(targetId)) {
    try { browserSockets.get(targetId).send(msg); } catch(e) {}
    return true;
  }
  return false;
}

// Broadcast to ALL connections for a deviceId (agent + browser)
function broadcastAll(targetId, data) {
  const msg = JSON.stringify(data);
  let sent = false;
  // Send to BOTH agent and browser — don't skip either
  [agentSockets, browserSockets].forEach(map => {
    if (map.has(targetId)) {
      try { map.get(targetId).send(msg); sent = true; } catch(e) {}
    }
  });
  return sent;
}

wss.on('connection', (ws) => {
  let myId = null;
  let myType = 'browser';
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch(e) {} return; }
      if (msg.type === 'register') {
        myId = msg.deviceId;
        myType = msg.deviceType || 'browser';
        if (myType === 'agent') {
          // Close old agent connection if exists
          if (agentSockets.has(myId)) {
            try { agentSockets.get(myId).close(); } catch(e) {}
          }
          agentSockets.set(myId, ws);
          console.log(`WS Registered AGENT: ${myId}`);
        } else {
          // Close old browser connection if exists
          if (browserSockets.has(myId)) {
            try { browserSockets.get(myId).close(); } catch(e) {}
          }
          browserSockets.set(myId, ws);
          console.log(`WS Registered BROWSER: ${myId}`);
        }
        try { await prisma.device.update({ where: { deviceId: myId }, data: { lastSeen: now() } }); } catch(e) {}
        return;
      }
      // Forward messages from agent to browser and vice versa
      // Also broadcast to ALL browsers watching the same pairCode
      if (myId) {
        const dev = await prisma.device.findUnique({ where: { deviceId: myId } });
        if (dev) {
          // Real-time location over WS: smooth it + persist for pair-info
          let fwd = msg;
          if (msg.type === 'location' && msg.location && msg.location.lat != null) {
            fwd = { ...msg, location: smoothLocation(myId, msg.location) };
            try {
              await prisma.location.upsert({
                where: { deviceId: myId },
                create: { deviceId: myId, lat: fwd.location.lat, lng: fwd.location.lng, source: fwd.location.source || 'ws', updatedAt: now() },
                update: { lat: fwd.location.lat, lng: fwd.location.lng, source: fwd.location.source || 'ws', updatedAt: now() }
              });
            } catch(e) {}
            try { await prisma.device.update({ where: { deviceId: myId }, data: { lastSeen: now() } }); } catch(e) {}
          }
          const siblings = await prisma.device.findMany({ where: { pairCode: dev.pairCode } });
          for (const sib of siblings) {
            if (sib.deviceId !== myId) {
              broadcast(sib.deviceId, { ...fwd, fromDeviceId: myId }, false);
            }
          }
          const pairMsg = JSON.stringify({ ...fwd, fromDeviceId: myId });
          for (const [bId, bWs] of browserSockets) {
            try { bWs.send(pairMsg); } catch(e) {}
          }
        }
      }
    } catch(e) { console.error('WS Error:', e); }
  });
  ws.on('close', () => {
    if (myId) {
      if (agentSockets.get(myId) === ws) agentSockets.delete(myId);
      if (browserSockets.get(myId) === ws) browserSockets.delete(myId);
    }
  });
});

// ============= HIGH-PRECISION GEOLOCATION API PROXY =============
// Agent sends WiFi BSSIDs here, server forwards to Google Geolocation API
// Returns high-precision coordinates (5-20m accuracy)
app.post('/api/geo-resolve', async (req, res) => {
  const { wifiAccessPoints, deviceId } = req.body;
  if (!wifiAccessPoints || !Array.isArray(wifiAccessPoints) || wifiAccessPoints.length < 2) {
    return res.json({ success: false, error: 'Need 2+ WiFi access points for triangulation' });
  }
  // Build Google Geolocation API payload
  const payload = {
    considerIp: true,
    wifiAccessPoints: wifiAccessPoints.map(ap => ({
      macAddress: ap.macAddress || ap.bssid,
      signalStrength: ap.signalStrength || ap.rssi,
      channel: ap.channel || undefined,
      frequency: ap.frequency || undefined,
      age: ap.age || 0,
      signalToNoiseRatio: ap.signalToNoiseRatio || undefined
    }))
  };
  // Try multiple geolocation APIs (free, no key needed)
  const https = require('https');
  const tryAPI = (url, postData) => new Promise((resolve) => {
    const u = new URL(url);
    const options = { hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }, timeout: 8000 };
    const apiReq = https.request(options, (apiRes) => {
      let d = '';
      apiRes.on('data', c => d += c);
      apiRes.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    apiReq.on('error', () => resolve(null));
    apiReq.on('timeout', () => { apiReq.destroy(); resolve(null); });
    apiReq.write(postData);
    apiReq.end();
  });
  // Try Mozilla Location Service (free, no key)
  const mozillaPayload = JSON.stringify({
    wifiAccessPoints: wifiAccessPoints.map(ap => ({
      macAddress: (ap.macAddress || ap.bssid || '').toUpperCase(),
      signalStrength: ap.signalStrength || ap.rssi
    }))
  });
  const mozillaResult = await tryAPI('https://www.googleapis.com/geolocation/v1/geolocate?key=AIzaSyDxKLJgMFyAfWJIwsVqMl3PnGiGMFUJPtc', JSON.stringify(payload)).catch(() => null);
  // Try mylnikov.org BSSID lookup (free, no key)
  let bssidResults = [];
  for (const ap of wifiAccessPoints.slice(0, 8)) {
    const bssid = (ap.macAddress || ap.bssid || '').toLowerCase().replace(/-/g, ':');
    if (!bssid || bssid === '00:00:00:00:00:00') continue;
    const bssidData = await tryAPI(`https://api.mylnikov.org/geolocation/v1/bssid?bssid=${bssid}&type=json`, '').catch(() => null);
    if (bssidData && bssidData.result === 200 && bssidData.data && bssidData.data.lat) {
      const rssi = ap.signalStrength || ap.rssi || -70;
      const estDist = Math.pow(10, (-69 - rssi) / (10 * 3.5));
      bssidResults.push({ lat: bssidData.data.lat, lng: bssidData.data.lon, distance: estDist, bssid, range: bssidData.data.range || 200 });
    }
  }
  // Weighted centroid from BSSID database results
  if (bssidResults.length >= 2) {
    let wLat = 0, wLng = 0, tw = 0;
    for (const r of bssidResults) {
      const w = 1 / (r.distance ** 2 + 1);
      wLat += r.lat * w; wLng += r.lng * w; tw += w;
    }
    const acc = Math.round(100 + bssidResults.reduce((a, b) => a + b.distance, 0) / bssidResults.length);
    return res.json({ success: true, lat: wLat / tw, lng: wLng / tw, accuracy: acc, source: 'bssid-database', apCount: bssidResults.length, timestamp: Date.now() });
  }
  // Fallback: IP geolocation
  const ipData = await tryAPI('https://ipinfo.io/json', '').catch(() => null);
  if (ipData && ipData.loc) {
    const [lat, lng] = ipData.loc.split(',').map(Number);
    return res.json({ success: true, lat, lng, accuracy: 3000, source: 'ip-fallback', city: ipData.city, region: ipData.region, timestamp: Date.now() });
  }
  return res.json({ success: false, error: 'Could not resolve coordinates from any source' });
});

// ============= REMOTE SHELL TERMINAL =============
// Phone sends shell commands to stolen laptop via this endpoint
app.post('/api/remote-shell', async (req, res) => {
  const { deviceId, command, pairCode } = req.body;
  if (!deviceId || !command) return res.json({ success: false, error: 'Missing deviceId or command' });
  // Verify the requesting device is paired to this laptop
  if (pairCode) {
    try {
      const dev = await prisma.device.findUnique({ where: { deviceId } });
      if (!dev || dev.pairCode !== pairCode) return res.json({ success: false, error: 'Unauthorized' });
    } catch(e) {}
  }
  // Send command to agent via WebSocket
  const commandId = crypto.randomBytes(8).toString('hex');
  try {
    await prisma.command.create({
      data: { commandId, deviceId, commandType: 'shell-exec', params: JSON.stringify({ command }), status: 'pending', createdAt: now() }
    });
    let sent = false;
    if (agentSockets.has(deviceId)) {
      try { agentSockets.get(deviceId).send(JSON.stringify({ type: 'command', commandId, commandType: 'shell-exec', params: { command } })); sent = true; } catch(e) {}
    }
    res.json({ success: true, commandId, sent, agentOnline: agentSockets.has(deviceId) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ============= OSINT RECON ENGINE =============
// Server-side OSINT lookups: IP intel, email breach check, username hunt, domain WHOIS
app.post('/api/osint/lookup', async (req, res) => {
  const { type, value } = req.body || {};
  if (!type || !value) return res.json({ success: false, error: 'Missing type or value' });
  const fetchURL = (url, headers = {}) => new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const r = mod.get(u, { headers: { 'User-Agent': 'FIND-OSINT/2.8', ...(headers || {}) }, timeout: 10000 }, (rs) => {
      let d = ''; rs.on('data', c => d += c); rs.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { resolve({ _raw: d.slice(0, 5000), status: rs.statusCode }); }
      });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
  });
  try {
    if (type === 'ip') {
      const geo = await fetchURL(`https://ipwho.is/${encodeURIComponent(value)}`);
      const rdap = await fetchURL(`https://rdap.org/ip/${encodeURIComponent(value)}`).catch(() => null);
      return res.json({ success: true, type: 'ip', lookup: value, geo: geo ? { ip: geo.ip, country: geo.country, city: geo.city, region: geo.region, isp: geo.connection && geo.connection.isp, org: geo.connection && geo.connection.org, asn: geo.connection && geo.connection.asn, domain: geo.connection && geo.connection.domain, timezone: geo.timezone, lat: geo.latitude, lng: geo.longitude, postal: geo.postal, flag: geo.flag && geo.flag.emoji } : null, network: rdap ? { handle: rdap.handle, name: rdap.name, range: (rdap.startAddress || '') + ' - ' + (rdap.endAddress || ''), events: (rdap.events || []).map(e => e.eventDate).slice(0, 3), abuse: ((rdap.entities || []).filter(e => (e.roles || []).includes('abuse')).map(e => { const v = (e.vcardArray || [])[1] || []; const em = v.find(x => x[0] === 'email'); return em ? em[3] : null; }))[0] } : null, sources: ['ipwho.is', 'rdap.org'] });
    }
    if (type === 'email-breach') {
      const found = await fetchURL(`https://leakcheck.io/api/public?check=${encodeURIComponent(value)}`);
      if (found && found.success !== false && found.found !== undefined) {
        return res.json({ success: true, type: 'email-breach', lookup: value, breached: found.found > 0, count: found.found, sources: (found.sources || []).slice(0, 40), pasteCount: found.pastes_found || 0, pastes: (found.pastes || []).slice(0, 10) });
      }
      return res.json({ success: true, type: 'email-breach', lookup: value, breached: null, note: 'Breach database unavailable from server' });
    }
    if (type === 'username') {
      const v = encodeURIComponent(value);
      const results = await Promise.allSettled([
        fetchURL(`https://api.github.com/users/${v}`),
        fetchURL(`https://www.reddit.com/user/${v}/about.json`, { 'User-Agent': 'FIND-OSINT/2.8' }),
        fetchURL(`https://gitlab.com/api/v4/users?username=${v}`)
      ]);
      const out = [];
      const gh = results[0].status === 'fulfilled' ? results[0].value : null;
      if (gh && gh.login) out.push({ platform: 'GitHub', found: true, url: gh.html_url, name: gh.name, bio: gh.bio, avatar: gh.avatar_url, created: gh.created_at, public_repos: gh.public_repos, location: gh.location });
      else out.push({ platform: 'GitHub', found: false });
      const rd = results[1].status === 'fulfilled' ? results[1].value : null;
      if (rd && rd.data && rd.data.name) out.push({ platform: 'Reddit', found: true, url: 'https://reddit.com/user/' + value, karma: (rd.data.link_karma || 0) + (rd.data.comment_karma || 0), created: rd.data.created_utc ? new Date(rd.data.created_utc * 1000).toISOString() : null, verified: rd.data.verified, snoovatar: rd.data.snoovatar_size > 0 });
      else out.push({ platform: 'Reddit', found: false });
      const gl = results[2].status === 'fulfilled' ? results[2].value : null;
      if (Array.isArray(gl) && gl.length > 0) out.push({ platform: 'GitLab', found: true, url: gl[0].web_url, name: gl[0].name, avatar: gl[0].avatar_url, created: gl[0].created_at });
      else out.push({ platform: 'GitLab', found: false });
      return res.json({ success: true, type: 'username', lookup: value, platforms: out, foundCount: out.filter(p => p.found).length });
    }
    if (type === 'domain') {
      const rdap = await fetchURL(`https://rdap.org/domain/${encodeURIComponent(value)}`);
      if (rdap && rdap.ldhName) {
        const ns = (rdap.names || []).map(n => n.ldhName);
        const events = (rdap.events || []).map(e => ({ action: e.eventAction, date: e.eventDate }));
        const ents = (rdap.entities || []).map(e => ({ roles: e.roles, email: ((e.vcardArray || [])[1] || []).find(x => x[0] === 'email')?.[3] || null, org: ((e.vcardArray || [])[1] || []).find(x => x[0] === 'fn')?.[3] || null }));
        return res.json({ success: true, type: 'domain', lookup: value, domain: rdap.ldhName, nameservers: ns, events, entities: ents.slice(0, 8), status: rdap.status });
      }
      return res.json({ success: true, type: 'domain', lookup: value, note: 'No RDAP record found (may be private TLD)' });
    }
    return res.json({ success: false, error: 'Unknown OSINT type. Use: ip, email-breach, username, domain' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ============= AI COMMANDER PROXY =============
// Forwards chat completions to the user's own hosted model (OpenAI-compatible: Ollama, LM Studio, vLLM, OpenRouter, etc.)
app.post('/api/ai-proxy', async (req, res) => {
  const { baseUrl, apiKey, model, messages, tools, temperature, maxTokens } = req.body || {};
  if (!baseUrl || !messages) return res.json({ success: false, error: 'Missing baseUrl or messages' });
  try {
    let url = String(baseUrl).replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(url)) {
      if (!/\/(v\d+|api)$/.test(url)) url += '/v1';
      url += '/chat/completions';
    }
    const body = JSON.stringify({ model: model || 'default', messages, tools: tools || undefined, tool_choice: tools ? 'auto' : undefined, temperature: temperature != null ? temperature : 0.4, max_tokens: maxTokens || 2048, stream: false });
    const u = new URL(url);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    if (!rQ) rQ = u.protocol === 'https:' ? require('https') : require('http');
    const req2 = rQ.request(u, { method: 'POST', headers, timeout: 120000 }, (rs) => {
      let d = '';
      rs.on('data', c => d += c);
      rs.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return res.json({ success: false, error: parsed.error.message || JSON.stringify(parsed.error) });
          res.json(parsed);
        } catch (e) { res.json({ success: false, error: 'Model endpoint returned invalid JSON', raw: d.slice(0, 1000) }); }
      });
    });
    req2.on('error', (e) => res.json({ success: false, error: 'Cannot reach model endpoint: ' + e.message }));
    req2.on('timeout', () => { req2.destroy(); try { res.json({ success: false, error: 'Model endpoint timeout (120s)' }); } catch(_){} });
    req2.write(body);
    req2.end();
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ============= LOST MODE TIMER =============
setInterval(() => {
  for (const deviceId of lostDevices) {
    broadcastAll(deviceId, { type: 'command', commandType: 'forensic-init', commandId: 'auto-' + Date.now() });
    broadcastAll(deviceId, { type: 'command', commandType: 'lock', commandId: 'auto-lock-' + Date.now() });
  }
}, 60000);

server.listen(PORT, '0.0.0.0', () => console.log('FIND Server running on', PORT));
