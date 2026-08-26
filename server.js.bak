const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const networkUtils = require('./network-utils');
const locationTracker = require('./location-tracker');
const alarmSystem = require('./alarm-system');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 9999;
const PIN = process.env.TRACKER_PIN || '1234';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let connectedClients = new Set();
let isTracking = false;
let trackingInterval = null;
let statsInterval = null;
let currentLocation = null;
let systemStats = {};
let previousCpuInfo = os.cpus();

const isCloudHosted = process.env.RENDER || process.env.HEROKU || process.env.NODE_ENV === 'production';

let laptopInfo = {
  hostname: os.hostname(),
  platform: os.platform(),
  arch: os.arch(),
  networkInterfaces: os.networkInterfaces(),
  isCloudHosted: !!isCloudHosted,
  note: isCloudHosted ? 'Running on cloud server - location tracked via IP' : 'Running locally on laptop'
};

// Get CPU usage percentage
function getCpuUsage() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  let prevTotalIdle = 0, prevTotalTick = 0;

  cpus.forEach((cpu, i) => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });

  previousCpuInfo.forEach((cpu, i) => {
    for (const type in cpu.times) {
      prevTotalTick += cpu.times[type];
    }
    prevTotalIdle += cpu.times.idle;
  });

  const idleDiff = totalIdle - prevTotalIdle;
  const totalDiff = totalTick - prevTotalTick;
  
  previousCpuInfo = cpus;
  
  return totalDiff === 0 ? 0 : Math.round((1 - idleDiff / totalDiff) * 100);
}

// Get battery info (Windows)
function getBatteryInfo() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('WMIC Path Win32_Battery Get BatteryStatus,EstimatedChargeRemaining,RemainingRunTime /Format:List', (error, stdout) => {
        if (error) {
          resolve({ available: false });
          return;
        }

        const statusMatch = stdout.match(/BatteryStatus=(\d+)/);
        const chargeMatch = stdout.match(/EstimatedChargeRemaining=(\d+)/);
        const runtimeMatch = stdout.match(/RemainingRunTime=(\d+)/);

        resolve({
          available: !!statusMatch,
          charging: statusMatch ? parseInt(statusMatch[1]) === 2 : false,
          percentage: chargeMatch ? parseInt(chargeMatch[1]) : null,
          remainingTime: runtimeMatch ? parseInt(runtimeMatch[1]) : null
        });
      });
    } else if (process.platform === 'linux') {
      exec('upower -i /org/freedesktop/UPower/devices/battery_BAT0 2>/dev/null || cat /sys/class/power_supply/BAT*/capacity 2>/dev/null', (error, stdout) => {
        if (error) {
          resolve({ available: false });
          return;
        }
        const capacityMatch = stdout.match(/capacity:\s*(\d+)/) || stdout.match(/(\d+)/);
        resolve({
          available: true,
          percentage: capacityMatch ? parseInt(capacityMatch[1]) : null
        });
      });
    } else {
      resolve({ available: false });
    }
  });
}

// Get disk usage
function getDiskUsage() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace,Size /format:list', (error, stdout) => {
        if (error) {
          resolve({ available: false });
          return;
        }

        const freeMatch = stdout.match(/FreeSpace=(\d+)/);
        const sizeMatch = stdout.match(/Size=(\d+)/);

        resolve({
          available: true,
          total: sizeMatch ? parseInt(sizeMatch[1]) : 0,
          free: freeMatch ? parseInt(freeMatch[1]) : 0,
          used: sizeMatch && freeMatch ? parseInt(sizeMatch[1]) - parseInt(freeMatch[1]) : 0
        });
      });
    } else {
      exec('df -B1 / 2>/dev/null', (error, stdout) => {
        if (error) {
          resolve({ available: false });
          return;
        }
        const lines = stdout.split('\n');
        if (lines.length > 1) {
          const parts = lines[1].split(/\s+/);
          resolve({
            available: true,
            total: parseInt(parts[1]) || 0,
            used: parseInt(parts[2]) || 0,
            free: parseInt(parts[3]) || 0
          });
        } else {
          resolve({ available: false });
        }
      });
    }
  });
}

