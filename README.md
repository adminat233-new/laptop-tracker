# Laptop Tracker - Public Access Guide

## Quick Start

### Option 1: Local Network Only (Same WiFi)
```bash
# Double-click start.bat
# Open http://192.168.43.113:7777 on your phone
```

### Option 2: Public Access (Anywhere in World)

#### Step 1: Start the server
```bash
# Double-click start.bat
# OR run: node server.js
```

#### Step 2: Create public tunnel
```bash
# Double-click tunnel.bat
# OR run: cloudflared tunnel --url http://localhost:7777
```

#### Step 3: Use the public URL
- Copy the URL shown (e.g., `https://random-name.trycloudflare.com`)
- Open this URL on your phone from anywhere
- Enter PIN: `1234`

## Features

### Mobile App Install (PWA)
1. Open the URL on your phone
2. Android: Tap 3-dot menu → "Add to Home Screen"
3. iPhone: Tap Share → "Add to Home Screen"

### Remote Controls
- **Live Tracking** - Real-time location updates
- **CPU/RAM/Battery** - System monitoring
- **Lock Laptop** - Instantly lock your device
- **Shutdown** - Remote shutdown
- **Alarms** - Siren, Alarm, Noise, Sensor
- **Network Scan** - Find devices on network

## Default Settings
- **PIN:** 1234
- **Port:** 7777

## Change PIN
```bash
set TRACKER_PIN=YOUR_NEW_PIN
node server.js
```

## Troubleshooting

### Port 7777 already in use
```bash
set PORT=8080
node server.js
```

### Cloudflared not working
Download manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/

### Phone can't connect
1. Make sure phone and laptop are on same WiFi
2. Check firewall allows port 7777
3. Try the public tunnel option instead
