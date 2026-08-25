const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { PrismaClient } = require('./generated/prisma');

const app = express();
const PORT = process.env.PORT || 9999;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ============= DATABASE =============
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

async function initDB() {
  console.log('Connecting to database...');
  await prisma.$connect();
  console.log('Database connected');
}

// ============= BINARY VERIFICATION =============
function charToBinary(char) {
  return char.charCodeAt(0).toString(2).padStart(8, '0');
}

function codeToBinary(code) {
  return code.split('').map(charToBinary).join(' ');
}

// ============= HEALTH CHECK =============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// ============= LAPTOP: Generate & Store Code =============
app.post('/api/generate', async (req, res) => {
  const { systemInfo } = req.body;

  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let pairCode = '';
  for (let i = 0; i < 8; i++) pairCode += chars.charAt(Math.floor(Math.random() * chars.length));

  const binaryCode = codeToBinary(pairCode);
  const deviceId = 'dev_' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();

  try {
    await prisma.code.create({
      data: {
        pairCode,
        binaryCode,
        deviceId,
        createdAt: now,
      },
    });

    await prisma.device.create({
      data: {
        deviceId,
        pairCode,
        deviceType: 'laptop',
        systemInfo: JSON.stringify(systemInfo),
        lastSeen: now,
        createdAt: now,
      },
    });

    console.log(`Generated: ${pairCode} -> ${deviceId}`);
    res.json({ success: true, pairCode, binaryCode, deviceId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= PHONE: Verify Code =============
app.post('/api/verify', async (req, res) => {
  const { pairCode } = req.body;

  try {
    const codeRecord = await prisma.code.findUnique({
      where: { pairCode },
    });

    if (!codeRecord) {
      return res.json({ success: false, error: 'Code not found. Generate on laptop first.' });
    }

    const enteredBinary = codeToBinary(pairCode);

    if (enteredBinary !== codeRecord.binaryCode) {
      return res.json({ success: false, error: 'Binary verification failed' });
    }

    await prisma.code.update({
      where: { pairCode },
      data: { isPaired: true, pairedAt: Date.now() },
    });

    const deviceRecord = await prisma.device.findUnique({
      where: { deviceId: codeRecord.deviceId },
    });

    const locationRecord = await prisma.location.findUnique({
      where: { deviceId: codeRecord.deviceId },
    });

    const phoneDeviceId = 'dev_' + crypto.randomBytes(8).toString('hex');
    await prisma.device.create({
      data: {
        deviceId: phoneDeviceId,
        pairCode,
        deviceType: 'phone',
        systemInfo: '{}',
        lastSeen: Date.now(),
        createdAt: Date.now(),
      },
    });

    console.log(`Verified & Paired: ${pairCode}`);

    res.json({
      success: true,
      verified: true,
      laptopDeviceId: codeRecord.deviceId,
      phoneDeviceId,
      deviceInfo: deviceRecord ? JSON.parse(deviceRecord.systemInfo || '{}') : null,
      laptopLocation: locationRecord || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= LAPTOP: Poll Commands =============
app.get('/api/poll/:deviceId', async (req, res) => {
  const { deviceId } = req.params;

  try {
    await prisma.device.update({
      where: { deviceId },
      data: { lastSeen: Date.now() },
    });

    const pendingCommands = await prisma.command.findMany({
      where: { deviceId, status: 'pending' },
    });

    for (const cmd of pendingCommands) {
      await prisma.command.update({
        where: { commandId: cmd.commandId },
        data: { status: 'sent' },
      });
    }

    res.json({
      success: true,
      commands: pendingCommands.map((c) => ({
        commandId: c.commandId,
        commandType: c.commandType,
        params: JSON.parse(c.params || '{}'),
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= LAPTOP: Send Result =============
app.post('/api/result', async (req, res) => {
  const { commandId, result, error } = req.body;

  try {
    await prisma.command.update({
      where: { commandId },
      data: {
        result: result || null,
        error: error || null,
        status: error ? 'failed' : 'completed',
        completedAt: Date.now(),
      },
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= LAPTOP: Send Heartbeat =============
app.post('/api/heartbeat', async (req, res) => {
  const { deviceId, location, systemInfo } = req.body;

  try {
    await prisma.device.update({
      where: { deviceId },
      data: { lastSeen: Date.now() },
    });

    if (location) {
      await prisma.location.upsert({
        where: { deviceId },
        create: {
          deviceId,
          lat: location.lat,
          lng: location.lng,
          intLat: location.intLat || Math.round(location.lat * 1000000),
          intLng: location.intLng || Math.round(location.lng * 1000000),
          city: location.city,
          region: location.region,
          country: location.country,
          ip: location.ip,
          updatedAt: Date.now(),
        },
        update: {
          lat: location.lat,
          lng: location.lng,
          intLat: location.intLat || Math.round(location.lat * 1000000),
          intLng: location.intLng || Math.round(location.lng * 1000000),
          city: location.city,
          region: location.region,
          country: location.country,
          ip: location.ip,
          updatedAt: Date.now(),
        },
      });
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= PHONE: Send Command =============
app.post('/api/command', async (req, res) => {
  const { deviceId, commandType, params } = req.body;

  const commandId = 'cmd_' + crypto.randomBytes(8).toString('hex');

  try {
    await prisma.command.create({
      data: {
        commandId,
        deviceId,
        commandType,
        params: JSON.stringify(params || {}),
        status: 'pending',
        createdAt: Date.now(),
      },
    });

    console.log(`Command: ${commandType} for ${deviceId}`);
    res.json({ success: true, commandId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= PHONE: Get Result =============
app.get('/api/result/:commandId', async (req, res) => {
  try {
    const command = await prisma.command.findUnique({
      where: { commandId: req.params.commandId },
    });

    if (!command) {
      return res.json({ success: true, status: 'pending' });
    }

    res.json({ success: true, status: command.status, result: command.result, error: command.error });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= PHONE: Send Location =============
app.post('/api/location/phone', async (req, res) => {
  const { deviceId, location } = req.body;

  try {
    await prisma.location.upsert({
      where: { deviceId },
      create: {
        deviceId,
        lat: location.lat,
        lng: location.lng,
        intLat: location.intLat || Math.round(location.lat * 1000000),
        intLng: location.intLng || Math.round(location.lng * 1000000),
        updatedAt: Date.now(),
      },
      update: {
        lat: location.lat,
        lng: location.lng,
        intLat: location.intLat || Math.round(location.lat * 1000000),
        intLng: location.intLng || Math.round(location.lng * 1000000),
        updatedAt: Date.now(),
      },
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= PHONE: Get Status =============
app.get('/api/status/:deviceId', async (req, res) => {
  try {
    const deviceRecord = await prisma.device.findUnique({
      where: { deviceId: req.params.deviceId },
    });

    if (!deviceRecord) {
      return res.json({ success: true, isOnline: false });
    }

    const isOnline = Date.now() - Number(deviceRecord.lastSeen) < 15000;

    const locationRecord = await prisma.location.findUnique({
      where: { deviceId: req.params.deviceId },
    });

    const pairedDevice = await prisma.device.findFirst({
      where: {
        pairCode: deviceRecord.pairCode,
        deviceId: { not: req.params.deviceId },
      },
    });

    let pairedLocation = null;
    if (pairedDevice) {
      pairedLocation = await prisma.location.findUnique({
        where: { deviceId: pairedDevice.deviceId },
      });
    }

    res.json({
      success: true,
      isOnline,
      lastSeen: deviceRecord.lastSeen,
      systemInfo: JSON.parse(deviceRecord.systemInfo || '{}'),
      myLocation: locationRecord || null,
      pairedLocation,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= CLEANUP =============
setInterval(async () => {
  try {
    const hourAgo = Date.now() - 3600000;
    await prisma.code.deleteMany({
      where: { createdAt: { lt: hourAgo } },
    });
    await prisma.command.deleteMany({
      where: { createdAt: { lt: hourAgo * 6 } },
    });
  } catch (e) {}
}, 600000);

// ============= START =============
initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Failed to initialize database:', e);
    process.exit(1);
  });

module.exports = app;
