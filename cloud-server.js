const express = require('express');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Server } = require('ws');
const { PrismaClient } = require('@prisma/client');
const geolocationService = require('./geolocation-service');

const app = express();
const PORT = process.env.PORT || 9999;
const prisma = new PrismaClient();
const server = http.createServer(app);
const wss = new Server({ server, pingInterval: 30000, pingTimeout: 10000 });
const agentSockets = new Map(); // deviceId -> ws (agent connection)
const browserSockets = new Map(); // deviceId -> ws (browser connection)
const APP_VERSION = '2.2.0';
const lostDevices = new Set();

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
      laptop: laptop ? { deviceId: laptop.deviceId, systemInfo: laptop.systemInfo ? JSON.parse(laptop.systemInfo) : null, online: laptopOnline, lastSeen: laptop.lastSeen, isLost: lostDevices.has(laptop.deviceId), agentConnected: agentSockets.has(laptop.deviceId) } : null,
      phone: phone ? { deviceId: phone.deviceId, online: phoneOnline, lastSeen: phone.lastSeen, isLost: lostDevices.has(phone.deviceId), agentConnected: agentSockets.has(phone.deviceId) } : null,
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
      try {
        await prisma.location.upsert({
          where: { deviceId },
          create: { deviceId, lat: location.lat, lng: location.lng, source: location.source || 'heartbeat', updatedAt: now() },
          update: { lat: location.lat, lng: location.lng, source: location.source || 'heartbeat', updatedAt: now() }
        });
      } catch(e) { console.log('Heartbeat location upsert error:', e.message.substring(0,80)); }

      // Broadcast location to paired device AND all browsers watching this pair
      const dev = await prisma.device.findUnique({ where: { deviceId } });
      if (dev) {
        const siblings = await prisma.device.findMany({ where: { pairCode: dev.pairCode } });
        for (const sib of siblings) {
          if (sib.deviceId !== deviceId) {
            broadcast(sib.deviceId, { type: 'location', fromDeviceId: deviceId, location });
          }
        }
        // Also broadcast to all browser connections
        const locMsg = JSON.stringify({ type: 'location', fromDeviceId: deviceId, location });
        for (const [bId, bWs] of browserSockets) {
          if (bId !== deviceId) {
            try { bWs.send(locMsg); } catch(e) {}
          }
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
      await prisma.device.update({ where: { deviceId }, data: { lastSeen: now() } });
      try {
        await prisma.location.upsert({
          where: { deviceId },
          create: { deviceId, lat: location.lat, lng: location.lng, source: location.source || 'phone-gps', updatedAt: now() },
          update: { lat: location.lat, lng: location.lng, source: location.source || 'phone-gps', updatedAt: now() }
        });
      } catch(e) { console.log('Phone location upsert error:', e.message.substring(0,80)); }
      const dev = await prisma.device.findUnique({ where: { deviceId } });
      if (dev) {
        const siblings = await prisma.device.findMany({ where: { pairCode: dev.pairCode } });
        for (const sib of siblings) {
          if (sib.deviceId !== deviceId) {
            broadcast(sib.deviceId, { type: 'location', fromDeviceId: deviceId, location });
          }
        }
        const locMsg = JSON.stringify({ type: 'location', fromDeviceId: deviceId, location });
        for (const [bId, bWs] of browserSockets) {
          if (bId !== deviceId) {
            try { bWs.send(locMsg); } catch(e) {}
          }
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
    const sent = broadcastAll(deviceId, { type: 'command', commandId, commandType, params });
    console.log(`Command ${commandType} sent to ${deviceId}: ${sent}`);
    res.json({ success: true, commandId, sent });
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
      // Also broadcast to all browsers
      const resultJson = JSON.stringify(resultMsg);
      for (const [bId, bWs] of browserSockets) {
        if (bId !== cmd.deviceId) {
          try { bWs.send(resultJson); } catch(e) {}
        }
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
    res.json({
      success: true,
      pairCode: pc,
      serverUrl: SERVER_URL,
      installCmd: `npx -y laptop-tracker-agent --pair=${pc} --server=${SERVER_URL}`,
      altCmd: `node agent.js --pair=${pc}`,
      autoStartCmd: `powershell -Command "Start-Process node -ArgumentList 'agent.js --pair=${pc}' -WindowStyle Hidden"`
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

// ============= VERSION CHECK =============
app.get('/api/version', (req, res) => {
  res.json({
    version: APP_VERSION,
    apkUrl: '/FIND.apk',
    windowsUrl: '/FIND-Windows.zip',
    releaseNotes: 'Bug fixes and improvements'
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
          // Find all devices with the same pairCode
          const siblings = await prisma.device.findMany({ where: { pairCode: dev.pairCode } });
          for (const sib of siblings) {
            if (sib.deviceId !== myId) {
              broadcast(sib.deviceId, { ...msg, fromDeviceId: myId }, false);
            }
          }
          // Also broadcast to all browser connections watching this pairCode
          const pairMsg = JSON.stringify({ ...msg, fromDeviceId: myId });
          for (const [bId, bWs] of browserSockets) {
            if (bId !== myId) {
              try { bWs.send(pairMsg); } catch(e) {}
            }
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

// ============= LOST MODE TIMER =============
setInterval(() => {
  for (const deviceId of lostDevices) {
    broadcastAll(deviceId, { type: 'command', commandType: 'forensic-init', commandId: 'auto-' + Date.now() });
    broadcastAll(deviceId, { type: 'command', commandType: 'lock', commandId: 'auto-lock-' + Date.now() });
  }
}, 60000);

server.listen(PORT, '0.0.0.0', () => console.log('FIND Server running on', PORT));
