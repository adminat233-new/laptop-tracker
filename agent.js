const http = require('http');
const https = require('https');
const { exec, execSync } = require('child_process');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

// Configuration
const CLOUD_SERVER = process.env.CLOUD_SERVER || 'http://localhost:9999';
const PAIR_KEY = process.env.PAIR_KEY || '';
const DEVICE_ID = process.env.DEVICE_ID || '';

// Validate configuration
if (!PAIR_KEY) {
  console.log('\n========================================');
  console.log('   LAPTOP AGENT - SETUP REQUIRED');
  console.log('========================================');
  console.log('\n  No pair key provided.');
  console.log('\n  Usage:');
  console.log('    set PAIR_KEY=YOUR_KEY_HERE');
  console.log('    node agent.js');
  console.log('\n  Get your pair key from the web interface.');
  console.log('========================================\n');
  process.exit(1);
}

// System info
let systemInfo = {
  hostname: os.hostname(),
  platform: os.platform(),
  arch: os.arch(),
  cpus: os.cpus().length,
  totalMemory: os.totalmem(),
  hostname: os.hostname()
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

// Execute a .bat file
function executeBatCommand(batName, params = {}) {
  return new Promise((resolve, reject) => {
    const batPath = path.join(__dirname, 'commands', `${batName}.bat`);
    
    // Build command with parameters
    let cmd = `"${batPath}"`;
    if (params.duration) cmd += ` ${params.duration}`;
    if (params.target) cmd += ` ${params.target}`;
    
    console.log(`Executing: ${batName}`);
    
    exec(cmd, { timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ success: true, output: 'Command completed (timed out)', partial: true });
      } else if (error) {
        // Some commands return error codes but still work
        resolve({ success: true, output: stdout || stderr || 'Executed' });
      } else {
        resolve({ success: true, output: stdout });
      }
    });
  });
}

// Execute a direct command (for custom requests)
function executeDirectCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout) {
        resolve({ success: false, error: error.message });
      } else {
        resolve({ success: true, output: stdout || stderr });
      }
    });
  });
}

// Process a command from cloud
async function processCommand(cmd) {
  console.log(`Processing command: ${cmd.type}`);
  
  let result;
  
  switch (cmd.type) {
    case 'siren':
      result = await executeBatCommand('siren', cmd.params);
      break;
      
    case 'alarm':
      result = await executeBatCommand('alarm', cmd.params);
      break;
      
    case 'noise':
      result = await executeBatCommand('siren', { duration: 60 });
      break;
      
    case 'sensor':
      result = await executeBatCommand('alarm', cmd.params);
      break;
      
    case 'lock':
      result = await executeBatCommand('lock');
      break;
      
    case 'shutdown':
      result = await executeBatCommand('shutdown');
      break;
      
    case 'location':
      try {
        const location = await getIPLocation();
        result = { success: true, location };
      } catch (e) {
        result = { success: false, error: e.message };
      }
      break;
      
    case 'netscan':
      result = await executeBatCommand('netscan');
      break;
      
    case 'sysinfo':
      result = await executeBatCommand('sysinfo');
      break;
      
    case 'custom':
      if (cmd.params.command) {
        result = await executeDirectCommand(cmd.params.command);
      } else {
        result = { success: false, error: 'No command provided' };
      }
      break;
      
    default:
      result = { success: false, error: `Unknown command: ${cmd.type}` };
  }
  
  return result;
}

// Send result to cloud
function sendResult(commandId, result) {
  const url = new URL('/api/agent/result', CLOUD_SERVER);
  
  const data = JSON.stringify({
    commandId,
    deviceId: DEVICE_ID,
    result: result.output || result,
    error: result.error || null
  });

  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        console.log('Result sent:', JSON.parse(body));
      } catch (e) {
        console.log('Result sent');
      }
    });
  });

  req.on('error', (e) => console.error('Error sending result:', e.message));
  req.write(data);
  req.end();
}

// Send heartbeat with location
let ws = null;
let heartbeatInterval = null;

function sendHeartbeat() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    getIPLocation().then(location => {
      ws.send(JSON.stringify({
        type: 'agent_heartbeat',
        location,
        systemInfo: {
          ...systemInfo,
          localIP: getLocalIP(),
          uptime: os.uptime()
        }
      }));
    }).catch(() => {
      ws.send(JSON.stringify({
        type: 'agent_heartbeat',
        location: null,
        systemInfo
      }));
    });
  }
}

// Connect to cloud via WebSocket
function connectToCloud() {
  const wsUrl = CLOUD_SERVER.replace('http', 'ws');
  
  console.log(`Connecting to cloud: ${wsUrl}`);
  
  ws = new WebSocket(wsUrl);
  
  ws.on('open', () => {
    console.log('Connected to cloud server!');
    
    // Register as agent
    ws.send(JSON.stringify({
      type: 'agent_connect',
      deviceId: DEVICE_ID,
      pairKey: PAIR_KEY,
      systemInfo: {
        ...systemInfo,
        localIP: getLocalIP()
      }
    }));
    
    // Start heartbeat
    heartbeatInterval = setInterval(sendHeartbeat, 5000);
    
    // Send initial location
    sendHeartbeat();
  });
  
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      
      switch (msg.type) {
        case 'new_command':
          console.log(`New command received: ${msg.commandType}`);
          const result = await processCommand({
            type: msg.commandType,
            params: msg.params
          });
          sendResult(msg.commandId, result);
          break;
          
        case 'get_location':
          const location = await getIPLocation();
          ws.send(JSON.stringify({
            type: 'location_update',
            location
          }));
          break;
          
        case 'connected':
          console.log('Registration confirmed');
          break;
      }
    } catch (e) {
      console.error('Message error:', e.message);
    }
  });
  
  ws.on('close', () => {
    console.log('Disconnected from cloud. Reconnecting in 5 seconds...');
    clearInterval(heartbeatInterval);
    setTimeout(connectToCloud, 5000);
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
}

// Start the agent
console.log('\n========================================');
console.log('   LAPTOP AGENT - STARTING');
console.log('========================================');
console.log(`\n  Pair Key: ${PAIR_KEY}`);
console.log(`  Cloud Server: ${CLOUD_SERVER}`);
console.log(`  Device ID: ${DEVICE_ID || 'Will be assigned'}`);
console.log(`\n  Hostname: ${systemInfo.hostname}`);
console.log(`  Platform: ${systemInfo.platform}`);
console.log(`  Local IP: ${getLocalIP()}`);
console.log('\n========================================\n');

connectToCloud();
