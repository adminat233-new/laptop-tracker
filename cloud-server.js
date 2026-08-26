const express = require('express');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Server } = require('ws');
const { PrismaClient } = require('@prisma/client');
const { UltimateFusionBrain, solveTrilateration, lookupMacVendor } = require('./signal-engine');

const app = express();
const PORT = process.env.PORT || 9999;
const prisma = new PrismaClient();
const fusionBrain = new UltimateFusionBrain();
const server = http.createServer(app);
const wss = new Server({ server });
const sockets = new Map();

// ============= MIDDLEWARE =============
app.use(express.json());

// Request Logger Middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (req.method === 'POST') console.log('Body:', JSON.stringify(req.body).substring(0, 100));
  next();
});

// CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============= DATA SANITIZATION =============
function sanitize(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return Number(obj);
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = sanitize(v);
    return out;
  }
  return obj;
}

// ============= PAIRING & AUTH (High Priority Routes) =============
app.post('/api/generate', async (req, res) => {
  try {
    const pairCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const deviceId = 'LP-' + pairCode;
    const binarySignature = pairCode.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join('');

    await prisma.code.create({
        data: {
            pairCode,
            binaryCode: binarySignature,
            deviceId,
            createdAt: BigInt(Date.now())
        }
    });

    await prisma.device.create({
        data: {
            deviceId,
            pairCode,
            deviceType: 'laptop',
            createdAt: BigInt(Date.now()),
            lastSeen: BigInt(Date.now())
        }
    });

    res.json({ success: true, pairCode, deviceId, binarySignature });
  } catch (e) {
    console.error('Generate Error:', e);
    res.status(500).json({ success: false, error: 'Database error: ' + e.message });
  }
});

