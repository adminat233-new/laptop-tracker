const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const networkUtils = require('./network-utils');

class LocationTracker {
  constructor() {
    this.lastKnownLocation = null;
    this.locationMethod = null;
  }

  async getLocation() {
    // Try multiple methods in order of accuracy
    try {
      const location = await this.getIPLocation();
      this.lastKnownLocation = location;
      this.locationMethod = 'ip';
      return location;
    } catch (error) {
      console.error('IP location failed:', error.message);
    }

    // Fallback to network scan estimation
    try {
      const location = await this.getNetworkLocation();
      this.lastKnownLocation = location;
      this.locationMethod = 'network';
      return location;
    } catch (error) {
      console.error('Network location failed:', error.message);
    }

    // Return last known or default
    return this.lastKnownLocation || {
      lat: 0,
      lng: 0,
      accuracy: 'unknown',
      method: 'unavailable',
      city: 'Unknown',
      country: 'Unknown'
    };
  }

  async getIPLocation() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'ipapi.co',
        port: 443,
        path: '/json/',
        method: 'GET',
        timeout: 5000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.latitude && json.longitude) {
              resolve({
                lat: json.latitude,
                lng: json.longitude,
                accuracy: 'city-level',
                method: 'ip-geolocation',
                city: json.city,
                region: json.region,
                country: json.country_name,
                ip: json.ip,
                org: json.org
              });
            } else {
              reject(new Error('No coordinates in response'));
            }
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.end();
    });
  }

  async getNetworkLocation() {
    try {
      const networkInfo = await networkUtils.scanNetwork();
      const localIP = networkInfo.localIP;

      // Estimate location based on local network info
      return {
        lat: 0,
        lng: 0,
        accuracy: 'network-level',
        method: 'network-scan',
        localIP: localIP,
        gateway: networkInfo.gateway,
        networkRange: networkInfo.networkRange,
        devicesFound: networkInfo.devices ? networkInfo.devices.length : 0,
        note: 'Geographical location unavailable. Network info captured for tracking.'
      };
    } catch (error) {
      throw error;
    }
  }

  async getWifiLocation() {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        exec('netsh wlan show networks mode=bssid', (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }

          const networks = [];
          const lines = stdout.split('\n');
          let currentNetwork = null;

          for (const line of lines) {
            if (line.includes('SSID')) {
              currentNetwork = { ssid: line.split(':')[1]?.trim() };
            } else if (line.includes('BSSID') && currentNetwork) {
              currentNetwork.bssid = line.split(':')[1]?.trim();
            } else if (line.includes('Signal') && currentNetwork) {
              currentNetwork.signal = line.split(':')[1]?.trim();
              networks.push(currentNetwork);
              currentNetwork = null;
            }
          }

          resolve({
            networks,
            method: 'wifi-scan',
            note: 'WiFi networks detected. Use with WiFi location services for better accuracy.'
          });
        });
      } else {
        reject(new Error('WiFi scanning not supported on this platform'));
      }
    });
  }

  getLastKnownLocation() {
    return this.lastKnownLocation;
  }

  getLocationMethod() {
    return this.locationMethod;
  }
}

module.exports = new LocationTracker();
