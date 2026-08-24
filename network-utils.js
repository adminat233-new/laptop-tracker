const { exec } = require('child_process');
const os = require('os');
const net = require('net');

class NetworkUtils {
  constructor() {
    this.networkInfo = null;
  }

  getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  getGateway() {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        exec('ipconfig', (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }

          const gatewayMatch = stdout.match(/Default Gateway[\s.:]+(\d+\.\d+\.\d+\.\d+)/);
          resolve(gatewayMatch ? gatewayMatch[1] : null);
        });
      } else {
        exec('route -n get default 2>/dev/null || netstat -rn | grep default', (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }

          const gatewayMatch = stdout.match(/(\d+\.\d+\.\d+\.\d+)/);
          resolve(gatewayMatch ? gatewayMatch[1] : null);
        });
      }
    });
  }

  ping(target, timeout = 3) {
    return new Promise((resolve, reject) => {
      const pingCmd = process.platform === 'win32'
        ? `ping -n 1 -w ${timeout * 1000} ${target}`
        : `ping -c 1 -W ${timeout} ${target}`;

      exec(pingCmd, (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(`Ping failed: ${stderr || error.message}`));
          return;
        }

        const isAlive = !error;
        const latencyMatch = stdout.match(/time[=<](\d+\.?\d*)/i);
        const ttlMatch = stdout.match(/ttl=(\d+)/i);

        resolve({
          target,
          isAlive,
          latency: latencyMatch ? parseFloat(latencyMatch[1]) : null,
          ttl: ttlMatch ? parseInt(ttlMatch[1]) : null,
          raw: stdout
        });
      });
    });
  }

  scanNetwork() {
    return new Promise(async (resolve, reject) => {
      const localIP = this.getLocalIP();
      const subnet = localIP.split('.').slice(0, 3).join('.');

      try {
        const gateway = await this.getGateway();

        // Quick scan of common devices in subnet
        const devices = [];
        const scanPromises = [];

        for (let i = 1; i <= 254; i++) {
          const ip = `${subnet}.${i}`;
          if (ip === localIP) continue;

          scanPromises.push(
            this.ping(ip, 1)
              .then(result => {
                if (result.isAlive) {
                  devices.push({
                    ip,
                    hostname: result.raw.match(/from\s+(\S+)/)?.[1] || ip,
                    status: 'alive'
                  });
                }
              })
              .catch(() => {})
          );
        }

        // Scan gateway separately with more detail
        if (gateway) {
          await this.ping(gateway, 2).catch(() => {});
        }

        // Wait for scan to complete (limit to 10 seconds)
        await Promise.race([
          Promise.all(scanPromises),
          new Promise(resolve => setTimeout(resolve, 10000))
        ]);

        // Get DNS info
        const dnsInfo = await this.getDNSInfo().catch(() => null);

        // Get public IP
        const publicIP = await this.getPublicIP().catch(() => null);

        this.networkInfo = {
          localIP,
          publicIP,
          gateway,
          subnet: `${subnet}.0/24`,
          networkRange: `${subnet}.1-${subnet}.254`,
          devices,
          dnsInfo,
          scanTime: new Date().toISOString()
        };

        resolve(this.networkInfo);

      } catch (error) {
        reject(error);
      }
    });
  }

  getDNSInfo() {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        exec('ipconfig /all', (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }

          const dnsServers = [];
          const lines = stdout.split('\n');
          for (const line of lines) {
            if (line.includes('DNS Servers')) {
              const match = line.match(/(\d+\.\d+\.\d+\.\d+)/);
              if (match) dnsServers.push(match[1]);
            }
          }

          resolve({ servers: dnsServers });
        });
      } else {
        exec('cat /etc/resolv.conf 2>/dev/null || systemd-resolve --status 2>/dev/null', (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }

          const dnsServers = [];
          const lines = stdout.split('\n');
          for (const line of lines) {
            if (line.includes('nameserver')) {
              const match = line.match(/nameserver\s+(\S+)/);
              if (match) dnsServers.push(match[1]);
            }
          }

          resolve({ servers: dnsServers });
        });
      }
    });
  }

  getPublicIP() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.ipify.org',
        port: 443,
        path: '/?format=json',
        method: 'GET',
        timeout: 5000
      };

      const https = require('https');
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.ip);
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });

      req.end();
    });
  }

  async getNetworkLatency(target) {
    const result = await this.ping(target, 3);
    return result.latency;
  }

  async isPortOpen(host, port, timeout = 2) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let isOpen = false;

      socket.setTimeout(timeout * 1000);

      socket.on('connect', () => {
        isOpen = true;
        socket.destroy();
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, host);
    });
  }

  async scanPorts(host, ports = [80, 443, 22, 21, 8080, 3389]) {
    const results = [];
    for (const port of ports) {
      const isOpen = await this.isPortOpen(host, port);
      results.push({ port, isOpen });
    }
    return results;
  }
}

module.exports = new NetworkUtils();
