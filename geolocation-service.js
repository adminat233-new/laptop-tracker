const https = require('https');

/**
 * GeolocationService
 * Handles resolving location from WiFi/Cell/Bluetooth signals via external APIs.
 */
class GeolocationService {
    constructor() {
        this.googleApiKey = process.env.GOOGLE_GEO_API_KEY || '';
    }

    async resolveFromWifi(wifiSignals, gatewayMac = null) {
        if ((!wifiSignals || wifiSignals.length === 0) && !gatewayMac) return null;

        if (this.googleApiKey) {
            const result = await this.callGoogleGeo(wifiSignals, gatewayMac);
            if (result) return result;
        }

        return this.callIpApi();
    }

    async callGoogleGeo(wifiSignals, gatewayMac) {
        return new Promise((resolve) => {
            const wifiPoints = (wifiSignals || []).map(s => ({
                macAddress: s.bssid,
                signalStrength: s.rssi || s.signal,
                channel: s.channel || 0
            }));

            if (gatewayMac && !wifiPoints.find(p => p.macAddress === gatewayMac)) {
                wifiPoints.unshift({ macAddress: gatewayMac, signalStrength: -30 });
            }

            const postData = JSON.stringify({
                considerIp: "true",
                wifiAccessPoints: wifiPoints
            });

            const options = {
                hostname: 'www.googleapis.com',
                port: 443,
                path: `/geolocation/v1/geolocate?key=${this.googleApiKey}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': postData.length
                },
                timeout: 8000
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (d) => data += d);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.location) {
                            resolve({
                                lat: json.location.lat,
                                lng: json.location.lng,
                                accuracy: json.accuracy,
                                source: 'google-geo-fused'
                            });
                        } else resolve(null);
                    } catch (e) { resolve(null); }
                });
            });

            req.on('error', () => resolve(null));
            req.write(postData);
            req.end();
        });
    }

    async callIpApi() {
        return new Promise((resolve) => {
            https.get('https://ipapi.co/json/', (res) => {
                let data = '';
                res.on('data', (d) => data += d);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.latitude) {
                            resolve({
                                lat: json.latitude,
                                lng: json.longitude,
                                accuracy: 5000,
                                source: 'ip-geo-fallback'
                            });
                        } else resolve(null);
                    } catch (e) { resolve(null); }
                });
            }).on('error', () => resolve(null));
        });
    }
}

module.exports = new GeolocationService();