// Get running processes count
function getProcessCount() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('tasklist /fo csv /nh | find /c /v ""', (error, stdout) => {
        resolve(error ? 0 : parseInt(stdout.trim()) || 0);
      });
    } else {
      exec('ps aux | wc -l', (error, stdout) => {
        resolve(error ? 0 : parseInt(stdout.trim()) - 1 || 0);
      });
    }
  });
}

// Get network speed
function getNetworkSpeed() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('netstat -e', (error, stdout) => {
        if (error) {
          resolve({ bytesReceived: 0, bytesSent: 0 });
          return;
        }
        const receivedMatch = stdout.match(/Bytes Received\s+(\d+)/);
        const sentMatch = stdout.match(/Bytes Sent\s+(\d+)/);
        resolve({
          bytesReceived: receivedMatch ? parseInt(receivedMatch[1]) : 0,
          bytesSent: sentMatch ? parseInt(sentMatch[1]) : 0
        });
      });
    } else {
      resolve({ bytesReceived: 0, bytesSent: 0 });
    }
  });
}

// Collect all system stats
async function collectSystemStats() {
  const [battery, disk, processCount, network] = await Promise.all([
    getBatteryInfo(),
    getDiskUsage(),
    getProcessCount(),
    getNetworkSpeed()
  ]);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  systemStats = {
    timestamp: Date.now(),
    cpu: {
      usage: getCpuUsage(),
      cores: os.cpus().length,
      model: os.cpus()[0]?.model || 'Unknown',
      speed: os.cpus()[0]?.speed || 0
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percentage: Math.round((usedMem / totalMem) * 100)
    },
    battery,
    disk,
    processes: processCount,
    network,
    uptime: os.uptime(),
    hostname: os.hostname(),
    platform: os.platform()
  };

  // Broadcast stats to all connected clients
  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'system_stats',
        stats: systemStats
      }));
    }
  });

  return systemStats;
}

// PIN verification
app.post('/api/auth', (req, res) => {
  const { pin } = req.body;
  if (pin === PIN) {
    res.json({ success: true, laptopInfo });
  } else {
    res.status(401).json({ success: false, error: 'Invalid PIN' });
  }
});

// Get current location
app.get('/api/location', async (req, res) => {
  try {
    const location = await locationTracker.getLocation();
    currentLocation = location;
    res.json({ success: true, location });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start live tracking
app.post('/api/tracking/start', (req, res) => {
  if (isTracking) {
    return res.json({ success: true, message: 'Already tracking' });
  }

  isTracking = true;
  trackingInterval = setInterval(async () => {
    try {
      const location = await locationTracker.getLocation();
      currentLocation = location;

      connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'location_update',
            location,
            timestamp: Date.now()
          }));
        }
      });
    } catch (error) {
      console.error('Tracking error:', error);
    }
  }, 3000);

  res.json({ success: true, message: 'Tracking started' });
});

// Stop live tracking
app.post('/api/tracking/stop', (req, res) => {
  isTracking = false;
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
  }
  res.json({ success: true, message: 'Tracking stopped' });
});

// Trigger alarm
app.post('/api/alarm/trigger', async (req, res) => {
  const { type, duration } = req.body;

  try {
    await alarmSystem.triggerAlarm(type, duration || 30);
    res.json({ success: true, message: `${type} alarm triggered` });

    connectedClients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'alarm_triggered',
          alarmType: type,
          timestamp: Date.now()
        }));
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Stop alarm
app.post('/api/alarm/stop', (req, res) => {
  alarmSystem.stopAllAlarms();
  res.json({ success: true, message: 'All alarms stopped' });
});

