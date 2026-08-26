/**
 * ULTIMATE FORENSIC FUSION ENGINE (TTAL v8.5 - PRODUCTION)
 * Total Trilateration and Location (TTAL) Algorithm
 * 
 * Logic: Merges multiple forensic sensors using a Weighted Kalman Consensus.
 */

/**
 * ULTIMATE FORENSIC FUSION ENGINE (TTAL v9.0 - ADAPTIVE)
 * Total Trilateration and Location (TTAL) Algorithm
 *
 * Logic: Adaptive weighted consensus with path prediction and signal reliability learning.
 */

class KalmanFilter {
    constructor(q = 0.000001, r = 0.0001) {
        this.q = q; this.r = r; this.x = null; this.p = 1;
    }
    update(z) {
        if (this.x === null) { this.x = z; return this.x; }
        this.p = this.p + this.q;
        const k = this.p / (this.p + this.r);
        this.x = this.x + k * (z - this.x);
        this.p = (1 - k) * this.p;
        return this.x;
    }
}

class UltimateFusionBrain {
    constructor() {
        this.latFilter = new KalmanFilter(0.000005, 0.00005);
        this.lngFilter = new KalmanFilter(0.000005, 0.00005);
        this.weights = {
            'windows-gps': 0.99,
            'phone-gps': 0.95,
            'wifi-fingerprint': 0.88,
            'network-gateway': 0.70,
            'ip-geo': 0.20
        };
        this.lastFix = null;
        this.history = [];
    }

    /**
     * TTAL v9.0 FUSION ALGORITHM
     */
    fuse(inputs, reliabilityMap = {}) {
        if (!inputs || inputs.length === 0) return this.lastFix;

        let totalLat = 0, totalLng = 0, weightSum = 0;
        let weightedAccuracy = 0;
        let bestSource = 'unknown';
        let maxWeight = -1;

        inputs.forEach(input => {
            let reliability = this.weights[input.source] || 0.5;

            // Adaptive: Adjust by learned reliability if provided
            if (input.identifier && reliabilityMap[input.identifier]) {
                reliability *= reliabilityMap[input.identifier];
            }

            const accMetric = Math.max(1, input.accuracy || 100);
            const accWeight = 1 / (accMetric * accMetric); // Inverse square for sharper accuracy
            
            const finalWeight = reliability * accWeight;

            totalLat += input.lat * finalWeight;
            totalLng += input.lng * finalWeight;
            weightSum += finalWeight;
            weightedAccuracy += accMetric * finalWeight;

            if (finalWeight > maxWeight) {
                maxWeight = finalWeight;
                bestSource = input.source;
            }
        });

        if (weightSum === 0) return inputs[0];

        let fusedLat = totalLat / weightSum;
        let fusedLng = totalLng / weightSum;

        // Path Prediction Layer: Reject Outliers
        if (this.lastFix && this.history.length > 2) {
            const timeDiff = (Date.now() - this.lastFix.timestamp) / 1000;
            if (timeDiff > 0 && timeDiff < 60) {
                const dist = this.haversine(this.lastFix.lat, this.lastFix.lng, fusedLat, fusedLng);
                const speed = dist / timeDiff; // meters per second
                if (speed > 50) { // Reject if moving > 180km/h (likely GPS jump)
                    fusedLat = this.lastFix.lat;
                    fusedLng = this.lastFix.lng;
                }
            }
        }

        this.lastFix = {
            lat: this.latFilter.update(fusedLat),
            lng: this.lngFilter.update(fusedLng),
            accuracy: Math.max(2, weightedAccuracy / weightSum),
            confidence: Math.min(100, Math.round(weightSum * 100000)),
            timestamp: Date.now(),
            source: `TTAL-v9.0 (${bestSource})`
        };

        this.history.push(this.lastFix);
        if (this.history.length > 50) this.history.shift();

        return this.lastFix;
    }

    haversine(lat1, lon1, lat2, lon2) {
        const R = 6371e3;
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ/2) * Math.sin(Δλ/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }
}

/**
 * 3-POINT TRILATERATION
 * Solves for X,Y coordinate based on 3 signal distances (RSSI).
 */
function solveTrilateration(beacons) {
    if (beacons.length < 3) return null;
    const [p1, p2, p3] = beacons;
    const x21 = p2.x - p1.x, y21 = p2.y - p1.y;
    const x31 = p3.x - p1.x, y31 = p3.y - p1.y;
    const d21 = x21*x21 + y21*y21;
    const d31 = x31*x31 + y31*y31;
    const r1sq = p1.distance**2, r2sq = p2.distance**2, r3sq = p3.distance**2;
    const det = x21 * y31 - x31 * y21;
    if (Math.abs(det) < 1e-10) return null;
    const c1 = (r1sq - r2sq + d21) / 2;
    const c2 = (r1sq - r3sq + d31) / 2;
    const dx = (c1 * y31 - c2 * y21) / det;
    const dy = (x21 * c2 - x31 * c1) / det;
    return { lat: p1.x + dx, lng: p1.y + dy };
}

module.exports = {
    UltimateFusionBrain,
    solveTrilateration,
    rssiToMeters: (rssi, p0 = -59, n = 3.0) => Math.pow(10, (p0 - rssi) / (10 * n)),
    lookupMacVendor: (mac) => {
        const clean = mac.replace(/[^a-fA-F0-9]/g, '').substring(0,6).toUpperCase();
        const v = {'00155D':'Microsoft','3C22FB':'Apple','B827EB':'Raspberry','7C11CB':'Apple'};
        return v[clean] || 'Node';
    }
};
