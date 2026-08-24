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

// Storage
const devices = new Map();      // deviceId -> { ws, info, lastSeen }
const pairKeys = new Map();     // pairKey -> { deviceId, createdAt }
const commands = new Map();     // commandId -> { deviceId, type, params, result, status }
const phoneConnections = new Map(); // pairKey -> Set<ws>

// Generate unique pair key
function generatePairKey() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Generate device ID
function generateDeviceId() {
  return 'dev_' + crypto.randomBytes(8).toString('hex');
}

// Pairing: Laptop registers with pair key
app.post('/api/pair/register', (req, res) => {
  const { pairKey, deviceInfo } = req.body;
  
  if (!pairKey || pairKey.length !== 8) {
    return res.status(400).json({ success: false, error: 'Invalid pair key' });
  }

  const deviceId = generateDeviceId();
  
  // Store pair key
  pairKeys.set(pairKey, {
    deviceId,
    createdAt: Date.now()
  });

  // Notify any waiting phones
  const phoneClients = phoneConnections.get(pairKey);
  if (phoneClients) {
    phoneClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'device_paired',
          deviceId,
          deviceInfo
        }));
      }
    });
  }

  console.log(`Device paired: ${deviceId} with key: ${pairKey}`);
  
  res.json({ 
    success: true, 
    deviceId,
    message: 'Pairing successful. Laptop agent will now connect.' 
  });
});

// Phone: Verify pair key and connect
app.post('/api/pair/verify', (req, res) => {
  const { pairKey } = req.body;
  
  const pairInfo = pairKeys.get(pairKey);
  
  if (!pairInfo) {
    return res.status(404).json({ 
      success: false, 
      error: 'Invalid pair key. Make sure laptop is running and paired.' 
    });
  }

  const device = devices.get(pairInfo.deviceId);
  
  res.json({
    success: true,
    deviceId: pairInfo.deviceId,
    isOnline: device ? device.ws.readyState === WebSocket.OPEN : false,
    deviceInfo: device ? device.info : null
  });
});

// Laptop agent: Register as online
app.post('/api/agent/register', (req, res) => {
  const { deviceId, pairKey, systemInfo } = req.body;
  
  const pairInfo = pairKeys.get(pairKey);
  
  if (!pairInfo || pairInfo.deviceId !== deviceId) {
    return res.status(401).json({ success: false, error: 'Invalid pairing' });
  }

  // Store device
  const existingDevice = devices.get(deviceId);
  
  res.json({
    success: true,
    message: 'Agent registered',
    heartbeatInterval: 5000
  });
});

// Laptop agent: Poll for commands
app.get('/api/agent/poll/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  
  // Find pending commands for this device
  const pendingCommands = [];
  for (const [cmdId, cmd] of commands) {
    if (cmd.deviceId === deviceId && cmd.status === 'pending') {
      pendingCommands.push({
        commandId: cmdId,
        type: cmd.type,
        params: cmd.params
      });
      cmd.status = 'sent';
    }
  }

  res.json({
    success: true,
    commands: pendingCommands,
    timestamp: Date.now()
  });
});

// Laptop agent: Send command result
app.post('/api/agent/result', (req, res) => {
  const { commandId, deviceId, result, error } = req.body;
  
  const cmd = commands.get(commandId);
  
  if (!cmd) {
    return res.status(404).json({ success: false, error: 'Command not found' });
  }

  cmd.result = result;
  cmd.error = error;
  cmd.status = error ? 'failed' : 'completed';
  cmd.completedAt = Date.now();

  // Notify phone clients
  const pairInfo = Array.from(pairKeys.entries()).find(([k, v]) => v.deviceId === deviceId);
  if (pairInfo) {
    const phoneClients = phoneConnections.get(pairInfo[0]);
    if (phoneClients) {
      phoneClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'command_result',
            commandId,
            commandType: cmd.type,
            result,
            error
          }));
        }
      });
    }
  }

  res.json({ success: true });
});

// Phone: Send command to laptop
app.post('/api/command/send', (req, res) => {
  const { deviceId, type, params } = req.body;
  
  const commandId = 'cmd_' + crypto.randomBytes(8).toString('hex');
  
  commands.set(commandId, {
    deviceId,
    type,
    params: params || {},
    status: 'pending',
    createdAt: Date.now()
  });

  // Try to notify agent via WebSocket
  const device = devices.get(deviceId);
  if (device && device.ws.readyState === WebSocket.OPEN) {
    device.ws.send(JSON.stringify({
      type: 'new_command',
      commandId,
      commandType: type,
      params
    }));
  }

  console.log(`Command queued: ${type} for ${deviceId}`);
  
  res.json({
    success: true,
    commandId,
    message: 'Command sent. Waiting for laptop to execute.'
  });
});

