const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 9999;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ============= STORAGE =============
const devices = new Map();
const pairCodes = new Map();
const pendingCommands = new Map();
const commandResults = new Map();

function generateDeviceId() {
  return 'dev_' + crypto.randomBytes(8).toString('hex');
}

// ============= BINARY VERIFICATION ALGORITHM =============
function charToBinary(char) {
  return char.charCodeAt(0).toString(2).padStart(8, '0');
}

function codeToBinary(code) {
  return code.split('').map(charToBinary).join('');
}

function verifyCode(enteredCode, storedBinary) {
  const enteredBinary = codeToBinary(enteredCode);
  return enteredBinary === storedBinary;
}

// ============= REST API =============

// Laptop: Register with pair code
app.post('/api/agent/register', (req, res) => {
  const { pairKey, systemInfo } = req.body;
  
  // Convert code to binary and store
  const binaryCode = codeToBinary(pairKey);
  const deviceId = generateDeviceId();
  
  pairCodes.set(pairKey, {
    deviceId,
    binaryCode,
    createdAt: Date.now()
  });

  devices.set(deviceId, {
    pairKey,
    systemInfo,
    lastSeen: Date.now(),
    laptopLocation: null,
    phoneLocation: null,
    ws: null
  });

  pendingCommands.set(deviceId, []);

  console.log(`Agent registered: ${deviceId}`);
  console.log(`  Code: ${pairKey}`);
  console.log(`  Binary: ${binaryCode}`);
  
  res.json({ success: true, deviceId });
});

// Phone: Verify code using binary comparison
app.post('/api/phone/verify', (req, res) => {
  const { pairKey } = req.body;
  
  // Find matching pair code
  let matchedPair = null;
  for (const [key, info] of pairCodes) {
    if (key === pairKey) {
      matchedPair = { key, ...info };
      break;
    }
  }

  if (!matchedPair) {
    return res.status(404).json({ 
      success: false, 
      error: 'Invalid code' 
    });
  }

  // Binary verification
  const enteredBinary = codeToBinary(pairKey);
  const isMatch = enteredBinary === matchedPair.binaryCode;

  if (!isMatch) {
    return res.status(401).json({
      success: false,
      error: 'Binary verification failed'
    });
  }

  const device = devices.get(matchedPair.deviceId);
  
  // Update device
  if (device) {
    device.lastSeen = Date.now();
  }

  console.log(`✓ Verification passed for ${pairKey}`);
  console.log(`  Stored:  ${matchedPair.binaryCode}`);
  console.log(`  Entered: ${enteredBinary}`);
  
  res.json({
    success: true,
    deviceId: matchedPair.deviceId,
    verified: true,
    isOnline: device ? (Date.now() - device.lastSeen < 15000) : false,
    deviceInfo: device?.systemInfo || null,
    laptopLocation: device?.laptopLocation || null
  });
});

// Laptop: Poll for commands
app.get('/api/agent/poll/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const commands = pendingCommands.get(deviceId) || [];
  pendingCommands.set(deviceId, []);
  
  const device = devices.get(deviceId);
  if (device) device.lastSeen = Date.now();

  res.json({ success: true, commands, timestamp: Date.now() });
});

// Laptop: Send command result
app.post('/api/agent/result', (req, res) => {
  const { commandId, deviceId, result, error } = req.body;
  
  commandResults.set(commandId, { deviceId, result, error, completedAt: Date.now() });

  const device = devices.get(deviceId);
  if (device && device.ws && device.ws.readyState === WebSocket.OPEN) {
    device.ws.send(JSON.stringify({
      type: 'command_result',
      commandId,
      result,
      error
    }));
  }

  res.json({ success: true });
});

