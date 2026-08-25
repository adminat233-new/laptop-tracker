const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const app = express();
const PORT = process.env.PORT || 9999;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ============= BIGINT HELPERS =============
function toNum(val) {
  return typeof val === 'bigint' ? Number(val) : val;
}

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

// ============= TRACKING MATH =============
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function calculateBearing(lat1, lng1, lat2, lng2) {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
    Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function trilaterate(points) {
  if (points.length < 3) return points[0] || null;
  const p1 = points[0], p2 = points[1], p3 = points[2];
  const R = 6371;
  const d1 = p1.accuracy ? p1.accuracy / 1000 : 1;
  const d2 = p2.accuracy ? p2.accuracy / 1000 : 1;
  const d3 = p3.accuracy ? p3.accuracy / 1000 : 1;
  const x1 = p1.lat, y1 = p1.lng;
  const x2 = p2.lat, y2 = p2.lng;
  const x3 = p3.lat, y3 = p3.lng;
  const A = 2 * (x2 - x1);
  const B = 2 * (y2 - y1);
  const C = d1*d1 - d2*d2 + x2*x2 - x1*x1 + y2*y2 - y1*y1;
  const D = 2 * (x3 - x1);
  const E = 2 * (y3 - y1);
  const F = d1*d1 - d3*d3 + x3*x3 - x1*x1 + y3*y3 - y1*y1;
  const det = A*E - B*D;
  if (Math.abs(det) < 1e-10) return points[0];
  const lat = (C*E - B*F) / det;
  const lng = (A*F - C*D) / det;
  return { lat, lng, source: 'trilateration' };
}

function pathLossDistance(signalStrength, frequency, txPower) {
  const n = 2.8;
  const refPower = txPower || -50;
  if (!signalStrength || signalStrength === 0) return null;
  const ratio = (refPower - signalStrength) / (10 * n);
  return Math.pow(10, ratio);
}

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

    res.json(sanitize({
      success: true,
      verified: true,
      laptopDeviceId: codeRecord.deviceId,
      phoneDeviceId,
      deviceInfo: deviceRecord ? JSON.parse(deviceRecord.systemInfo || '{}') : null,
      laptopLocation: locationRecord || null,
    }));
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
      data: {
        lastSeen: Date.now(),
        ...(systemInfo ? { systemInfo: JSON.stringify(systemInfo) } : {}),
      },
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

// ============= LAPTOP: Network Scan =============
app.get('/api/netscan/:deviceId', async (req, res) => {
  try {
    const platform = process.platform;
    let cmd = '';

    if (platform === 'win32') {
      cmd = 'netsh wlan show networks mode=bssid';
    } else if (platform === 'linux') {
      cmd = 'iwlist wlan0 scan 2>/dev/null || nmcli device wifi list 2>/dev/null || iw dev wlan0 scan 2>/dev/null';
    } else if (platform === 'darwin') {
      cmd = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -s';
    }

    if (!cmd) {
      return res.json(sanitize({ success: true, networks: [], message: 'Platform not supported: ' + platform }));
    }

    exec(cmd, { timeout: 10000 }, async (error, stdout, stderr) => {
      let networks = [];

      if (platform === 'win32' && stdout) {
        const lines = stdout.split('\n');
        let current = {};
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('SSID')) {
            if (current.ssid) networks.push(current);
            current = { ssid: trimmed.split(':').slice(1).join(':').trim() };
          } else if (trimmed.startsWith('Authentication')) {
            current.auth = trimmed.split(':').slice(1).join(':').trim();
          } else if (trimmed.startsWith('Encryption')) {
            current.encryption = trimmed.split(':').slice(1).join(':').trim();
          } else if (trimmed.startsWith('Signal')) {
            current.signal = trimmed.split(':').slice(1).join(':').trim();
          } else if (trimmed.startsWith('BSSID')) {
            current.bssid = trimmed.split(':').slice(1).join(':').trim();
          } else if (trimmed.startsWith('Channel')) {
            current.channel = trimmed.split(':').slice(1).join(':').trim();
          }
        }
        if (current.ssid) networks.push(current);
      } else if (stdout) {
        const lines = stdout.split('\n').filter(l => l.trim());
        for (const line of lines) {
          if (line.includes('ESSID') || line.includes('SSID')) {
            const ssid = line.match(/"([^"]+)"/);
            if (ssid) networks.push({ ssid: ssid[1] });
          }
        }
      }

      await prisma.device.update({
        where: { deviceId: req.params.deviceId },
        data: { lastSeen: Date.now() },
      });

      res.json(sanitize({
        success: true,
        platform,
        networks,
        raw: stdout || '',
        error: stderr || null,
      }));
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= LAPTOP: Check if Paired =============
app.get('/api/paired/:deviceId', async (req, res) => {
  try {
    const device = await prisma.device.findUnique({
      where: { deviceId: req.params.deviceId },
    });
    if (!device) return res.json(sanitize({ success: true, paired: false }));

    const code = await prisma.code.findUnique({
      where: { pairCode: device.pairCode },
    });

    const pairedDevices = await prisma.device.findMany({
      where: { pairCode: device.pairCode, deviceId: { not: req.params.deviceId } },
    });

    const pairedDeviceIds = pairedDevices.map(d => d.deviceId);

    res.json(sanitize({
      success: true,
      paired: code ? code.isPaired : false,
      pairedCount: pairedDevices.length,
      pairedDeviceIds,
    }));
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
        city: location.city || '',
        region: location.region || '',
        country: location.country || '',
        ip: location.ip || '',
        updatedAt: Date.now(),
      },
      update: {
        lat: location.lat,
        lng: location.lng,
        intLat: location.intLat || Math.round(location.lat * 1000000),
        intLng: location.intLng || Math.round(location.lng * 1000000),
        city: location.city || '',
        region: location.region || '',
        country: location.country || '',
        ip: location.ip || '',
        updatedAt: Date.now(),
      },
    });

    if (location.tracking) {
      await prisma.command.create({
        data: {
          commandId: 'track_' + crypto.randomBytes(8).toString('hex'),
          deviceId,
          commandType: 'trackpoint',
          params: JSON.stringify(location.tracking),
          status: 'completed',
          createdAt: Date.now(),
          completedAt: Date.now(),
        },
      });
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= TRACKING: Get Path History =============
app.get('/api/tracking/path/:deviceId', async (req, res) => {
  try {
    const points = await prisma.command.findMany({
      where: {
        deviceId: req.params.deviceId,
        commandType: 'trackpoint',
      },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });

    const path = points.map(p => {
      const params = JSON.parse(p.params || '{}');
      return {
        lat: params.lat,
        lng: params.lng,
        accuracy: params.accuracy,
        altitude: params.altitude,
        speed: params.speed,
        heading: params.heading,
        source: params.source,
        signalStrength: params.signalStrength,
        timestamp: Number(p.createdAt),
      };
    }).filter(p => p.lat && p.lng);

    let totalDistance = 0;
    for (let i = 1; i < path.length; i++) {
      totalDistance += haversineDistance(path[i-1].lat, path[i-1].lng, path[i].lat, path[i].lng);
    }

    res.json(sanitize({
      success: true,
      path,
      totalPoints: path.length,
      totalDistance: Math.round(totalDistance * 100) / 100,
    }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= TRACKING: Get Live Triangulation =============
app.get('/api/tracking/live/:deviceId', async (req, res) => {
  try {
    const device = await prisma.device.findUnique({
      where: { deviceId: req.params.deviceId },
    });
    if (!device) return res.json(sanitize({ success: true, tracking: null }));

    const location = await prisma.location.findUnique({
      where: { deviceId: req.params.deviceId },
    });
    if (!location) return res.json(sanitize({ success: true, tracking: null }));

    const lastPoints = await prisma.command.findMany({
      where: {
        deviceId: req.params.deviceId,
        commandType: 'trackpoint',
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const recentPath = lastPoints.reverse().map(p => {
      const params = JSON.parse(p.params || '{}');
      return { lat: params.lat, lng: params.lng, timestamp: Number(p.createdAt), source: params.source };
    }).filter(p => p.lat && p.lng);

    let bearing = 0;
    let speed = 0;
    if (recentPath.length >= 2) {
      const last = recentPath[recentPath.length - 1];
      const prev = recentPath[recentPath.length - 2];
      bearing = calculateBearing(prev.lat, prev.lng, last.lat, last.lng);
      const dist = haversineDistance(prev.lat, prev.lng, last.lat, last.lng);
      const timeDiff = (last.timestamp - prev.timestamp) / 1000;
      if (timeDiff > 0) speed = dist / timeDiff;
    }

    res.json(sanitize({
      success: true,
      tracking: {
        lat: location.lat,
        lng: location.lng,
        intLat: Number(location.intLat),
        intLng: Number(location.intLng),
        city: location.city,
        region: location.region,
        country: location.country,
        ip: location.ip,
        bearing,
        speed,
        lastSeen: Number(device.lastSeen),
        recentPath,
      },
    }));
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

    const lastSeenNum = Number(deviceRecord.lastSeen);
    const isOnline = Date.now() - lastSeenNum < 15000;

    const deviceLocation = await prisma.location.findUnique({
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

    res.json(sanitize({
      success: true,
      isOnline,
      lastSeen: lastSeenNum,
      systemInfo: JSON.parse(deviceRecord.systemInfo || '{}'),
      deviceLocation,
      pairedLocation,
    }));
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

// ============= WEBSOCKET REAL-TIME TRACKING =============
const http = require('http');
const WebSocket = require('ws');

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Map of deviceId -> WebSocket connection
const deviceSockets = new Map();

wss.on('connection', (ws, req) => {
  let deviceId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'register') {
        deviceId = msg.deviceId;
        deviceSockets.set(deviceId, ws);
        console.log(`WS registered: ${deviceId}`);
        ws.send(JSON.stringify({ type: 'registered', deviceId }));
      }

      if (msg.type === 'location' && deviceId) {
        const { lat, lng, accuracy, source } = msg.location;
        // Store in DB and broadcast to paired device
        prisma.location.upsert({
          where: { deviceId },
          create: {
            deviceId, lat, lng,
            intLat: Math.round(lat * 1000000),
            intLng: Math.round(lng * 1000000),
            city: msg.location.city || '',
            region: msg.location.region || '',
            country: msg.location.country || '',
            ip: msg.location.ip || '',
            updatedAt: Date.now(),
          },
          update: {
            lat, lng,
            intLat: Math.round(lat * 1000000),
            intLng: Math.round(lng * 1000000),
            city: msg.location.city || '',
            region: msg.location.region || '',
            country: msg.location.country || '',
            ip: msg.location.ip || '',
            updatedAt: Date.now(),
          },
        }).catch(() => {});

        prisma.device.update({
          where: { deviceId },
          data: { lastSeen: Date.now() },
        }).catch(() => {});

        // Find paired device and send location to it
        prisma.device.findUnique({ where: { deviceId } }).then((device) => {
          if (!device) return;
          prisma.device.findFirst({
            where: { pairCode: device.pairCode, deviceId: { not: deviceId } },
          }).then((paired) => {
            if (paired && deviceSockets.has(paired.deviceId)) {
              const pairedWs = deviceSockets.get(paired.deviceId);
              if (pairedWs.readyState === WebSocket.OPEN) {
                pairedWs.send(JSON.stringify({
                  type: 'location',
                  fromDeviceId: deviceId,
                  location: msg.location,
                }));
              }
            }
          }).catch(() => {});
        }).catch(() => {});
      }

      if (msg.type === 'command' && deviceId) {
        // Forward command to paired device
        prisma.device.findUnique({ where: { deviceId } }).then((device) => {
          if (!device) return;
          prisma.device.findFirst({
            where: { pairCode: device.pairCode, deviceId: { not: deviceId } },
          }).then((paired) => {
            if (paired && deviceSockets.has(paired.deviceId)) {
              const pairedWs = deviceSockets.get(paired.deviceId);
              if (pairedWs.readyState === WebSocket.OPEN) {
                const commandId = 'cmd_' + crypto.randomBytes(8).toString('hex');
                prisma.command.create({
                  data: {
                    commandId, deviceId: paired.deviceId,
                    commandType: msg.commandType,
                    params: JSON.stringify(msg.params || {}),
                    status: 'pending', createdAt: Date.now(),
                  },
                }).catch(() => {});
                pairedWs.send(JSON.stringify({
                  type: 'command',
                  commandId,
                  commandType: msg.commandType,
                  params: msg.params,
                }));
                ws.send(JSON.stringify({ type: 'commandSent', commandId }));
              }
            }
          }).catch(() => {});
        }).catch(() => {});
      }

      if (msg.type === 'commandResult' && deviceId) {
        // Forward result to paired device
        prisma.command.update({
          where: { commandId: msg.commandId },
          data: { result: msg.result, status: 'completed', completedAt: Date.now() },
        }).catch(() => {});
        prisma.device.findUnique({ where: { deviceId } }).then((device) => {
          if (!device) return;
          prisma.device.findFirst({
            where: { pairCode: device.pairCode, deviceId: { not: deviceId } },
          }).then((paired) => {
            if (paired && deviceSockets.has(paired.deviceId)) {
              const pairedWs = deviceSockets.get(paired.deviceId);
              if (pairedWs.readyState === WebSocket.OPEN) {
                pairedWs.send(JSON.stringify({
                  type: 'commandResult',
                  commandId: msg.commandId,
                  result: msg.result,
                }));
              }
            }
          }).catch(() => {});
        }).catch(() => {});
      }

      if (msg.type === 'requestLocation' && deviceId) {
        // Ask paired device for its current location
        prisma.device.findUnique({ where: { deviceId } }).then((device) => {
          if (!device) return;
          prisma.device.findFirst({
            where: { pairCode: device.pairCode, deviceId: { not: deviceId } },
          }).then((paired) => {
            if (paired && deviceSockets.has(paired.deviceId)) {
              const pairedWs = deviceSockets.get(paired.deviceId);
              if (pairedWs.readyState === WebSocket.OPEN) {
                pairedWs.send(JSON.stringify({ type: 'locationRequest' }));
              }
            }
          }).catch(() => {});
        }).catch(() => {});
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      console.error('WS message error:', e);
    }
  });

  ws.on('close', () => {
    if (deviceId) {
      deviceSockets.delete(deviceId);
      console.log(`WS disconnected: ${deviceId}`);
    }
  });

  ws.on('error', () => {
    if (deviceId) deviceSockets.delete(deviceId);
  });

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

// Heartbeat to detect dead connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ============= START =============
initDB()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server + WebSocket running on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Failed to initialize database:', e);
    process.exit(1);
  });

module.exports = app;
