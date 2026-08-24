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
const devices = new Map();
const pairCodes = new Map();
const commands = new Map();

function generateDeviceId() {
  return 'dev_' + crypto.randomBytes(8).toString('hex');
}

wss.on('connection', (ws) => {
  console.log('WebSocket connected');
  
  let connectionType = null;
  let deviceId = null;
  let pairKey = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        // ============= LAPTOP REGISTERS =============
        case 'laptop_register':
          connectionType = 'laptop';
          pairKey = msg.pairKey;
          deviceId = generateDeviceId();
          
          pairCodes.set(pairKey, {
            deviceId,
            ws,
            phoneWs: null,
            createdAt: Date.now(),
            deviceInfo: msg.deviceInfo || null,
            laptopLocation: null,
            phoneLocation: null
          });
          
          ws.send(JSON.stringify({ 
            type: 'registered', 
            pairKey,
            deviceId,
            message: 'Code generated. Waiting for phone...'
          }));
          
          console.log(`Laptop registered: ${pairKey} -> ${deviceId}`);
          break;

        // ============= PHONE ENTERS CODE =============
        case 'phone_verify':
          connectionType = 'phone';
          pairKey = msg.pairKey;
          
          const pairInfo = pairCodes.get(pairKey);
          
          if (!pairInfo) {
            ws.send(JSON.stringify({
              type: 'verification_failed',
              error: 'Invalid code. Make sure laptop generated this code.'
            }));
            return;
          }
          
          // ============= VERIFICATION SUCCESS =============
          pairInfo.phoneWs = ws;
          deviceId = pairInfo.deviceId;
          
          // Store device
          devices.set(deviceId, {
            laptopWs: pairInfo.ws,
            phoneWs: ws,
            info: pairInfo.deviceInfo,
            laptopLocation: null,
            phoneLocation: null,
            lastSeen: Date.now()
          });
          
          // ============= NOTIFY LAPTOP: Phone Connected =============
          if (pairInfo.ws.readyState === WebSocket.OPEN) {
            pairInfo.ws.send(JSON.stringify({
              type: 'phone_connected',
              deviceId,
              message: 'Phone verified and connected!'
            }));
          }
          
          // ============= NOTIFY PHONE: Verification Success =============
          ws.send(JSON.stringify({
            type: 'verification_success',
            deviceId,
            deviceInfo: pairInfo.deviceInfo,
            message: 'Connected to laptop!'
          }));
          
          console.log(`Pair verified: ${pairKey}`);
          break;

        // ============= LAPTOP SENDS LOCATION =============
        case 'laptop_location':
          if (deviceId && devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.laptopLocation = msg.location;
            device.lastSeen = Date.now();
            
            // Send to phone
            if (device.phoneWs && device.phoneWs.readyState === WebSocket.OPEN) {
              device.phoneWs.send(JSON.stringify({
                type: 'laptop_location_update',
                location: msg.location,
                timestamp: Date.now()
              }));
            }
          }
          break;

        // ============= PHONE SENDS LOCATION =============
        case 'phone_location':
          if (deviceId && devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.phoneLocation = msg.location;
            
            // Send to laptop
            if (device.laptopWs && device.laptopWs.readyState === WebSocket.OPEN) {
              device.laptopWs.send(JSON.stringify({
                type: 'phone_location_update',
                location: msg.location,
                timestamp: Date.now()
              }));
            }
          }
          break;

        // ============= LAPTOP HEARTBEAT =============
        case 'laptop_heartbeat':
          if (deviceId && devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.lastSeen = Date.now();
            
            if (msg.location) device.laptopLocation = msg.location;
            if (msg.systemInfo) device.info = msg.systemInfo;
            
            // Send to phone
            if (device.phoneWs && device.phoneWs.readyState === WebSocket.OPEN) {
              device.phoneWs.send(JSON.stringify({
                type: 'laptop_heartbeat',
                location: msg.location,
                systemInfo: msg.systemInfo,
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
            if (device.laptopWs && device.laptopWs.readyState === WebSocket.OPEN) {
              device.laptopWs.send(JSON.stringify({
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
          }
          break;

        // ============= LAPTOP SENDS RESULT =============
        case 'laptop_result':
          const cmd = commands.get(msg.commandId);
          if (cmd) {
            cmd.result = msg.result;
            cmd.error = msg.error;
            cmd.status = msg.error ? 'failed' : 'completed';
            
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

        // ============= REQUEST LOCATION =============
        case 'request_location':
          if (deviceId && devices.has(deviceId)) {
            const device = devices.get(deviceId);
            if (device.laptopWs && device.laptopWs.readyState === WebSocket.OPEN) {
              device.laptopWs.send(JSON.stringify({ type: 'get_location' }));
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
      if (device && device.phoneWs && device.phoneWs.readyState === WebSocket.OPEN) {
        device.phoneWs.send(JSON.stringify({ type: 'laptop_offline' }));
      }
      console.log(`Laptop disconnected: ${deviceId}`);
    }
  });
});

// Cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, info] of pairCodes) {
    if (now - info.createdAt > 600000) pairCodes.delete(key);
  }
}, 600000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('   LAPTOP TRACKER - CLOUD SERVER');
  console.log('========================================');
  console.log(`\n  Running on port ${PORT}`);
  console.log('========================================\n');
});

module.exports = { app, server };