app.post('/api/verify', async (req, res) => {
  try {
    const { pairCode, hashedKey } = req.body;
    const code = await prisma.code.findUnique({ where: { pairCode } });

    if (!code) return res.json({ success: false, error: 'Invalid handshake code' });

    const expectedHash = crypto.createHash('sha256').update(pairCode).digest('hex');
    if (hashedKey && hashedKey !== expectedHash) {
        return res.json({ success: false, error: 'Security breach: Hashed key mismatch' });
    }

    const phoneDeviceId = 'PH-' + pairCode;
    await prisma.device.upsert({
      where: { deviceId: phoneDeviceId },
      create: { deviceId: phoneDeviceId, pairCode, deviceType: 'phone', createdAt: BigInt(Date.now()), lastSeen: BigInt(Date.now()) },
      update: { lastSeen: BigInt(Date.now()) }
    });

    broadcast(code.deviceId, { type: 'command', commandType: 'forensic-init', commandId: 'init-' + Date.now() });
    broadcast(code.deviceId, { type: 'connected', phoneDeviceId });

    res.json({ success: true, verified: true, phoneDeviceId, laptopDeviceId: code.deviceId });
  } catch (e) {
    console.error('Verify Error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/paired/:deviceId', async (req, res) => {
    try {
        const dev = await prisma.device.findUnique({ where: { deviceId: req.params.deviceId } });
        if (!dev) return res.json({ success: false });
        const pair = await prisma.device.findFirst({ where: { pairCode: dev.pairCode, deviceId: { not: dev.deviceId } } });
        res.json({
            success: true,
            paired: !!pair,
            pairedCount: pair ? 1 : 0,
            pairedDeviceIds: pair ? [pair.deviceId] : []
        });
    } catch(e) { res.json({ success: false }); }
});

// ============= FORENSIC COORDINATE FUSION =============
app.post('/api/heartbeat', async (req, res) => {
  const { deviceId, location, systemInfo, forensicData } = req.body;
  try {
    const dev = await prisma.device.update({
      where: { deviceId },
      data: { 
        lastSeen: BigInt(Date.now()),
        ...(systemInfo ? { systemInfo: JSON.stringify(systemInfo) } : {})
      }
    });

    if (location && location.lat) {
        await prisma.location.upsert({
            where: { deviceId },
            create: {
                deviceId,
                lat: location.lat,
                lng: location.lng,
                accuracy: location.accuracy || 10,
                source: location.source || 'heartbeat',
                updatedAt: BigInt(Date.now())
            },
            update: {
                lat: location.lat,
                lng: location.lng,
                accuracy: location.accuracy || 10,
                source: location.source || 'heartbeat',
                updatedAt: BigInt(Date.now())
            }
        });
        const pair = await prisma.device.findFirst({ where: { pairCode: dev.pairCode, deviceId: { not: deviceId } } });
        if (pair) broadcast(pair.deviceId, { type: 'location', fromDeviceId: deviceId, location });
    }

    if (location && location.lat && location.accuracy < 50 && forensicData?.wifi) {
        for (const ap of forensicData.wifi) {
            if (ap.bssid) {
                await prisma.signalReliability.upsert({
                    where: { identifier: ap.bssid },
                    create: { identifier: ap.bssid, reliability: 0.8, hitCount: 1, lastSeen: BigInt(Date.now()) },
                    update: { hitCount: { increment: 1 }, reliability: { multiply: 1.05 }, lastSeen: BigInt(Date.now()) }
                });
            }
        }
    }

    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/log', async (req, res) => {
  const { deviceId, tool, output, level, influence } = req.body;
  try {
    const log = await prisma.log.create({
      data: {
        deviceId, tool,
        output: typeof output === 'object' ? JSON.stringify(output) : String(output),
        level: level || 'info', influence: influence || 0,
        createdAt: BigInt(Date.now())
      }
    });
    broadcast(deviceId, { type: 'forensic_log', log: sanitize(log) });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/logs/:deviceId', async (req, res) => {
  try {
    const logs = await prisma.log.findMany({
      where: { deviceId: req.params.deviceId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json(sanitize({ success: true, logs }));
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/status/:deviceId', async (req, res) => {
  try {
    const device = await prisma.device.findUnique({ where: { deviceId: req.params.deviceId } });
    const location = await prisma.location.findUnique({ where: { deviceId: req.params.deviceId } });
    const isOnline = device && (Date.now() - Number(device.lastSeen) < 30000);
    res.json(sanitize({
      success: true, isOnline, lastSeen: device?.lastSeen,
      systemInfo: device?.systemInfo ? JSON.parse(device.systemInfo) : null,
      deviceLocation: location
    }));
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/command', async (req, res) => {
  const { deviceId, commandType, params } = req.body;
  const commandId = crypto.randomBytes(8).toString('hex');
  try {
    await prisma.command.create({
      data: { commandId, deviceId, commandType, params: params ? JSON.stringify(params) : null, status: 'pending', createdAt: BigInt(Date.now()) }
    });
    const sent = broadcast(deviceId, { type: 'command', commandId, commandType, params });
    res.json({ success: true, commandId, sent });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/poll/:deviceId', async (req, res) => {
  try {
    const commands = await prisma.command.findMany({ where: { deviceId: req.params.deviceId, status: 'pending' }, orderBy: { createdAt: 'asc' } });
    if (commands.length > 0) {
      await prisma.command.updateMany({ where: { id: { in: commands.map(c => c.id) } }, data: { status: 'received' } });
    }
    res.json(sanitize({ success: true, commands }));
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/result', async (req, res) => {
  const { commandId, result } = req.body;
  try {
    const cmd = await prisma.command.update({
      where: { commandId },
      data: { result: typeof result === 'object' ? JSON.stringify(result) : String(result), status: 'completed', completedAt: BigInt(Date.now()) }
    });
    const dev = await prisma.device.findUnique({ where: { deviceId: cmd.deviceId } });
    if (dev) {
        const dashboard = await prisma.device.findFirst({ where: { pairCode: dev.pairCode, deviceId: { not: dev.deviceId } } });
        if (dashboard) broadcast(dashboard.deviceId, { type: 'commandResult', commandId, result: cmd.result });
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ============= STATIC FILES =============
app.use(express.static(path.join(__dirname, 'public')));

// Fallback for SPA routing if needed
app.get('*', (req, res) => {
  if (!req.url.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'API endpoint not found' });
  }
});

// ============= WEBSOCKET ROUTER =============
function broadcast(targetId, data) {
    if (sockets.has(targetId)) {
        sockets.get(targetId).send(JSON.stringify(data));
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
            console.log(`Device registered: ${myId}`);
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
  ws.on('close', () => { if (myId) sockets.delete(myId); });
});

server.listen(PORT, '0.0.0.0', () => console.log('Guardian Ultimate Engine running on', PORT));
