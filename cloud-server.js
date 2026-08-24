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
const devices = new Map();      // deviceId -> { ws, info, lastSeen, location }
const pairCodes = new Map();    // pairKey -> { deviceId, ws, createdAt, verified }
const commands = new Map();     // commandId -> { deviceId, type, params, result, status }

// Generate device ID
function generateDeviceId() {
  return 'dev_' + crypto.randomBytes(8).toString('hex');
}

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
        // ============= LAPTOP REGISTERS WITH CODE =============
        case 'laptop_register':
          connectionType = 'laptop';
          pairKey = msg.pairKey;
          deviceId = generateDeviceId();
          
          // Store pair code
          pairCodes.set(pairKey, {
            deviceId,
            ws,
            createdAt: Date.now(),
            verified: false,
            deviceInfo: msg.deviceInfo || null
          });
          
          ws.send(JSON.stringify({ 
            type: 'registered', 
            pairKey,
            deviceId 
          }));
          
          console.log(`Laptop registered with code: ${pairKey} -> ${deviceId}`);
          break;

        // ============= PHONE VERIFIES CODE =============
        case 'phone_verify':
          connectionType = 'phone';
          pairKey = msg.pairKey;
          
          const pairInfo = pairCodes.get(pairKey);
          
          if (!pairInfo) {
            ws.send(JSON.stringify({
              type: 'pair_failed',
              error: 'Invalid code. Make sure laptop is running and code is correct.'
            }));
            return;
          }
          
          // Mark as verified
          pairInfo.verified = true;
          pairInfo.phoneWs = ws;
          deviceId = pairInfo.deviceId;
          
          // Store device
          devices.set(deviceId, {
            ws: pairInfo.ws,
            phoneWs: ws,
            info: pairInfo.deviceInfo,
            lastSeen: Date.now(),
            location: null
          });
          
          // Notify laptop that phone connected
          if (pairInfo.ws.readyState === WebSocket.OPEN) {
            pairInfo.ws.send(JSON.stringify({
              type: 'pair_success',
              deviceId
            }));
          }
          
          // Send success to phone
          ws.send(JSON.stringify({
            type: 'verified',
            deviceId,
            deviceInfo: pairInfo.deviceInfo,
            deviceLocation: null
          }));
          
          console.log(`Phone verified code: ${pairKey} -> ${deviceId}`);
          break;

        // ============= LAPTOP SENDS HEARTBEAT =============
        case 'laptop_heartbeat':
          if (deviceId && devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.lastSeen = Date.now();
            
            if (msg.location) {
              device.location = msg.location;
            }
            
            if (msg.systemInfo) {
              device.info = msg.systemInfo;
            }
            
            // Forward to phone
            if (device.phoneWs && device.phoneWs.readyState === WebSocket.OPEN) {
              device.phoneWs.send(JSON.stringify({
                type: 'location_update',
                deviceId,
                location: msg.location,
                systemInfo: msg.systemInfo,
                timestamp: Date.now()
              }));
            }
          }
          break;

        // ============= LAPTOP SENDS LOCATION =============
        case 'laptop_location':
          if (deviceId && devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.location = msg.location;
            
            if (device.phoneWs && device.phoneWs.readyState === WebSocket.OPEN) {
              device.phoneWs.send(JSON.stringify({
                type: 'location_update',
                deviceId,
                location: msg.location,
                timestamp: Date.now()
              }));
            }
          }
          break;

        // ============= PHONE SENDS COMMAND =============
        case 'phone_command':
          if (deviceId && devices.has(deviceId)) {
            const device = devices.get(deviceId);
            const commandId = 'cmd_' + crypto.randomBytes(8).toString('hex');
            
            commands.set(commandId, {
              deviceId,
              type: msg.commandType,
              params: msg.params || {},
              status: 'pending',
              createdAt: Date.now()
            });
            
            // Send to laptop
            if (device.ws && device.ws.readyState === WebSocket.OPEN) {
              device.ws.send(JSON.stringify({
                type: 'execute_command',
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
            
            console.log(`Command sent: ${msg.commandType} to ${deviceId}`);
          }
          break;

        // ============= LAPTOP SENDS RESULT =============
        case 'laptop_result':
          const cmd = commands.get(msg.commandId);
          if (cmd) {
            cmd.result = msg.result;
            cmd.error = msg.error;
            cmd.status = msg.error ? 'failed' : 'completed';
            cmd.completedAt = Date.now();
            
            // Forward to phone
            const device = devices.get(cmd.deviceId);
            if (device && device.phoneWs && device.phoneWs.readyState === WebSocket.OPEN) {
              device.phoneWs.send(JSON.stringify({
                type: 'command_result',
                commandId: msg.commandId,
                commandType: cmd.type,
                result: msg.result,
                error: msg.error
              }));
            }
          }
          break;

        // ============= PHONE REQUESTS LOCATION =============
        case 'request_location':
          if (deviceId && devices.has(deviceId)) {
            const device = devices.get(deviceId);
            if (device.ws && device.ws.readyState === WebSocket.OPEN) {
              device.ws.send(JSON.stringify({ type: 'get_location' }));
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
      // Notify phone device went offline
      const device = devices.get(deviceId);
      if (device && device.phoneWs && device.phoneWs.readyState === WebSocket.OPEN) {
        device.phoneWs.send(JSON.stringify({ type: 'device_offline' }));
      }
      console.log(`Laptop disconnected: ${deviceId}`);
    }
    
    if (connectionType === 'phone') {
      console.log('Phone disconnected');
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// Cleanup old codes every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, info] of pairCodes) {
    if (now - info.createdAt > 600000) { // 10 minutes
      pairCodes.delete(key);
    }
  }
}, 600000);

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('   LAPTOP TRACKER - CLOUD SERVER');
  console.log('========================================');
  console.log(`\n  Server running on port ${PORT}`);
  console.log(`  Open http://localhost:${PORT} on your laptop`);
  console.log('========================================\n');
});

module.exports = { app, server };
