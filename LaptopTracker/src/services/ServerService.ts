import { AppState, AppStateStatus } from 'react-native';

type MessageHandler = (msg: any) => void;

export class ServerService {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private deviceId: string;
  private deviceType: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: MessageHandler[] = [];
  private isConnected = false;

  constructor(serverUrl: string, deviceId: string, deviceType: string) {
    this.serverUrl = serverUrl.replace(/^http/, 'ws');
    this.deviceId = deviceId;
    this.deviceType = deviceType;
  }

  connect() {
    if (this.ws) return;
    try {
      this.ws = new WebSocket(this.serverUrl);
      this.ws.onopen = () => {
        console.log('[WS] Connected');
        this.isConnected = true;
        this.ws?.send(JSON.stringify({ type: 'register', deviceId: this.deviceId, deviceType: this.deviceType }));
      };
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handlers.forEach(h => h(msg));
        } catch (e) {}
      };
      this.ws.onclose = () => {
        console.log('[WS] Disconnected');
        this.isConnected = false;
        this.ws = null;
        this.scheduleReconnect();
      };
      this.ws.onerror = () => {};
    } catch (e) {
      this.scheduleReconnect();
    }
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.isConnected = false;
  }

  send(msg: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  sendLocation(loc: { lat: number; lng: number; accuracy: number; source: string; intLat: number; intLng: number }) {
    this.send({ type: 'location', location: loc });
  }

  sendHeartbeat(location: any, systemInfo: any) {
    fetch(`${this.serverUrl.replace('ws', 'http')}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: this.deviceId, location, systemInfo }),
    }).catch(() => {});
  }

  sendCommandResult(commandId: string, result: string) {
    this.send({ type: 'commandResult', commandId, result });
  }

  requestLocation() {
    this.send({ type: 'requestLocation' });
  }

  onMessage(handler: MessageHandler) {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }

  get connected() {
    return this.isConnected;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }
}

export async function apiPost(serverUrl: string, path: string, data: any) {
  const res = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function apiGet(serverUrl: string, path: string) {
  const res = await fetch(`${serverUrl}${path}`);
  return res.json();
}
