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

setInterval(() => {
  for (const deviceId of lostDevices) {
    broadcast(deviceId, { type: 'command', commandType: 'forensic-init', commandId: 'auto-' + Date.now() });
    broadcast(deviceId, { type: 'command', commandType: 'lock', commandId: 'auto-lock-' + Date.now() });
  }
}, 60000);

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function sanitize(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return Number(obj);
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (typeof obj === 'object') { const out = {}; for (const [k, v] of Object.entries(obj)) out[k] = sanitize(v); return out; }
  return obj;
}

function now() { return BigInt(Date.now()); }

// ============= PAIRING =============
app.post('/api/generate', async (req, res) => {
  try {
    const pairCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const laptopId = pairCode;

    await prisma.code.upsert({
      where: { pairCode },
      create: { pairCode, binaryCode: pairCode, deviceId: laptopId, createdAt: now() },
      update: { deviceId: laptopId }
    });

    await prisma.device.upsert({
      where: { deviceId: laptopId },
      create: { deviceId: laptopId, pairCode, deviceType: 'laptop', createdAt: now(), lastSeen: now() },
      update: { lastSeen: now() }
    });

    res.json({ success: true, pairCode, deviceId: laptopId });
  } catch (e) {
    console.error('Generate Error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/verify', async (req, res) => {
  try {
    const { pairCode } = req.body;
    const code = await prisma.code.findUnique({ where: { pairCode } });
    if (!code) return res.json({ success: false, error: 'Invalid code' });

    const phoneId = pairCode + '-phone';
    const laptopId = code.deviceId;

    await prisma.device.upsert({
      where: { deviceId: phoneId },
      create: { deviceId: phoneId, pairCode, deviceType: 'phone', createdAt: now(), lastSeen: now() },
      update: { lastSeen: now() }
    });

    broadcast(laptopId, { type: 'paired', phoneId });
    broadcast(laptopId, { type: 'command', commandType: 'locate', commandId: 'init-loc-' + Date.now() });

    res.json({ success: true, laptopId, phoneId, pairCode });
  } catch (e) {
    console.error('Verify Error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/pair-info/:pairCode', async (req, res) => {
  try {
    const code = await prisma.code.findUnique({ where: { pairCode: req.params.pairCode } });
    if (!code) return res.json({ success: false });
    const devices = await prisma.device.findMany({ where: { pairCode: req.params.pairCode } });
    const laptop = devices.find(d => d.deviceType === 'laptop');
    const phone = devices.find(d => d.deviceType === 'phone');
    const laptopLoc = laptop ? await prisma.location.findUnique({ where: { deviceId: laptop.deviceId } }) : null;
    const phoneLoc = phone ? await prisma.location.findUnique({ where: { deviceId: phone.deviceId } }) : null;
    const laptopOnline = laptop && (Date.now() - Number(laptop.lastSeen) < 30000);
    const phoneOnline = phone && (Date.now() - Number(phone.lastSeen) < 30000);
    res.json(sanitize({
      success: true,
      pairCode: req.params.pairCode,
      laptop: laptop ? { deviceId: laptop.deviceId, systemInfo: laptop.systemInfo ? JSON.parse(laptop.systemInfo) : null, online: laptopOnline, lastSeen: laptop.lastSeen } : null,
      phone: phone ? { deviceId: phone.deviceId, online: phoneOnline, lastSeen: phone.lastSeen } : null,
      laptopLocation: laptopLoc,
      phoneLocation: phoneLoc
    }));
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ============= HEARTBEAT & LOCATION =============
app.post('/api/heartbeat', async (req, res) => {
  const { deviceId, location, systemInfo, forensicData } = req.body;
  try {
    await prisma.device.update({
      where: { deviceId },
      data: { lastSeen: now(), ...(systemInfo ? { systemInfo: JSON.stringify(systemInfo) } : {}) }
    });

    let fusedLocation = location;

    if ((!location || location.lat == null || location.accuracy > 500) && (forensicData?.wifi || forensicData?.gatewayMac)) {
      const inputs = [];
      if (location && location.lat != null) inputs.push(location);
      const geoResult = await geolocationService.resolveFromWifi(forensicData.wifi, forensicData.gatewayMac);
      if (geoResult) inputs.push(geoResult);
      if (inputs.length > 0) fusedLocation = inputs[0];
    }

    if (fusedLocation && fusedLocation.lat != null) {
      await prisma.location.upsert({
        where: { deviceId },
        create: { deviceId, lat: fusedLocation.lat, lng: fusedLocation.lng, accuracy: fusedLocation.accuracy || 10, source: fusedLocation.source || 'heartbeat', updatedAt: now() },
        update: { lat: fusedLocation.lat, lng: fusedLocation.lng, accuracy: fusedLocation.accuracy || 10, source: fusedLocation.source || 'heartbeat', updatedAt: now() }
      });

      const dev = await prisma.device.findUnique({ where: { deviceId } });
      if (dev) {
        const pair = await prisma.device.findFirst({ where: { pairCode: dev.pairCode, deviceId: { not: deviceId } } });
        if (pair) broadcast(pair.deviceId, { type: 'location', fromDeviceId: deviceId, location: fusedLocation });
      }
    }

    res.json({ success: true, location: fusedLocation });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/bssid-lookup', async (req, res) => {
  const { bssids, gatewayMac } = req.body;
  try {
    const result = await geolocationService.resolveFromWifi(bssids, gatewayMac);
    res.json({ success: !!result, ...result });
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

app.get('/api/poll/:deviceId', async (req, res) => {
  try {
    const commands = await prisma.command.findMany({ where: { deviceId: req.params.deviceId, status: 'pending' }, orderBy: { createdAt: 'asc' } });
    if (commands.length > 0) await prisma.command.updateMany({ where: { id: { in: commands.map(c => c.id) } }, data: { status: 'received' } });
    res.json(sanitize({ success: true, commands }));
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/lost-mode', (req, res) => {
  try {
    const { deviceId, active } = req.body;
    if (active) { lostDevices.add(deviceId); broadcast(deviceId, { type: 'command', commandType: 'lost-mode-on', commandId: 'lm-' + Date.now() }); }
    else { lostDevices.delete(deviceId); broadcast(deviceId, { type: 'command', commandType: 'lost-mode-off', commandId: 'lm-off-' + Date.now() }); }
    res.json({ success: true, isLost: lostDevices.has(deviceId) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/location/phone', async (req, res) => {
  const { deviceId, location } = req.body;
  try {
    if (location && location.lat != null) {
      await prisma.location.upsert({
        where: { deviceId },
        create: { deviceId, lat: location.lat, lng: location.lng, accuracy: location.accuracy || 10, source: location.source || 'phone-gps', updatedAt: now() },
        update: { lat: location.lat, lng: location.lng, accuracy: location.accuracy || 10, source: location.source || 'phone-gps', updatedAt: now() }
      });
      await prisma.device.update({ where: { deviceId }, data: { lastSeen: now() } });
      const dev = await prisma.device.findUnique({ where: { deviceId } });
      if (dev) {
        const pair = await prisma.device.findFirst({ where: { pairCode: dev.pairCode, deviceId: { not: deviceId } } });
        if (pair) broadcast(pair.deviceId, { type: 'location', fromDeviceId: deviceId, location });
      }
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/agent-status/:deviceId', async (req, res) => {
  try {
    const device = await prisma.device.findUnique({ where: { deviceId: req.params.deviceId } });
    if (!device) return res.json({ success: false });
    res.json(sanitize({ success: true, online: device.lastSeen && (Date.now() - Number(device.lastSeen) < 30000), systemInfo: device.systemInfo ? JSON.parse(device.systemInfo) : null }));
  } catch (e) { res.json({ success: false }); }
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
        console.log(`Registered: ${myId}`);
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

server.listen(PORT, '0.0.0.0', () => console.log('Server running on', PORT));
