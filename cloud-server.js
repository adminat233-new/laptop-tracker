const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 9999;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ============= DATABASE =============
const db = new Database('./tracker.db');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pair_code TEXT UNIQUE NOT NULL,
    binary_code TEXT NOT NULL,
    device_id TEXT,
    device_info TEXT,
    is_paired INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    paired_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT UNIQUE NOT NULL,
    pair_code TEXT NOT NULL,
    device_type TEXT,
    system_info TEXT,
    last_seen INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    lat REAL,
    lng REAL,
    int_lat INTEGER,
    int_lng INTEGER,
    city TEXT,
    region TEXT,
    country TEXT,
    ip TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command_id TEXT UNIQUE NOT NULL,
    device_id TEXT NOT NULL,
    command_type TEXT NOT NULL,
    params TEXT,
    result TEXT,
    error TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
`);

// Prepared statements
const insertCode = db.prepare('INSERT INTO codes (pair_code, binary_code, device_id, created_at) VALUES (?, ?, ?, ?)');
const findCode = db.prepare('SELECT * FROM codes WHERE pair_code = ?');
const markPaired = db.prepare('UPDATE codes SET is_paired = 1, paired_at = ? WHERE pair_code = ?');
const insertDevice = db.prepare('INSERT OR REPLACE INTO devices (device_id, pair_code, device_type, system_info, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const findDevice = db.prepare('SELECT * FROM devices WHERE device_id = ?');
const findDeviceByCode = db.prepare('SELECT * FROM devices WHERE pair_code = ?');
const updateLastSeen = db.prepare('UPDATE devices SET last_seen = ? WHERE device_id = ?');
const upsertLocation = db.prepare('INSERT OR REPLACE INTO locations (device_id, lat, lng, int_lat, int_lng, city, region, country, ip, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const getLocation = db.prepare('SELECT * FROM locations WHERE device_id = ?');
const insertCommand = db.prepare('INSERT INTO commands (command_id, device_id, command_type, params, status, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const findCommand = db.prepare('SELECT * FROM commands WHERE command_id = ?');
const updateCommandResult = db.prepare('UPDATE commands SET result = ?, error = ?, status = ?, completed_at = ? WHERE command_id = ?');
const getPendingCommands = db.prepare("SELECT * FROM commands WHERE device_id = ? AND status = 'pending'");
const cleanupOldCodes = db.prepare('DELETE FROM codes WHERE created_at < ?');
const cleanupOldCommands = db.prepare('DELETE FROM commands WHERE created_at < ?');

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
app.post('/api/generate', (req, res) => {
  const { systemInfo } = req.body;
  
  // Generate unique 8-char code
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let pairCode = '';
  for (let i = 0; i < 8; i++) pairCode += chars.charAt(Math.floor(Math.random() * chars.length));
  
  const binaryCode = codeToBinary(pairCode);
  const deviceId = 'dev_' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  
  try {
    insertCode.run(pairCode, binaryCode, deviceId, now);
    insertDevice.run(deviceId, pairCode, 'laptop', JSON.stringify(systemInfo), now, now);
    
    console.log(`Generated: ${pairCode} -> ${deviceId}`);
    
    res.json({ 
      success: true, 
      pairCode,
      binaryCode,
      deviceId 
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============= PHONE: Verify Code =============
app.post('/api/verify', (req, res) => {
  const { pairCode } = req.body;
  
  const codeRecord = findCode.get(pairCode);
  
  if (!codeRecord) {
    return res.json({ 
      success: false, 
      error: 'Code not found. Generate a code on laptop first.' 
    });
  }
  
  // Binary verification
  const enteredBinary = codeToBinary(pairCode);
  if (enteredBinary !== codeRecord.binary_code) {
    return res.json({ 
      success: false, 
      error: 'Binary verification failed' 
    });
  }
  
  // Mark as paired
  markPaired.run(Date.now(), pairCode);
  
  // Get device info
  const device = findDevice.get(codeRecord.device_id);
  const location = getLocation.get(codeRecord.device_id);
  
  // Create phone device
  const phoneDeviceId = 'dev_' + crypto.randomBytes(8).toString('hex');
  insertDevice.run(phoneDeviceId, pairCode, 'phone', '{}', Date.now(), Date.now());
  
  console.log(`Verified & Paired: ${pairCode}`);
  
  res.json({
    success: true,
    verified: true,
    laptopDeviceId: codeRecord.device_id,
    phoneDeviceId,
    deviceInfo: device ? JSON.parse(device.system_info || '{}') : null,
    laptopLocation: location || null
  });
});

// ============= LAPTOP: Poll Commands =============
app.get('/api/poll/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  
  updateLastSeen.run(Date.now(), deviceId);
  
  const commands = getPendingCommands.all(deviceId);
  
  // Mark as sent
  for (const cmd of commands) {
    updateCommandResult.run(null, null, 'sent', null, cmd.command_id);
  }
  
  res.json({ 
    success: true, 
    commands: commands.map(c => ({
      commandId: c.command_id,
      commandType: c.command_type,
      params: JSON.parse(c.params || '{}')
    }))
  });
});

// ============= LAPTOP: Send Result =============
app.post('/api/result', (req, res) => {
  const { commandId, result, error } = req.body;
  
  updateCommandResult.run(
    result || null,
    error || null,
    error ? 'failed' : 'completed',
    Date.now(),
    commandId
  );
  
  res.json({ success: true });
});

// ============= LAPTOP: Send Heartbeat =============
app.post('/api/heartbeat', (req, res) => {
  const { deviceId, location, systemInfo } = req.body;
  
  updateLastSeen.run(Date.now(), deviceId);
  
  if (location) {
    upsertLocation.run(
      deviceId,
      location.lat, location.lng,
      location.intLat || Math.round(location.lat * 1000000),
      location.intLng || Math.round(location.lng * 1000000),
      location.city, location.region, location.country, location.ip,
      Date.now()
    );
  }
  
  res.json({ success: true });
});

// ============= PHONE: Send Command =============
app.post('/api/command', (req, res) => {
  const { deviceId, commandType, params } = req.body;
  
  const commandId = 'cmd_' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  
  insertCommand.run(commandId, deviceId, commandType, JSON.stringify(params || {}), 'pending', now);
  
  console.log(`Command: ${commandType} for ${deviceId}`);
  res.json({ success: true, commandId });
});

// ============= PHONE: Get Result =============
app.get('/api/result/:commandId', (req, res) => {
  const cmd = findCommand.get(req.params.commandId);
  
  if (!cmd) {
    return res.json({ success: true, status: 'pending' });
  }
  
  res.json({
    success: true,
    status: cmd.status,
    result: cmd.result,
    error: cmd.error
  });
});

// ============= PHONE: Send Location =============
app.post('/api/location/phone', (req, res) => {
  const { deviceId, location } = req.body;
  
  upsertLocation.run(
    deviceId,
    location.lat, location.lng,
    location.intLat || Math.round(location.lat * 1000000),
    location.intLng || Math.round(location.lng * 1000000),
    null, null, null, null,
    Date.now()
  );
  
  res.json({ success: true });
});

// ============= PHONE: Get Status =============
app.get('/api/status/:deviceId', (req, res) => {
  const device = findDevice.get(req.params.deviceId);
  if (!device) return res.json({ success: true, isOnline: false });
  
  const isOnline = (Date.now() - device.last_seen < 15000);
  const location = getLocation.get(req.params.deviceId);
  
  // Find paired device
  const pairCode = device.pair_code;
  const pairedDevice = db.prepare("SELECT * FROM devices WHERE pair_code = ? AND device_id != ?").get(pairCode, req.params.deviceId);
  let pairedLocation = null;
  if (pairedDevice) {
    pairedLocation = getLocation.get(pairedDevice.device_id);
  }
  
  res.json({
    success: true,
    isOnline,
    lastSeen: device.last_seen,
    systemInfo: JSON.parse(device.system_info || '{}'),
    myLocation: location,
    pairedLocation
  });
});

// ============= CLEANUP =============
setInterval(() => {
  const hourAgo = Date.now() - 3600000;
  cleanupOldCodes.run(hourAgo);
  cleanupOldCommands.run(hourAgo * 6);
}, 600000);

// ============= START =============
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Database: tracker.db');
});

module.exports = app;
