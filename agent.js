const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const os = require('os');
const path = require('path');

// ============= CONFIGURATION =============
const CLOUD_SERVER = process.env.CLOUD_SERVER || 'http://localhost:9999';
const PAIR_KEY = process.env.PAIR_KEY || '';

if (!PAIR_KEY) {
  console.log('\n========================================');
  console.log('   LAPTOP AGENT - SETUP REQUIRED');
  console.log('========================================');
  console.log('\n  Usage:');
  console.log('    set PAIR_KEY=YOUR_CODE');
  console.log('    set CLOUD_SERVER=your-render-url');
  console.log('    node agent.js');
  console.log('\n========================================\n');
  process.exit(1);
}

// ============= SYSTEM INFO =============
const systemInfo = {
  hostname: os.hostname(),
  platform: os.platform(),
  arch: os.arch(),
  cpus: os.cpus().length,
  totalMemory: os.totalmem()
};

let deviceId = null;

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

// ============= HTTP HELPER =============
function httpRequest(url, method, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { resolve({ raw: body }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });

    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// ============= GET IP LOCATION =============
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
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ============= EXECUTE .BAT FILE =============
function executeBat(batName, params = {}) {
  return new Promise((resolve) => {
    const batPath = path.join(__dirname, 'commands', `${batName}.bat`);
    let cmd = `"${batPath}"`;
    if (params.duration) cmd += ` ${params.duration}`;
    if (params.target) cmd += ` ${params.target}`;
    
    console.log(`  Executing: ${batName}`);
    
    exec(cmd, { timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ success: true, output: stdout || stderr || 'Done' });
    });
  });
}

// ============= PROCESS COMMAND =============
async function processCommand(command) {
  console.log(`\n  Command: ${command.commandType}`);
  
  switch (command.commandType) {
    case 'siren': return await executeBat('siren', command.params);
    case 'alarm': return await executeBat('alarm', command.params);
    case 'noise': return await executeBat('siren', { duration: 60 });
    case 'sensor': return await executeBat('alarm', command.params);
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
        exec(command.params.command, { timeout: 60000 }, (error, stdout) => {
          resolve({ success: !error, output: stdout || error?.message });
        });
      });
    default:
      return { success: false, error: 'Unknown command' };
  }
}

// ============= REGISTER WITH CLOUD =============
async function register() {
  try {
    console.log('Registering with cloud...');
    const result = await httpRequest(`${CLOUD_SERVER}/api/agent/register`, 'POST', {
      pairKey: PAIR_KEY,
      systemInfo: { ...systemInfo, localIP: getLocalIP() }
    });

    if (result.success) {
      deviceId = result.deviceId;
      console.log(`  ✓ Registered! Device ID: ${deviceId}`);
      return true;
    } else {
      console.log(`  ✗ Registration failed: ${result.error}`);
      return false;
    }
  } catch (e) {
    console.log(`  ✗ Connection error: ${e.message}`);
    return false;
  }
}

// ============= POLL FOR COMMANDS =============
async function pollCommands() {
  if (!deviceId) return;

  try {
    const result = await httpRequest(`${CLOUD_SERVER}/api/agent/poll/${deviceId}`, 'GET');

    if (result.success && result.commands && result.commands.length > 0) {
      console.log(`\n  Received ${result.commands.length} command(s)`);

      for (const command of result.commands) {
        // Execute command
        const cmdResult = await processCommand(command);

        // Send result back to cloud
        await httpRequest(`${CLOUD_SERVER}/api/agent/result`, 'POST', {
          commandId: command.commandId,
          deviceId: deviceId,
          result: cmdResult.output || cmdResult,
          error: cmdResult.error || null
        });

        console.log(`  ✓ Result sent for ${command.commandType}`);
      }
    }
  } catch (e) {
    console.log(`  Poll error: ${e.message}`);
  }
}

// ============= SEND HEARTBEAT =============
async function sendHeartbeat() {
  if (!deviceId) return;

  try {
    const location = await getIPLocation();
    
    await httpRequest(`${CLOUD_SERVER}/api/agent/heartbeat`, 'POST', {
      deviceId,
      location,
      systemInfo: { ...systemInfo, localIP: getLocalIP(), uptime: os.uptime() }
    });
  } catch (e) {
    // Silent fail for heartbeat
  }
}

// ============= MAIN LOOP =============
async function main() {
  console.log('\n========================================');
  console.log('   LAPTOP AGENT - STARTING');
  console.log('========================================');
  console.log(`\n  Pair Code: ${PAIR_KEY}`);
  console.log(`  Cloud: ${CLOUD_SERVER}`);
  console.log(`  Hostname: ${systemInfo.hostname}`);
  console.log(`  Platform: ${systemInfo.platform}`);
  console.log(`  Local IP: ${getLocalIP()}`);
  console.log('\n========================================\n');

  // Register
  const registered = await register();
  if (!registered) {
    console.log('\nRetrying in 5 seconds...');
    setTimeout(main, 5000);
    return;
  }

  // Poll for commands every 2 seconds
  console.log('\nPolling for commands every 2 seconds...\n');
  setInterval(pollCommands, 2000);

  // Send heartbeat every 5 seconds
  setInterval(sendHeartbeat, 5000);

  // Initial heartbeat
  await sendHeartbeat();
  console.log('✓ Heartbeat sent\n');
}

main();
