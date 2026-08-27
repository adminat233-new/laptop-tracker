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
const SERVER = 'https://laptop-tracker-k9vi.onrender.com';
const CONFIG_PATH = path.join(app.getPath('userData'), 'find-config.json');

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
    mainWindow.once('ready-to-show', () => mainWindow.show());
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

function startAgent() {
    if (!pairCode) return;
    stopAgent();
    const wsUrl = SERVER.replace('https://', 'wss://').replace('http://', 'ws://');
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'register', deviceId: pairCode, deviceType: 'agent' }));
        heartbeatInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat', deviceId: pairCode }));
        }, 10000);
        if (mainWindow) mainWindow.webContents.send('agent-status', true);
    });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'command') handleCommand(msg);
        } catch (e) {}
    });

    ws.on('close', () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (mainWindow) mainWindow.webContents.send('agent-status', false);
        if (isAgentMode) setTimeout(startAgent, 5000);
    });

    ws.on('error', () => {});
}

function stopAgent() {
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

function handleCommand(msg) {
    const { commandType: type, commandId: id } = msg;
    const handlers = {
        'locate': () => shell('powershell -Command "Add-Type System.Device; $w=New-Object System.Device.Location.GeoCoordinateWatcher; $w.Start(); Start-Sleep 2; $l=$w.Position.Location; if($l.IsUnknown){"IP"} else{$l.Latitude+\",\"+$l.Longitude}"'),
        'lock': () => shell('rundll32.exe user32.dll,LockWorkStation'),
        'siren': () => { shell('powershell -Command "$p=New-Object Media.SoundPlayer; $p.SoundLocation=\'C:\\Windows\\Media\\Alarm01.wav\'; $p.PlayLooping()"'); setTimeout(() => shell('taskkill /IM wmplayer.exe /F'), 15000); return Promise.resolve('{"ok":true}'); },
        'screenshot': () => shell('powershell -Command "Add-Type System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen; $b=New-Object Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height); $g=[Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Bounds.Location,[Drawing.Point]::Empty,$s.Bounds.Size); $b.Save(\'C:\\Windows\\Temp\\find-ss.png\'); $b.Dispose(); $g.Dispose()"'),
        'wifi-scan': () => shell('netsh wlan show networks mode=bssid'),
        'arp-scan': () => shell('arp -a'),
        'port-audit': () => shell('netstat -ano'),
        'process-audit': () => shell('tasklist /FO CSV'),
        'usb-audit': () => shell('wmic path win32_pnpentity get name'),
        'wifi-passwords': () => shell('netsh wlan show profile'),
        'dns-dump': () => shell('ipconfig /displaydns'),
        'bt-proximity': () => shell('powershell "Get-PnpDevice -Class Bluetooth | Select Name,Status"')
    };
    const fn = handlers[type];
    if (fn) fn().then(r => sendResult(id, type, r));
}

function shell(cmd) {
    return new Promise((resolve) => {
        exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? err.message : stdout));
    });
}

function sendResult(id, type, result) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'commandResult', commandId: id, commandType: type, deviceId: pairCode, result }));
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
ipcMain.handle('sys-info', () => ({
    hostname: os.hostname(), platform: os.platform(), release: os.release(),
    arch: os.arch(), cpus: os.cpus().length,
    ram: (os.totalmem() / 1073741824).toFixed(1) + ' GB',
    free: (os.freemem() / 1073741824).toFixed(1) + ' GB'
}));

app.whenReady().then(() => { loadConfig(); createWindow(); createTray(); if (isAgentMode && pairCode) startAgent(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