// Laptop: Send heartbeat with location
app.post('/api/agent/heartbeat', (req, res) => {
  const { deviceId, location, systemInfo } = req.body;
  
  const device = devices.get(deviceId);
  if (device) {
    device.lastSeen = Date.now();
    if (location) device.laptopLocation = location;
    if (systemInfo) device.systemInfo = systemInfo;
    
    if (device.ws && device.ws.readyState === WebSocket.OPEN) {
      device.ws.send(JSON.stringify({
        type: 'laptop_heartbeat',
        location,
        systemInfo,
        timestamp: Date.now()
      }));
    }
  }

  res.json({ success: true });
});

// Phone: Send command
app.post('/api/phone/command', (req, res) => {
  const { deviceId, commandType, params } = req.body;
  
  const commandId = 'cmd_' + crypto.randomBytes(8).toString('hex');
  
  if (!pendingCommands.has(deviceId)) {
    pendingCommands.set(deviceId, []);
  }
  pendingCommands.get(deviceId).push({
    commandId,
    commandType,
    params: params || {},
    createdAt: Date.now()
  });

  const device = devices.get(deviceId);
  if (device && device.ws && device.ws.readyState === WebSocket.OPEN) {
    device.ws.send(JSON.stringify({
      type: 'new_command',
      commandId,
      commandType,
      params
    }));
  }

  console.log(`Command queued: ${commandType}`);
  res.json({ success: true, commandId });
});

// Phone: Get command result
app.get('/api/phone/result/:commandId', (req, res) => {
  const result = commandResults.get(req.params.commandId);
  if (!result) {
    return res.json({ success: true, status: 'pending' });
  }
  res.json({ success: true, status: 'completed', result: result.result, error: result.error });
});

// Phone: Send location
app.post('/api/phone/location', (req, res) => {
  const { deviceId, location } = req.body;
  
  const device = devices.get(deviceId);
  if (device) {
    device.phoneLocation = location;
    
    if (device.ws && device.ws.readyState === WebSocket.OPEN) {
      device.ws.send(JSON.stringify({
        type: 'phone_location_update',
        location
      }));
    }
  }

  res.json({ success: true });
});

// Laptop: Send location
app.post('/api/agent/location', (req, res) => {
  const { deviceId, location } = req.body;
  
  const device = devices.get(deviceId);
  if (device) {
    device.laptopLocation = location;
    device.lastSeen = Date.now();
    
    if (device.ws && device.ws.readyState === WebSocket.OPEN) {
      device.ws.send(JSON.stringify({
        type: 'laptop_location_update',
        location,
        timestamp: Date.now()
      }));
    }
  }

  res.json({ success: true });
});

