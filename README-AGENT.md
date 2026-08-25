# Laptop Tracker Agent - Windows

Native Windows agent that connects to the laptop-tracker cloud server and provides full hardware/OS access for device tracking.

## Requirements

- **Node.js** v14+ (v18+ recommended) — [Download](https://nodejs.org/)
- **Windows 10/11** with PowerShell 5.1+
- **Administrator privileges** (for some features)

## Quick Start

### Option 1: One-Click Install

Right-click `install-agent.bat` → **Run as Administrator**

This will:
1. Verify Node.js is installed
2. Install the `ws` WebSocket dependency
3. Register an auto-start scheduled task
4. Create a `start-agent.bat` launcher

### Option 2: Manual Setup

```bash
cd laptop-tracker
npm install ws
node agent.js
```

## Configuration

Set the server URL via environment variable before starting:

```powershell
$env:SERVER_URL = "wss://your-server.com"
node agent.js
```

Or edit `install-agent.bat` to set it permanently.

Default server: `wss://laptop-tracker-k9vi.onrender.com`

## Supported Commands

| Command | Description |
|---------|-------------|
| `siren` | Play siren sound through speakers |
| `alarm` | Play alarm beeping |
| `noise` | Text-to-speech warning |
| `lock` | Lock the Windows workstation |
| `shutdown` | Shut down the computer |
| `locate` | Send GPS/IP location to server |
| `wifi-scan` | Scan nearby WiFi networks with signal strength |
| `ble-scan` | Scan Bluetooth Low Energy devices |
| `netscan` | Run netstat and ARP table dump |
| `sysinfo` | Full system info (CPU, RAM, disk, temperature) |
| `sensor` | Read CPU temperature via WMI |
| `screenshot` | Capture screen as PNG base64 |
| `camera` | Capture webcam frame as JPEG base64 |
| `read-file` | Read file contents from disk |
| `write-file` | Write file to disk |
| `list-dir` | List directory contents |
| `exec` | Execute arbitrary shell command |

## Running as a Service

### Option A: NSSM (Recommended)

```powershell
# Download NSSM from https://nssm.cc/download
# Then:
nssm install LaptopTracker "C:\path\to\start-agent.bat"
nssm start LaptopTracker

# Manage:
nssm status LaptopTracker
nssm stop LaptopTracker
nssm remove LaptopTracker confirm
```

### Option B: Task Scheduler (via install-agent.bat)

The installer registers a logon task automatically.

### Option C: node-windows

```bash
npm install node-windows
```

Create `service-installer.js`:

```javascript
const { Service } = require('node-windows');
const path = require('path');

const svc = new Service({
  name: 'LaptopTracker',
  description: 'Laptop Tracker Agent',
  script: path.join(__dirname, 'agent.js'),
  env: [{ name: 'SERVER_URL', value: 'wss://laptop-tracker-k9vi.onrender.com' }]
});

svc.on('install', () => svc.start());
svc.on('start', () => console.log('Service started'));
svc.install();
```

Run: `node service-installer.js`

## File Locations

| File | Path |
|------|------|
| Agent script | `laptop-tracker/agent.js` |
| Logs | `~/.laptop-tracker/agent.log` |
| Dependencies | `laptop-tracker/node_modules/` |

## Features

- **Auto-reconnect**: Reconnects every 5s on disconnect, exponential backoff up to 60s
- **Location heartbeat**: Sends location every 2 minutes
- **Rate limiting**: Location requests throttled to prevent spam
- **Error handling**: Graceful degradation when hardware unavailable
- **Clean shutdown**: Handles SIGINT/SIGTERM properly
- **Logging**: Timestamped logs to console and `~/.laptop-tracker/agent.log`

## Troubleshooting

**Agent won't connect:**
- Verify server URL is correct
- Check firewall allows outbound WebSocket (port 443)
- Ensure Node.js is in PATH

**WiFi scan fails:**
- Run as Administrator
- Ensure WLAN AutoConfig service is running

**Camera capture fails:**
- Install ffmpeg and add to PATH
- Or use PowerShell with DirectShow-compatible camera

**Temperature reading unavailable:**
- WMI thermal zone not available on all hardware
- Falls back to null temperature

## Security Notice

This agent provides full system access to the server. Only deploy on devices you own or have authorization to monitor. All communication should use WSS (TLS) in production.
