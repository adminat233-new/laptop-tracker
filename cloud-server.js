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
const wss = new Server({ server });
const sockets = new Map();
const lostDevices = new Set();

app.use(express.json());
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
    await prisma.location.upsert({
      where: { deviceId: laptopId },
      create: { deviceId: laptopId, lat: null, lng: null, accuracy: null, source: 'init', updatedAt: now() },
      update: { updatedAt: now() }
    });

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
    await prisma.location.upsert({
      where: { deviceId: phoneId },
      create: { deviceId: phoneId, lat: null, lng: null, accuracy: null, source: 'init', updatedAt: now() },
      update: { updatedAt: now() }
    });

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
    if (laptop) laptopLocation = await prisma.location.findUnique({ where: { deviceId: laptop.deviceId } });
    if (phone) phoneLocation = await prisma.location.findUnique({ where: { deviceId: phone.deviceId } });

    const laptopOnline = laptop ? (Date.now() - Number(laptop.lastSeen) < 60000) : false;
    const phoneOnline = phone ? (Date.now() - Number(phone.lastSeen) < 60000) : false;

    res.json(sanitize({
      success: true,
      pairCode: pc,
      laptop: laptop ? { deviceId: laptop.deviceId, systemInfo: laptop.systemInfo ? JSON.parse(laptop.systemInfo) : null, online: laptopOnline, lastSeen: laptop.lastSeen } : null,
      phone: phone ? { deviceId: phone.deviceId, online: phoneOnline, lastSeen: phone.lastSeen } : null,
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
      await prisma.location.upsert({
        where: { deviceId },
        create: { deviceId, lat: location.lat, lng: location.lng, accuracy: location.accuracy || 10, source: location.source || 'heartbeat', updatedAt: now() },
        update: { lat: location.lat, lng: location.lng, accuracy: location.accuracy || 10, source: location.source || 'heartbeat', updatedAt: now() }
      });

      // Broadcast location to paired device
      const dev = await prisma.device.findUnique({ where: { deviceId } });
      if (dev) {
        const pair = await prisma.device.findFirst({ where: { pairCode: dev.pairCode, deviceId: { not: deviceId } } });
        if (pair) broadcast(pair.deviceId, { type: 'location', fromDeviceId: deviceId, location });
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
      await prisma.location.upsert({
        where: { deviceId },
        create: { deviceId, lat: location.lat, lng: location.lng, accuracy: location.accuracy || 10, source: location.source || 'phone-gps', updatedAt: now() },
        update: { lat: location.lat, lng: location.lng, accuracy: location.accuracy || 10, source: location.source || 'phone-gps', updatedAt: now() }
      });
      const dev = await prisma.device.findUnique({ where: { deviceId } });
      if (dev) {
        const pair = await prisma.device.findFirst({ where: { pairCode: dev.pairCode, deviceId: { not: deviceId } } });
        if (pair) broadcast(pair.deviceId, { type: 'location', fromDeviceId: deviceId, location });
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
    const sent = broadcast(deviceId, { type: 'command', commandId, commandType, params });
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
      const pair = await prisma.device.findFirst({ where: { pairCode: dev.pairCode, deviceId: { not: dev.deviceId } } });
      if (pair) broadcast(pair.deviceId, { type: 'commandResult', commandId, commandType: cmd.commandType, result: cmd.result });
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/lost-mode', (req, res) => {
  try {
    const { deviceId, active } = req.body;
    if (active) { lostDevices.add(deviceId); broadcast(deviceId, { type: 'command', commandType: 'lost-mode-on', commandId: 'lm-' + Date.now() }); }
    else { lostDevices.delete(deviceId); broadcast(deviceId, { type: 'command', commandType: 'lost-mode-off', commandId: 'lm-' + Date.now() }); }
    res.json({ success: true, isLost: lostDevices.has(deviceId) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ============= STATIC =============
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => { if (!req.url.startsWith('/api/')) res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ============= WEBSOCKET =============
function broadcast(targetId, data) {
  if (sockets.has(targetId)) {
    try { sockets.get(targetId).send(JSON.stringify(data)); } catch(e) {}
    return true;
  }
  return false;
}

wss.on('connection', (ws) => {
  let myId = null;
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'register') {
        myId = msg.deviceId;
        sockets.set(myId, ws);
        try { await prisma.device.update({ where: { deviceId: myId }, data: { lastSeen: now() } }); } catch(e) {}
        console.log(`WS Registered: ${myId}`);
        return;
      }
      if (myId) {
        const dev = await prisma.device.findUnique({ where: { deviceId: myId } });
        if (dev) {
          const pair = await prisma.device.findFirst({ where: { pairCode: dev.pairCode, deviceId: { not: myId } } });
          if (pair) broadcast(pair.deviceId, { ...msg, fromDeviceId: myId });
        }
      }
    } catch(e) { console.error('WS Error:', e); }
  });
  ws.on('close', () => { if (myId && sockets.get(myId) === ws) sockets.delete(myId); });
});

// ============= LOST MODE TIMER =============
setInterval(() => {
  for (const deviceId of lostDevices) {
    broadcast(deviceId, { type: 'command', commandType: 'forensic-init', commandId: 'auto-' + Date.now() });
    broadcast(deviceId, { type: 'command', commandType: 'lock', commandId: 'auto-lock-' + Date.now() });
  }
}, 60000);

server.listen(PORT, '0.0.0.0', () => console.log('FIND Server running on', PORT));
