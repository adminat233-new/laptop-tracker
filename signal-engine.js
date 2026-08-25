class KalmanFilter {
  constructor(q = 0.05, r = 1.25, initial = -65) {
    this.x = initial;
    this.p = 1;
    this.k = 0;
    this.q = q;
    this.r = r;
  }
  update(measurement) {
    this.p += this.q;
    this.k = this.p / (this.p + this.r);
    this.x += this.k * (measurement - this.x);
    this.p = (1 - this.k) * this.p;
    return this.x;
  }
}

class KalmanFilter2D {
  constructor(q = 0.1, r = 1.0) {
    this.x = [0, 0, 0, 0];
    this.p = Array(4).fill(null).map(() => Array(4).fill(0));
    for (let i = 0; i < 4; i++) this.p[i][i] = 1;
    this.q = q;
    this.r = r;
    this.f = [[1,0,1,0],[0,1,0,1],[0,0,1,0],[0,0,0,1]];
    this.h = [[1,0,0,0],[0,1,0,0]];
  }
  predict(dt = 1) {
    const f = this.f;
    f[0][2] = dt; f[1][3] = dt;
    const nx = [0,0,0,0];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) nx[i] += f[i][j] * this.x[j];
    this.x = nx;
    const fp = Array(4).fill(null).map(() => Array(4).fill(0));
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) fp[i][j] += f[i][k] * this.p[k][j];
    const fpf = Array(4).fill(null).map(() => Array(4).fill(0));
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) fpf[i][j] += fp[i][k] * f[j][k];
    const qm = Array(4).fill(null).map(() => Array(4).fill(0));
    qm[0][0] = this.q; qm[1][1] = this.q; qm[2][2] = this.q * 0.1; qm[3][3] = this.q * 0.1;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) this.p[i][j] = fpf[i][j] + qm[i][j];
  }
  update(z) {
    const h = this.h;
    const hp = Array(2).fill(null).map(() => Array(4).fill(0));
    for (let i = 0; i < 2; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) hp[i][j] += h[i][k] * this.p[k][j];
    const hpht = Array(2).fill(null).map(() => Array(2).fill(0));
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 4; k++) hpht[i][j] += hp[i][k] * h[j][k];
    const rm = [[this.r, 0], [0, this.r]];
    const s = [[hpht[0][0]+rm[0][0], hpht[0][1]+rm[0][1]], [hpht[1][0]+rm[1][0], hpht[1][1]+rm[1][1]]];
    const det = s[0][0]*s[1][1] - s[0][1]*s[1][0];
    if (Math.abs(det) < 1e-10) return { x: this.x[0], y: this.x[1], vx: this.x[2], vy: this.x[3] };
    const si = [[s[1][1]/det, -s[0][1]/det], [-s[1][0]/det, s[0][0]/det]];
    const pht = Array(4).fill(null).map(() => Array(2).fill(0));
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 4; k++) pht[i][j] += this.p[i][k] * h[j][k];
    const k = Array(4).fill(null).map(() => Array(2).fill(0));
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) k[i][j] += pht[i][k] * si[k][j];
    const hx = [0, 0];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 4; j++) hx[i] += h[i][j] * this.x[j];
    const innov = [z[0]-hx[0], z[1]-hx[1]];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) this.x[i] += k[i][j] * innov[j];
    const ikh = Array(4).fill(null).map((_,i) => Array(4).fill(0).map((_,j) => i===j?1:0));
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let kk = 0; kk < 2; kk++) ikh[i][j] -= k[i][kk] * h[kk][j];
    const newp = Array(4).fill(null).map(() => Array(4).fill(0));
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let kk = 0; kk < 4; kk++) newp[i][j] += ikh[i][kk] * this.p[kk][j];
    this.p = newp;
    return { x: this.x[0], y: this.x[1], vx: this.x[2], vy: this.x[3] };
  }
}

function rssiToDistance(rssi, p0 = -55, n = 4.0) {
  if (rssi >= p0) return 0.1;
  return Math.pow(10, (p0 - rssi) / (10 * n));
}

function distanceToRssi(distance, p0 = -55, n = 4.0) {
  const d = Math.max(distance, 0.1);
  return p0 - 10 * n * Math.log10(d);
}