// Network scan for location
app.get('/api/network/scan', async (req, res) => {
  try {
    const networkInfo = await networkUtils.scanNetwork();
    res.json({ success: true, networkInfo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get IP-based location
app.get('/api/location/ip', async (req, res) => {
  try {
    const location = await locationTracker.getIPLocation();
    res.json({ success: true, location });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ping a target
app.post('/api/network/ping', async (req, res) => {
  const { target } = req.body;
  try {
    const result = await networkUtils.ping(target);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get system info
app.get('/api/system', async (req, res) => {
  const stats = await collectSystemStats();
  res.json({ success: true, system: stats });
});

// Get real-time stats
app.get('/api/system/stats', async (req, res) => {
  const stats = await collectSystemStats();
  res.json({ success: true, stats });
});

// Get system info basic
app.get('/api/system/info', (req, res) => {
  res.json({
    success: true,
    info: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      cpus: os.cpus(),
      totalMemory: os.totalmem(),
      networkInterfaces: Object.entries(os.networkInterfaces())
        .map(([name, addrs]) => ({
          name,
          addresses: addrs.filter(addr => !addr.internal).map(addr => addr.address)
        }))
    }
  });
});

// Screenshot (placeholder - would need additional library)
app.get('/api/system/screenshot', (req, res) => {
  res.json({ 
    success: false, 
    message: 'Screenshot requires additional setup',
    note: 'Install: npm install screenshot-desktop'
  });
});

// Shutdown laptop
app.post('/api/system/shutdown', (req, res) => {
  const { confirm } = req.body;
  if (confirm === true) {
    res.json({ success: true, message: 'Shutdown initiated' });
    setTimeout(() => {
      if (process.platform === 'win32') {
        exec('shutdown /s /t 10 /c "Remote shutdown triggered"');
      } else {
        exec('sudo shutdown -h +1 "Remote shutdown triggered"');
      }
    }, 1000);
  } else {
    res.json({ success: false, message: 'Send confirm: true to proceed' });
  }
});

// Restart laptop
app.post('/api/system/restart', (req, res) => {
  const { confirm } = req.body;
  if (confirm === true) {
    res.json({ success: true, message: 'Restart initiated' });
    setTimeout(() => {
      if (process.platform === 'win32') {
        exec('shutdown /r /t 10 /c "Remote restart triggered"');
      } else {
        exec('sudo reboot');
      }
    }, 1000);
  } else {
    res.json({ success: false, message: 'Send confirm: true to proceed' });
  }
});

// Lock laptop
app.post('/api/system/lock', (req, res) => {
  try {
    if (process.platform === 'win32') {
      exec('rundll32.exe user32.dll,LockWorkStation');
    } else if (process.platform === 'darwin') {
      exec('pmset displaysleepnow');
    } else {
      exec('xdg-screensaver lock 2>/dev/null || gnome-screensaver-command -l 2>/dev/null');
    }
    res.json({ success: true, message: 'Laptop locked' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// WebSocket connection
wss.on('connection', (ws) => {
  console.log('Client connected');
  connectedClients.add(ws);

  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected to laptop tracker',
    laptopInfo,
    isTracking,
    currentLocation
  }));

  // Send initial stats
  collectSystemStats().then(stats => {
    ws.send(JSON.stringify({
      type: 'system_stats',
      stats
    }));
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    connectedClients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    connectedClients.delete(ws);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.type === 'request_stats') {
        collectSystemStats().then(stats => {
          ws.send(JSON.stringify({
            type: 'system_stats',
            stats
          }));
        });
      }
      
      if (msg.type === 'request_location') {
        locationTracker.getLocation().then(location => {
          ws.send(JSON.stringify({
            type: 'location_update',
            location,
            timestamp: Date.now()
          }));
        });
      }
    } catch (e) {
      console.error('Invalid message:', e);
    }
  });
});

// Start collecting stats every 5 seconds
statsInterval = setInterval(collectSystemStats, 5000);

// Start server
server.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
  }

  console.log('\n========================================');
  console.log('   LAPTOP TRACKER - READY');
  console.log('========================================');
  console.log(`\n  PIN: ${PIN}`);
  console.log(`\n  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${localIP}:${PORT}`);
  console.log(`\n  Open this URL on your phone!`);
  console.log(`  Add to Home Screen for app experience.`);
  console.log('========================================\n');

  // Initial stats collection
  collectSystemStats();
});

module.exports = { app, server };