// Get device status
app.get('/api/device/status/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const device = devices.get(deviceId);
  
  if (!device) {
    return res.json({
      success: true,
      isOnline: false,
      lastSeen: null
    });
  }

  res.json({
    success: true,
    isOnline: device.ws.readyState === WebSocket.OPEN,
    lastSeen: device.lastSeen,
    info: device.info,
    location: device.location
  });
});

// Get command status
app.get('/api/command/status/:commandId', (req, res) => {
  const { commandId } = req.params;
  const cmd = commands.get(commandId);
  
  if (!cmd) {
    return res.status(404).json({ success: false, error: 'Command not found' });
  }

  res.json({
    success: true,
    status: cmd.status,
    result: cmd.result,
    error: cmd.error
  });
});

// WebSocket connections
wss.on('connection', (ws) => {
  console.log('WebSocket connected');
  
  let connectionType = null;
  let deviceId = null;
  let pairKey = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'agent_connect':
          // Laptop agent connecting
          connectionType = 'agent';
          deviceId = msg.deviceId;
          pairKey = msg.pairKey;
          
          // Store device
          devices.set(deviceId, {
            ws,
            info: msg.systemInfo,
            lastSeen: Date.now(),
            location: null
          });
          
          ws.send(JSON.stringify({ type: 'connected', message: 'Agent connected' }));
          console.log(`Agent connected: ${deviceId}`);
          break;

        case 'agent_heartbeat':
          // Agent heartbeat with location
          if (deviceId && devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.lastSeen = Date.now();
            if (msg.location) {
              device.location = msg.location;
            }
            
            // Notify phones of location update
            const pairInfo = Array.from(pairKeys.entries()).find(([k, v]) => v.deviceId === deviceId);
            if (pairInfo) {
              const phoneClients = phoneConnections.get(pairInfo[0]);
              if (phoneClients) {
                phoneClients.forEach(client => {
                  if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                      type: 'location_update',
                      deviceId,
                      location: msg.location,
                      systemInfo: msg.systemInfo,
                      timestamp: Date.now()
                    }));
                  }
                });
              }
            }
          }
          break;

        case 'phone_connect':
          // Phone connecting with pair key
          connectionType = 'phone';
          pairKey = msg.pairKey;
          
          // Add to phone connections
          if (!phoneConnections.has(pairKey)) {
            phoneConnections.set(pairKey, new Set());
          }
          phoneConnections.get(pairKey).add(ws);
          
          // Check if device exists
          const pairInfo = pairKeys.get(pairKey);
          let isOnline = false;
          let deviceInfo = null;
          let deviceLocation = null;
          
          if (pairInfo) {
            const device = devices.get(pairInfo.deviceId);
            if (device) {
              isOnline = device.ws.readyState === WebSocket.OPEN;
              deviceInfo = device.info;
              deviceLocation = device.location;
              deviceId = pairInfo.deviceId;
            }
          }
          
          ws.send(JSON.stringify({
            type: 'connected',
            isOnline,
            deviceId,
            deviceInfo,
            deviceLocation
          }));
          
          console.log(`Phone connected with key: ${pairKey}`);
          break;

        case 'request_location':
          // Phone requests location
          if (deviceId && devices.has(deviceId)) {
            const device = devices.get(deviceId);
            if (device.ws.readyState === WebSocket.OPEN) {
              device.ws.send(JSON.stringify({ type: 'get_location' }));
            }
          }
          break;

        case 'location_update':
          // Agent sending location update
          if (deviceId && devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.location = msg.location;
            
            // Forward to phones
            const pairInf = Array.from(pairKeys.entries()).find(([k, v]) => v.deviceId === deviceId);
            if (pairInf) {
              const phoneClients = phoneConnections.get(pairInf[0]);
              if (phoneClients) {
                phoneClients.forEach(client => {
                  if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                      type: 'location_update',
                      deviceId,
                      location: msg.location,
                      timestamp: Date.now()
                    }));
                  }
                });
              }
            }
          }
          break;
      }
    } catch (e) {
      console.error('Message parse error:', e);
    }
  });

  ws.on('close', () => {
    if (connectionType === 'agent' && deviceId) {
      devices.delete(deviceId);
      console.log(`Agent disconnected: ${deviceId}`);
    }
    if (connectionType === 'phone' && pairKey) {
      const clients = phoneConnections.get(pairKey);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) {
          phoneConnections.delete(pairKey);
        }
      }
      console.log(`Phone disconnected`);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// Cleanup old commands every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [cmdId, cmd] of commands) {
    if (now - cmd.createdAt > 300000) { // 5 minutes
      commands.delete(cmdId);
    }
  }
}, 300000);

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('   LAPTOP TRACKER - CLOUD SERVER');
  console.log('========================================');
  console.log(`\n  Server running on port ${PORT}`);
  console.log(`  Open this URL on your phone!`);
  console.log('========================================\n');
});

module.exports = { app, server };