function solveTrilateration(beacons) {
  if (beacons.length < 3) return null;
  const ref = beacons[beacons.length - 1];
  const n = beacons.length - 1;
  const A = [];
  const B = [];
  for (let i = 0; i < n; i++) {
    const b = beacons[i];
    A.push([2*(b.x-ref.x), 2*(b.y-ref.y)]);
    B.push([
      ref.distance*ref.distance - b.distance*b.distance
      - ref.x*ref.x + b.x*b.x
      - ref.y*ref.y + b.y*b.y
    ]);
  }
  const ata = [[0,0],[0,0]];
  const atb = [0,0];
  for (let i = 0; i < n; i++) {
    ata[0][0] += A[i][0]*A[i][0]; ata[0][1] += A[i][0]*A[i][1];
    ata[1][0] += A[i][1]*A[i][0]; ata[1][1] += A[i][1]*A[i][1];
    atb[0] += A[i][0]*B[i]; atb[1] += A[i][1]*B[i];
  }
  const det = ata[0][0]*ata[1][1] - ata[0][1]*ata[1][0];
  if (Math.abs(det) < 1e-10) return null;
  const inv = [[ata[1][1]/det, -ata[0][1]/det], [-ata[1][0]/det, ata[0][0]/det]];
  return { x: inv[0][0]*atb[0]+inv[0][1]*atb[1], y: inv[1][0]*atb[0]+inv[1][1]*atb[1] };
}

function solveTriangulationSines(beacons) {
  if (beacons.length < 2) return null;
  let best = null, bestScore = -1;
  for (let i = 0; i < beacons.length; i++) {
    for (let j = i+1; j < beacons.length; j++) {
      const a = beacons[i], b = beacons[j];
      const dx = b.x-a.x, dy = b.y-a.y;
      const c = Math.sqrt(dx*dx+dy*dy);
      if (c < 1.0) continue;
      const kA = Math.tan(a.angle||0), kB = Math.tan(b.angle||0);
      if (Math.abs(kA-kB) < 0.01) continue;
      const x = (b.y-a.y+kA*a.x-kB*b.x)/(kA-kB);
      const y = a.y+kA*(x-a.x);
      const alpha = Math.atan2(y-a.y, x-a.x);
      const beta = Math.atan2(y-b.y, x-b.x);
      const gamma = Math.PI - Math.abs(alpha-beta);
      const score = Math.abs(Math.sin(gamma));
      if (score > bestScore) { bestScore = score; best = { x, y, score, gamma }; }
    }
  }
  return best;
}

const MAC_VENDORS = {
  '3C5AB3': 'Apple AirTag', 'D4A33D': 'Apple AirTag', 'A8667F': 'Apple iBeacon',
  '7C11CB': 'Apple U1 UWB', '002500': 'Apple Beacon', 'ACFDCE': 'Apple H1 BLE',
  '147DDA': 'Apple Beacon', 'F0D1A9': 'Tile Tracker', '84F3EB': 'Tile Tracker',
  'CCED8C': 'Tile Tracker', 'F4F5D8': 'Tile Tracker', 'E0D07C': 'Samsung SmartTag',
  'E807BF': 'Samsung SmartTag', '40163B': 'Samsung SmartTag',
  '70B3D5': 'Nordic BLE', 'B4E62D': 'Nordic BLE', '442C05': 'Nordic BLE',
  '246F28': 'ESP32', '807D3A': 'ESP32', 'A4CF12': 'ESP32',
};
const FALLBACK_VENDORS = ['Contact.io','Estimote','Kontakt','Mekco'];

function lookupMacVendor(mac) {
  if (!mac) return 'Unknown';
  const clean = mac.replace(/[^a-fA-F0-9]/g, '').substring(0, 6).toUpperCase();
  if (MAC_VENDORS[clean]) return MAC_VENDORS[clean];
  let hash = 0;
  for (let i = 0; i < clean.length; i++) hash = ((hash << 5) - hash + clean.charCodeAt(i)) | 0;
  return FALLBACK_VENDORS[Math.abs(hash) % FALLBACK_VENDORS.length];
}

function geoTranslate(mx, my, origin) {
  const lat = origin.lat + my * 0.000009;
  const lon = origin.lon + mx * (0.000009 / Math.cos(origin.lat * Math.PI / 180));
  return { lat, lon };
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

module.exports = {
  KalmanFilter, KalmanFilter2D,
  rssiToDistance, distanceToRssi,
  solveTrilateration, solveTriangulationSines,
  lookupMacVendor, geoTranslate, haversineDistance,
};
