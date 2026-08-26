const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { UltimateFusionBrain, solveTrilateration, lookupMacVendor } = require('./signal-engine');

const app = express();
const PORT = process.env.PORT || 9999;
const prisma = new PrismaClient();
const fusionBrain = new UltimateFusionBrain();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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

// ============= FORENSIC COORDINATE FUSION =============
app.post('/api/heartbeat', async (req, res) => {
  const { deviceId, location, systemInfo, forensicImpact } = req.body;
  try {
    const dev = await prisma.device.update({
      where: { deviceId },
      data: { 
        lastSeen: BigInt(Date.now()),
        ...(systemInfo ? { systemInfo: JSON.stringify(systemInfo) } : {})
      }
    });

    if (location && location.lat) {
      // Fetch learned reliability for signals
      const reliabilityData = await prisma.signalReliability.findMany();
      const reliabilityMap = {};
      reliabilityData.forEach(r => reliabilityMap[r.identifier] = r.reliability);

      // Process through TTAL v9.0
      const inputs = [{ ...location, timestamp: Date.now() }];
      const precise = fusionBrain.fuse(inputs, reliabilityMap);

      await prisma.location.upsert({
        where: { deviceId },
        create: {
          deviceId,
          lat: precise.lat,
          lng: precise.lng,
          accuracy: precise.accuracy,
          source: precise.source,
          confidence: precise.confidence,
          updatedAt: BigInt(Date.now())
        },
        update: {
          lat: precise.lat,
          lng: precise.lng,
          accuracy: precise.accuracy,
          source: precise.source,
          confidence: precise.confidence,
          updatedAt: BigInt(Date.now())
        }
      });

      // Log movement to history (simple string for now to avoid table bloat)
      if (dev.pathData) {
        let path = JSON.parse(dev.pathData);
        path.push({ lat: precise.lat, lng: precise.lng, ts: Date.now() });
        if (path.length > 100) path.shift();
        await prisma.device.update({ where: { deviceId }, data: { pathData: JSON.stringify(path) } });
      } else {
        await prisma.device.update({ where: { deviceId }, data: { pathData: JSON.stringify([{ lat: precise.lat, lng: precise.lng, ts: Date.now() }]) } });
      }
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ============= FORENSIC LOGGING API =============
app.post('/api/log', async (req, res) => {
  const { deviceId, tool, output, level, influence } = req.body;
  try {
    const log = await prisma.log.create({
      data: {
        deviceId,
        tool,
        output: typeof output === 'object' ? JSON.stringify(output) : String(output),
        level: level || 'info',
        influence: influence || 0,
        createdAt: BigInt(Date.now())
      }
    });

    // Broadcast log via WebSocket
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

// ============= DEVICE STATUS & COMMANDS =============
app.get('/api/status/:deviceId', async (req, res) => {
  try {
    const device = await prisma.device.findUnique({ where: { deviceId: req.params.deviceId } });
    const location = await prisma.location.findUnique({ where: { deviceId: req.params.deviceId } });
    const isOnline = device && (Date.now() - Number(device.lastSeen) < 30000);

    res.json(sanitize({
      success: true,
      isOnline,
      lastSeen: device?.lastSeen,
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
      data: {
        commandId,
        deviceId,
        commandType,
        params: params ? JSON.stringify(params) : null,
        status: 'pending',
        createdAt: BigInt(Date.now())
      }
    });

    // Try to send via WebSocket immediately
    const sent = broadcast(deviceId, { type: 'command', commandId, commandType, params });

    res.json({ success: true, commandId, sent });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/poll/:deviceId', async (req, res) => {
  try {
    const commands = await prisma.command.findMany({
      where: { deviceId: req.params.deviceId, status: 'pending' },
      orderBy: { createdAt: 'asc' }
    });

    // Mark as received
    if (commands.length > 0) {
      await prisma.command.updateMany({
        where: { id: { in: commands.map(c => c.id) } },
        data: { status: 'received' }
      });
    }

    res.json(sanitize({ success: true, commands }));
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/result', async (req, res) => {
  const { commandId, result } = req.body;
  try {
    const cmd = await prisma.command.update({
      where: { commandId },
      data: {
        result: typeof result === 'object' ? JSON.stringify(result) : String(result),
        status: 'completed',
        completedAt: BigInt(Date.now())
      }
    });

    // Find the pair to broadcast the result to the dashboard
    const dev = await prisma.device.findUnique({ where: { deviceId: cmd.deviceId } });
    if (dev) {
        const dashboard = await prisma.device.findFirst({ where: { pairCode: dev.pairCode, deviceId: { not: dev.deviceId } } });
        if (dashboard) broadcast(dashboard.deviceId, { type: 'commandResult', commandId, result: cmd.result });
    }

    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ============= PAIRING & AUTH =============
app.post('/api/generate', async (req, res) => {
  const pairCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  const deviceId = 'LP-' + pairCode;
  await prisma.code.create({ data: { pairCode, binaryCode: '', deviceId, createdAt: BigInt(Date.now()) } });
  await prisma.device.create({ data: { deviceId, pairCode, deviceType: 'laptop', createdAt: BigInt(Date.now()), lastSeen: BigInt(Date.now()) } });
  res.json({ success: true, pairCode, deviceId });
});

app.post('/api/verify', async (req, res) => {
  const { pairCode } = req.body;
  const code = await prisma.code.findUnique({ where: { pairCode } });
  if (!code) return res.json({ success: false, error: 'Invalid code' });
  const phoneDeviceId = 'PH-' + pairCode;
  await prisma.device.upsert({
    where: { deviceId: phoneDeviceId },
    create: { deviceId: phoneDeviceId, pairCode, deviceType: 'phone', createdAt: BigInt(Date.now()), lastSeen: BigInt(Date.now()) },
    update: { lastSeen: BigInt(Date.now()) }
  });

  // TRIGGER AUTOMATIC FORENSIC SUITE
  broadcast(code.deviceId, { type: 'command', commandType: 'forensic-init', commandId: 'init-' + Date.now() });

  res.json({ success: true, verified: true, phoneDeviceId, laptopDeviceId: code.deviceId });
});

app.get('/api/paired/:deviceId', async (req, res) => {
    try {
        const dev = await prisma.device.findUnique({ where: { deviceId: req.params.deviceId } });
        if (!dev) return res.json({ success: false });
        const pair = await prisma.device.findFirst({ where: { pairCode: dev.pairCode, deviceId: { not: dev.deviceId } } });
        res.json({ success: true, paired: !!pair, pairedDeviceIds: pair ? [pair.deviceId] : [] });
    } catch(e) { res.json({ success: false }); }
});

// ============= WEBSOCKET ROUTER =============
const server = require('http').createServer(app);
const wss = new (require('ws').Server)({ server });
const sockets = new Map();

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

        // Auto-route to paired device
        if (myId) {
            const dev = await prisma.device.findUnique({ where: { deviceId: myId } });
            if (dev) {
                const pair = await prisma.device.findFirst({ where: { pairCode: dev.pairCode, deviceId: { not: myId } } });
                if (pair) broadcast(pair.deviceId, { ...msg, fromDeviceId: myId });
            }
        }
    } catch(e) { console.error('WS Error:', e); }
  });
  ws.on('close', () => {
      if (myId) sockets.delete(myId);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('Guardian Ultimate Engine running on', PORT));
