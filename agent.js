const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const os = require('os');
const path = require('path');

const CLOUD_SERVER = process.env.CLOUD_SERVER || 'http://localhost:9999';
const PAIR_KEY = process.env.PAIR_KEY || '';

if (!PAIR_KEY) {
  console.log('Usage: set PAIR_KEY=CODE && set CLOUD_SERVER=url && node agent.js');
  process.exit(1);
}

let deviceId = null;

function api(url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: data ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

function getIPLocation() {
  return new Promise((resolve, reject) => {
    https.get('https://ipapi.co/json/', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve({ lat: j.latitude, lng: j.longitude, intLat: Math.round(j.latitude * 1000000), intLng: Math.round(j.longitude * 1000000), city: j.city, region: j.region, country: j.country_name, ip: j.ip });
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function executeBat(name, params = {}) {
  return new Promise((resolve) => {
    const bat = path.join(__dirname, 'commands', name + '.bat');
    let cmd = '"' + bat + '"';
    if (params.duration) cmd += ' ' + params.duration;
    exec(cmd, { timeout: 60000, maxBuffer: 1024*1024 }, (err, stdout) => {
      resolve(stdout || 'Done');
    });
  });
}

async function processCommand(cmd) {
  console.log('  Executing: ' + cmd.commandType);
  switch (cmd.commandType) {
    case 'siren': return await executeBat('siren', cmd.params);
    case 'alarm': return await executeBat('alarm', cmd.params);
    case 'noise': return await executeBat('siren', { duration: 60 });
    case 'sensor': return await executeBat('alarm', cmd.params);
    case 'lock': return await executeBat('lock');
    case 'shutdown': return await executeBat('shutdown');
    case 'netscan': return await executeBat('netscan');
    case 'sysinfo': return await executeBat('sysinfo');
    case 'location':
      const loc = await getIPLocation();
      return JSON.stringify({ location: loc });
    default: return 'Unknown command';
  }
}

async function main() {
  console.log('\n=== LAPTOP AGENT ===');
  console.log('Code: ' + PAIR_KEY);
  console.log('Cloud: ' + CLOUD_SERVER);

  // Register
  try {
    const loc = await getIPLocation();
    const sysInfo = { hostname: os.hostname(), platform: os.platform(), arch: os.arch(), localIP: getLocalIP() };
    const data = await api(CLOUD_SERVER + '/api/register', { pairKey: PAIR_KEY, systemInfo: sysInfo });
    if (data.success) {
      deviceId = data.deviceId;
      console.log('Registered: ' + deviceId);
    } else {
      console.log('Registration failed');
      return;
    }
  } catch(e) {
    console.log('Connection error: ' + e.message);
    return;
  }

  // Poll loop
  console.log('Polling for commands...\n');
  setInterval(async () => {
    try {
      // Poll commands
      const poll = await api(CLOUD_SERVER + '/api/poll/' + deviceId);
      if (poll.commands && poll.commands.length > 0) {
        for (const cmd of poll.commands) {
          const result = await processCommand(cmd);
          await api(CLOUD_SERVER + '/api/result', { commandId: cmd.commandId, deviceId, result });
          console.log('  Result sent: ' + cmd.commandType);
        }
      }

      // Send heartbeat with location
      const loc = await getIPLocation();
      await api(CLOUD_SERVER + '/api/heartbeat', { deviceId, location: loc, systemInfo: { hostname: os.hostname(), platform: os.platform() } });
    } catch(e) {}
  }, 2000);
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

main();