// ============= WEBSOCKET =============
wss.on('connection', (ws) => {
  let connectionType = null;
  let deviceId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'laptop_register':
          connectionType = 'laptop';
          deviceId = msg.deviceId;
          
          const device = devices.get(deviceId);
          if (device) {
            device.ws = ws;
            device.lastSeen = Date.now();
          }
          break;

        case 'phone_verify':
          connectionType = 'phone';
          
          // Find device by pair key
          const pairInfo = pairCodes.get(msg.pairKey);
          if (pairInfo) {
            deviceId = pairInfo.deviceId;
            const dev = devices.get(deviceId);
            if (dev) {
              dev.ws = ws;
              dev.phoneWs = ws;
              
              // Notify laptop
              if (dev.ws && dev.ws.readyState === WebSocket.OPEN) {
                dev.ws.send(JSON.stringify({
                  type: 'phone_connected',
                  deviceId
                }));
              }
              
              // Send to phone
              ws.send(JSON.stringify({
                type: 'verification_success',
                deviceId,
                deviceInfo: dev.systemInfo,
                laptopLocation: dev.laptopLocation
              }));
            }
          }
          break;

        case 'phone_location':
          if (deviceId && devices.has(deviceId)) {
            const dev = devices.get(deviceId);
            dev.phoneLocation = msg.location;
            
            if (dev.ws && dev.ws.readyState === WebSocket.OPEN && connectionType === 'phone') {
              dev.ws.send(JSON.stringify({
                type: 'phone_location_update',
                location: msg.location
              }));
            }
          }
          break;

        case 'laptop_location':
          if (deviceId && devices.has(deviceId)) {
            const dev = devices.get(deviceId);
            dev.laptopLocation = msg.location;
            dev.lastSeen = Date.now();
            
            if (dev.phoneWs && dev.phoneWs.readyState === WebSocket.OPEN) {
              dev.phoneWs.send(JSON.stringify({
                type: 'laptop_location_update',
                location: msg.location,
                timestamp: Date.now()
              }));
            }
          }
          break;

        case 'laptop_heartbeat':
          if (deviceId && devices.has(deviceId)) {
            const dev = devices.get(deviceId);
            dev.lastSeen = Date.now();
            if (msg.location) dev.laptopLocation = msg.location;
            if (msg.systemInfo) dev.systemInfo = msg.systemInfo;
            
            if (dev.phoneWs && dev.phoneWs.readyState === WebSocket.OPEN) {
              dev.phoneWs.send(JSON.stringify({
                type: 'laptop_heartbeat',
                location: msg.location,
                systemInfo: msg.systemInfo,
                timestamp: Date.now()
              }));
            }
          }
          break;

        case 'phone_command':
          if (deviceId && devices.has(deviceId)) {
            const dev = devices.get(deviceId);
            const commandId = 'cmd_' + crypto.randomBytes(8).toString('hex');
            
            if (!pendingCommands.has(deviceId)) {
              pendingCommands.set(deviceId, []);
            }
            pendingCommands.get(deviceId).push({
              commandId,
              commandType: msg.commandType,
              params: msg.params || {},
              createdAt: Date.now()
            });
            
            if (dev.ws && dev.ws.readyState === WebSocket.OPEN) {
              dev.ws.send(JSON.stringify({
                type: 'new_command',
                commandId,
                commandType: msg.commandType,
                params: msg.params
              }));
            }
            
            ws.send(JSON.stringify({
              type: 'command_sent',
              commandId,
              commandType: msg.commandType
            }));
          }
          break;

        case 'laptop_result':
          if (!commandResults.has(msg.commandId)) {
            commandResults.set(msg.commandId, {
              deviceId,
              result: msg.result,
              error: msg.error,
              completedAt: Date.now()
            });
          }
          
          if (deviceId && devices.has(deviceId)) {
            const dev = devices.get(deviceId);
            if (dev.phoneWs && dev.phoneWs.readyState === WebSocket.OPEN) {
              dev.phoneWs.send(JSON.stringify({
                type: 'command_result',
                commandId: msg.commandId,
                result: msg.result,
                error: msg.error
              }));
            }
          }
          break;

        case 'request_location':
          if (deviceId && devices.has(deviceId)) {
            const dev = devices.get(deviceId);
            if (dev.ws && dev.ws.readyState === WebSocket.OPEN) {
              dev.ws.send(JSON.stringify({ type: 'get_location' }));
            }
          }
          break;
      }
    } catch (e) {
      console.error('Message error:', e.message);
    }
  });

  ws.on('close', () => {
    if (connectionType === 'laptop' && deviceId) {
      const device = devices.get(deviceId);
      if (device) {
        device.ws = null;
        if (device.phoneWs && device.phoneWs.readyState === WebSocket.OPEN) {
          device.phoneWs.send(JSON.stringify({ type: 'laptop_offline' }));
        }
      }
    }
  });
});

// Cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, info] of pairCodes) {
    if (now - info.createdAt > 600000) pairCodes.delete(key);
  }
  for (const [cmdId, result] of commandResults) {
    if (now - result.completedAt > 300000) commandResults.delete(cmdId);
  }
}, 600000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('   LAPTOP TRACKER - CLOUD SERVER');
  console.log('========================================');
  console.log(`\n  Port: ${PORT}`);
  console.log('  Verification: Binary Algorithm');
  console.log('========================================\n');
});

module.exports = { app, server };
