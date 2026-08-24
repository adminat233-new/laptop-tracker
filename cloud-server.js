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
const devices = new Map();      // deviceId -> device info
const pairCodes = new Map();    // pairKey -> pairing info
const pendingCommands = new Map(); // deviceId -> [commands]
const commandResults = new Map();  // commandId -> result

function generateDeviceId() {
  return 'dev_' + crypto.randomBytes(8).toString('hex');
}

// ============= REST API FOR LAPTOP AGENT =============

// Laptop: Register with pair code
app.post('/api/agent/register', (req, res) => {
  const { pairKey, systemInfo } = req.body;
  
  const pairInfo = pairCodes.get(pairKey);
  if (!pairInfo) {
    return res.status(401).json({ success: false, error: 'Invalid code' });
  }

  const deviceId = pairInfo.deviceId;
  
  // Store device
  devices.set(deviceId, {
    pairKey,
    systemInfo,
    lastSeen: Date.now(),
    laptopLocation: null,
    phoneLocation: null,
    ws: null
  });

  // Initialize pending commands queue
  if (!pendingCommands.has(deviceId)) {
    pendingCommands.set(deviceId, []);
  }

  console.log(`Agent registered: ${deviceId}`);
  
  res.json({ 
    success: true, 
    deviceId,
    message: 'Registered. Polling for commands...'
  });
});

// Laptop: Poll for pending commands
app.get('/api/agent/poll/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  
  const commands = pendingCommands.get(deviceId) || [];
  
  // Return and clear pending commands
  pendingCommands.set(deviceId, []);
  
  // Update last seen
  const device = devices.get(deviceId);
  if (device) {
    device.lastSeen = Date.now();
  }

  res.json({
    success: true,
    commands: commands,
    timestamp: Date.now()
  });
});

// Laptop: Send command result
app.post('/api/agent/result', (req, res) => {
  const { commandId, deviceId, result, error } = req.body;
  
  // Store result
  commandResults.set(commandId, {
    deviceId,
    result,
    error,
    completedAt: Date.now()
  });

  // Find device and forward to phone via WebSocket
  const device = devices.get(deviceId);
  if (device && device.ws && device.ws.readyState === WebSocket.OPEN) {
    device.ws.send(JSON.stringify({
      type: 'command_result',
      commandId,
      commandType: commandResults.get(commandId)?.type,
      result,
      error
    }));
  }

  console.log(`Result received for ${commandId}`);
  
  res.json({ success: true });
});

