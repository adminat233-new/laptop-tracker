const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

// Configuration
const CLOUD_SERVER = process.env.CLOUD_SERVER || 'http://localhost:9999';
const PAIR_KEY = process.env.PAIR_KEY || '';

if (!PAIR_KEY) {
  console.log('\n========================================');
  console.log('   LAPTOP AGENT - SETUP REQUIRED');
  console.log('========================================');
  console.log('\n  No pair key provided.');
  console.log('\n  Usage:');
  console.log('    set PAIR_KEY=YOUR_CODE_HERE');
  console.log('    set CLOUD_SERVER=your-render-url');
  console.log('    node agent.js');
  console.log('\n  Get the code from the web interface.');
  console.log('========================================\n');
  process.exit(1);
}

// System info
const systemInfo = {
  hostname: os.hostname(),
  platform: os.platform(),
  arch: os.arch(),
  cpus: os.cpus().length,
  totalMemory: os.totalmem()
};

// Get local IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Get IP location
function getIPLocation() {
  return new Promise((resolve, reject) => {
    https.get('https://ipapi.co/json/', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({
            lat: json.latitude,
            lng: json.longitude,
            city: json.city,
            region: json.region,
            country: json.country_name,
            ip: json.ip,
            org: json.org
          });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Execute .bat file
function executeBat(batName, params = {}) {
  return new Promise((resolve) => {
    const batPath = path.join(__dirname, 'commands', `${batName}.bat`);
    let cmd = `"${batPath}"`;
    if (params.duration) cmd += ` ${params.duration}`;
    if (params.target) cmd += ` ${params.target}`;
    
    console.log(`Executing: ${batName}`);
    
    exec(cmd, { timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ success: true, output: stdout || stderr || 'Done' });
    });
  });
}

// Process command
async function processCommand(type, params) {
  switch (type) {
    case 'siren': return await executeBat('siren', params);
    case 'alarm': return await executeBat('alarm', params);
    case 'noise': return await executeBat('siren', { duration: 60 });
    case 'sensor': return await executeBat('alarm', params);
    case 'lock': return await executeBat('lock');
    case 'shutdown': return await executeBat('shutdown');
    case 'netscan': return await executeBat('netscan');
    case 'sysinfo': return await executeBat('sysinfo');
    case 'location':
      try {
        const location = await getIPLocation();
        return { success: true, location };
      } catch (e) {
        return { success: false, error: e.message };
      }
    case 'custom':
      return new Promise((resolve) => {
        exec(params.command, { timeout: 60000 }, (error, stdout) => {
          resolve({ success: !error, output: stdout || error?.message });
        });
      });
    default:
      return { success: false, error: 'Unknown command' };
  }
}

// WebSocket connection
let ws = null;
let deviceId = null;

function connect() {
  const wsUrl = CLOUD_SERVER.replace('http', 'ws');
  console.log(`Connecting to: ${wsUrl}`);
  
  ws = new WebSocket(wsUrl);
  
  ws.on('open', () => {
    console.log('Connected to cloud!');
    
    // Register with pair code
    ws.send(JSON.stringify({
      type: 'laptop_register',
      pairKey: PAIR_KEY,
      deviceInfo: {
        ...systemInfo,
        localIP: getLocalIP()
      }
    }));
  });
  
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'registered':
          deviceId = msg.deviceId;
          console.log(`\nRegistered! Device ID: ${deviceId}`);
          console.log('Waiting for phone to connect...\n');
          
          // Start heartbeat
          startHeartbeat();
          break;
          
        case 'pair_success':
          console.log('\n✓ Phone connected successfully!\n');
          break;
          
        case 'get_location':
          const location = await getIPLocation();
          ws.send(JSON.stringify({
            type: 'laptop_location',
            location
          }));
          break;
          
        case 'execute_command':
          console.log(`Command: ${msg.commandType}`);
          const result = await processCommand(msg.commandType, msg.params);
          
          ws.send(JSON.stringify({
            type: 'laptop_result',
            commandId: msg.commandId,
            result: result.output || result,
            error: result.error || null
          }));
          break;
      }
    } catch (e) {
      console.error('Message error:', e.message);
    }
  });
  
  ws.on('close', () => {
    console.log('Disconnected. Reconnecting in 5 seconds...');
    setTimeout(connect, 5000);
  });
  
  ws.on('error', (err) => {
    console.error('Error:', err.message);
  });
}

// Heartbeat with location
function startHeartbeat() {
  setInterval(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        const location = await getIPLocation();
        ws.send(JSON.stringify({
          type: 'laptop_heartbeat',
          location,
          systemInfo: {
            ...systemInfo,
            localIP: getLocalIP(),
            uptime: os.uptime()
          }
        }));
      } catch (e) {
        ws.send(JSON.stringify({
          type: 'laptop_heartbeat',
          location: null,
          systemInfo
        }));
      }
    }
  }, 5000);
}

// Start
console.log('\n========================================');
console.log('   LAPTOP AGENT - STARTING');
console.log('========================================');
console.log(`\n  Pair Code: ${PAIR_KEY}`);
console.log(`  Cloud: ${CLOUD_SERVER}`);
console.log(`  Hostname: ${systemInfo.hostname}`);
console.log(`  Platform: ${systemInfo.platform}`);
console.log(`  Local IP: ${getLocalIP()}`);
console.log('\n========================================\n');

connect();
