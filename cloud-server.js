const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 9999;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ============= STORAGE =============
const devices = new Map();
const pairCodes = new Map();
const pendingCommands = new Map();
const commandResults = new Map();
const phoneLocations = new Map();
const laptopLocations = new Map();

function generateId() {
  return crypto.randomBytes(8).toString('hex');
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

// ============= LAPTOP: Register =============
app.post('/api/register', (req, res) => {
  const { pairKey, systemInfo } = req.body;
  
  const binaryCode = codeToBinary(pairKey);
  const deviceId = generateId();
  
  pairCodes.set(pairKey, { deviceId, binaryCode, createdAt: Date.now() });
  devices.set(deviceId, { pairKey, systemInfo, lastSeen: Date.now() });
  pendingCommands.set(deviceId, []);
  
  console.log(`Registered: ${pairKey} -> ${deviceId}`);
  res.json({ success: true, deviceId });
});

// ============= PHONE: Verify =============
app.post('/api/verify', (req, res) => {
  const { pairKey } = req.body;
  
  const pairInfo = pairCodes.get(pairKey);
  if (!pairInfo) {
    return res.json({ success: false, error: 'Invalid code' });
  }
  
  const enteredBinary = codeToBinary(pairKey);
  if (enteredBinary !== pairInfo.binaryCode) {
    return res.json({ success: false, error: 'Binary mismatch' });
  }
  
  const device = devices.get(pairInfo.deviceId);
  if (device) device.lastSeen = Date.now();
  
  console.log(`Verified: ${pairKey}`);
  res.json({
    success: true,
    deviceId: pairInfo.deviceId,
    deviceInfo: device?.systemInfo || null,
    laptopLocation: laptopLocations.get(pairInfo.deviceId) || null
  });
});

// ============= LAPTOP: Poll commands =============
app.get('/api/poll/:deviceId', (req, res) => {
  const commands = pendingCommands.get(req.params.deviceId) || [];
  pendingCommands.set(req.params.deviceId, []);
  
  const device = devices.get(req.params.deviceId);
  if (device) device.lastSeen = Date.now();
  
  // Also send phone location if available
  const phoneLoc = phoneLocations.get(req.params.deviceId);
  
  res.json({ 
    success: true, 
    commands,
    phoneLocation: phoneLoc || null
  });
});

// ============= LAPTOP: Send result =============
app.post('/api/result', (req, res) => {
  const { commandId, deviceId, result, error } = req.body;
  
  commandResults.set(commandId, { result, error, at: Date.now() });
  res.json({ success: true });
});

// ============= LAPTOP: Send heartbeat =============
app.post('/api/heartbeat', (req, res) => {
  const { deviceId, location, systemInfo } = req.body;
  
  const device = devices.get(deviceId);
  if (device) {
    device.lastSeen = Date.now();
    if (systemInfo) device.systemInfo = systemInfo;
  }
  if (location) laptopLocations.set(deviceId, location);
  
  res.json({ success: true });
});

// ============= PHONE: Send command =============
app.post('/api/command', (req, res) => {
  const { deviceId, commandType, params } = req.body;
  
  const commandId = generateId();
  const command = { commandId, commandType, params: params || {}, at: Date.now() };
  
  if (!pendingCommands.has(deviceId)) pendingCommands.set(deviceId, []);
  pendingCommands.get(deviceId).push(command);
  
  console.log(`Command: ${commandType} for ${deviceId}`);
  res.json({ success: true, commandId });
});

// ============= PHONE: Get result =============
app.get('/api/result/:commandId', (req, res) => {
  const result = commandResults.get(req.params.commandId);
  if (!result) return res.json({ success: true, status: 'pending' });
  res.json({ success: true, status: 'completed', result: result.result, error: result.error });
});

// ============= PHONE: Send location =============
app.post('/api/location/phone', (req, res) => {
  const { deviceId, location } = req.body;
  phoneLocations.set(deviceId, { ...location, at: Date.now() });
  res.json({ success: true });
});

// ============= LAPTOP: Send location =============
app.post('/api/location/laptop', (req, res) => {
  const { deviceId, location } = req.body;
  laptopLocations.set(deviceId, { ...location, at: Date.now() });
  res.json({ success: true });
});

// ============= PHONE: Get device status =============
app.get('/api/status/:deviceId', (req, res) => {
  const device = devices.get(req.params.deviceId);
  if (!device) return res.json({ success: true, isOnline: false });
  
  const isOnline = (Date.now() - device.lastSeen < 15000);
  res.json({
    success: true,
    isOnline,
    lastSeen: device.lastSeen,
    systemInfo: device.systemInfo,
    laptopLocation: laptopLocations.get(req.params.deviceId) || null,
    phoneLocation: phoneLocations.get(req.params.deviceId) || null
  });
});

// ============= CLEANUP =============
setInterval(() => {
  const now = Date.now();
  for (const [key, info] of pairCodes) {
    if (now - info.createdAt > 600000) pairCodes.delete(key);
  }
}, 600000);

// ============= START =============
server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = { app, server };