// Laptop: Send location update
app.post('/api/agent/location', (req, res) => {
  const { deviceId, location } = req.body;
  
  const device = devices.get(deviceId);
  if (device) {
    device.laptopLocation = location;
    device.lastSeen = Date.now();
    
    // Forward to phone
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

// Laptop: Send heartbeat
app.post('/api/agent/heartbeat', (req, res) => {
  const { deviceId, location, systemInfo } = req.body;
  
  const device = devices.get(deviceId);
  if (device) {
    device.lastSeen = Date.now();
    if (location) device.laptopLocation = location;
    if (systemInfo) device.systemInfo = systemInfo;
    
    // Forward to phone
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

// ============= REST API FOR PHONE =============

// Phone: Verify pair code
app.post('/api/phone/verify', (req, res) => {
  const { pairKey } = req.body;
  
  const pairInfo = pairCodes.get(pairKey);
  if (!pairInfo) {
    return res.status(404).json({ 
      success: false, 
      error: 'Invalid code. Make sure laptop generated this code.' 
    });
  }

  const device = devices.get(pairInfo.deviceId);
  
  res.json({
    success: true,
    deviceId: pairInfo.deviceId,
    isOnline: device ? (Date.now() - device.lastSeen < 15000) : false,
    deviceInfo: device?.systemInfo || null,
    laptopLocation: device?.laptopLocation || null
  });
});

// Phone: Send command to laptop (stored in cloud)
app.post('/api/phone/command', (req, res) => {
  const { deviceId, commandType, params } = req.body;
  
  const commandId = 'cmd_' + crypto.randomBytes(8).toString('hex');
  
  const command = {
    commandId,
    commandType,
    params: params || {},
    createdAt: Date.now()
  };

  // Store in pending queue
  if (!pendingCommands.has(deviceId)) {
    pendingCommands.set(deviceId, []);
  }
  pendingCommands.get(deviceId).push(command);

  // Also try to notify via WebSocket if connected
  const device = devices.get(deviceId);
  if (device) {
    // Store type for result forwarding
    command.type = commandType;
    
    if (device.ws && device.ws.readyState === WebSocket.OPEN) {
      device.ws.send(JSON.stringify({
        type: 'new_command',
        commandId,
        commandType,
        params
      }));
    }
  }

  console.log(`Command queued: ${commandType} for ${deviceId}`);
  
  res.json({
    success: true,
    commandId,
    message: 'Command stored in cloud. Laptop will execute on next poll.'
  });
});

// Phone: Get command result
app.get('/api/phone/result/:commandId', (req, res) => {
  const { commandId } = req.params;
  
  const result = commandResults.get(commandId);
  if (!result) {
    return res.json({ 
      success: true, 
      status: 'pending',
      message: 'Waiting for laptop to execute...' 
    });
  }

  res.json({
    success: true,
    status: 'completed',
    result: result.result,
    error: result.error
  });
});

// Phone: Get device status
app.get('/api/phone/status/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const device = devices.get(deviceId);
  
  if (!device) {
    return res.json({ success: true, isOnline: false });
  }

  res.json({
    success: true,
    isOnline: (Date.now() - device.lastSeen < 15000),
    lastSeen: device.lastSeen,
    laptopLocation: device.laptopLocation,
    systemInfo: device.systemInfo
  });
});

// ============= WEBSOCKET =============
wss.on('connection', (ws) => {
  let connectionType = null;
  let deviceId = null;
  let pairKey = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'laptop_register':
          connectionType = 'laptop';
          pairKey = msg.pairKey;
          deviceId = generateDeviceId();
          
          pairCodes.set(pairKey, {
            deviceId,
            createdAt: Date.now()
          });

          // Store device
          devices.set(deviceId, {
            pairKey,
            systemInfo: msg.deviceInfo,
            lastSeen: Date.now(),
            laptopLocation: null,
            phoneLocation: null,
            ws
          });

          if (!pendingCommands.has(deviceId)) {
            pendingCommands.set(deviceId, []);
          }
          
          ws.send(JSON.stringify({ 
            type: 'registered', 
            pairKey,
            deviceId,
            message: 'Waiting for phone...'
          }));
          break;

        case 'phone_verify':
          connectionType = 'phone';
          pairKey = msg.pairKey;
          
          const pairInfo = pairCodes.get(pairKey);
          if (!pairInfo) {
            ws.send(JSON.stringify({
              type: 'verification_failed',
              error: 'Invalid code'
            }));
            return;
          }

          deviceId = pairInfo.deviceId;
          
          // Link WebSocket to device
          const device = devices.get(deviceId);
          if (device) {
            device.ws = ws;
            device.phoneWs = ws;
          }
          
          // Notify laptop
          if (device && device.ws && device.ws.readyState === WebSocket.OPEN) {
            device.ws.send(JSON.stringify({
              type: 'phone_connected',
              deviceId
            }));
          }
          
          // Send success to phone
          ws.send(JSON.stringify({
            type: 'verification_success',
            deviceId,
            deviceInfo: device?.systemInfo,
            laptopLocation: device?.laptopLocation
          }));
          break;

        case 'phone_location':
          if (deviceId && devices.has(deviceId)) {
            const dev = devices.get(deviceId);
            dev.phoneLocation = msg.location;
            
            // Forward to laptop
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
            
            // Forward to phone
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
            
            const command = {
              commandId,
              commandType: msg.commandType,
              params: msg.params || {},
              createdAt: Date.now()
            };
            
            // Store in pending queue
            if (!pendingCommands.has(deviceId)) {
              pendingCommands.set(deviceId, []);
            }
            pendingCommands.get(deviceId).push(command);
            
            // Try to notify laptop via WebSocket
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
          const cmd = commandResults.get(msg.commandId);
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

// Cleanup old data every 10 minutes
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
  console.log(`\n  Running on port ${PORT}`);
  console.log('  Commands stored in cloud until executed');
  console.log('========================================\n');
});

module.exports = { app, server };
