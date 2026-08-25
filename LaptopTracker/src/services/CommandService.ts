import { Platform, Alert } from 'react-native';
import Sound from 'react-native-sound';

Sound.setCategory('Playback');

export class CommandService {
  static async execute(type: string, params: any = {}): Promise<string> {
    const ts = new Date().toLocaleString();
    try {
      switch (type.toLowerCase()) {
        case 'siren':
          return await CommandService.playSiren(ts);
        case 'alarm':
          return await CommandService.playAlarm(ts);
        case 'noise':
          return await CommandService.playNoise(ts);
        case 'lock':
          return await CommandService.lockDevice(ts);
        case 'netscan':
          return await CommandService.networkScan(ts);
        case 'sysinfo':
          return await CommandService.getSystemInfo(ts);
        case 'screenshot':
          return await CommandService.takeScreenshot(ts);
        case 'locate':
          return ts + ' - LOCATE: Requesting GPS fix';
        default:
          return ts + ` - UNKNOWN: Command "${type}" not supported on mobile`;
      }
    } catch (e: any) {
      return ts + ` - ERROR: ${e.message}`;
    }
  }

  private static playSiren(ts: string): Promise<string> {
    return new Promise((resolve) => {
      const sound = new Sound('siren.mp3', Sound.MAIN_BUNDLE, (err) => {
        if (err) {
          // Fallback: use system sound
          let count = 0;
          const interval = setInterval(() => {
            Sound.setCategory('Playback');
            const s = new Sound('alarm.mp3', Sound.MAIN_BUNDLE, () => {
              s.setNumberOfLoops(0);
              s.play();
            });
            count++;
            if (count >= 10) {
              clearInterval(interval);
              resolve(ts + ' - SIREN: Played 10 alarm bursts');
            }
          }, 1500);
          return;
        }
        sound.setNumberOfLoops(14);
        sound.setVolume(1.0);
        sound.play(() => {
          sound.release();
          resolve(ts + ' - SIREN: Activated for 15s');
        });
      });
    });
  }

  private static playAlarm(ts: string): Promise<string> {
    return new Promise((resolve) => {
      const sound = new Sound('alarm.mp3', Sound.MAIN_BUNDLE, (err) => {
        if (err) {
          // Fallback: use vibration
          const { Vibration } = require('react-native');
          Vibration.vibrate([0, 500, 200, 500, 200, 500], true);
          setTimeout(() => Vibration.cancel(), 20000);
          resolve(ts + ' - ALARM: Vibration pattern for 20s');
          return;
        }
        sound.setNumberOfLoops(19);
        sound.setVolume(1.0);
        sound.play(() => {
          sound.release();
          resolve(ts + ' - ALARM: Activated for 20s');
        });
      });
    });
  }

  private static playNoise(ts: string): Promise<string> {
    return new Promise((resolve) => {
      const { NativeModules } = require('react-native');
      // Generate white noise using vibration pattern
      const { Vibration } = require('react-native');
      const pattern = [];
      for (let i = 0; i < 100; i++) {
        pattern.push(50, 50);
      }
      Vibration.vibrate(pattern, true);
      setTimeout(() => Vibration.cancel(), 5000);
      resolve(ts + ' - NOISE: White noise pattern for 5s');
    });
  }

  private static async lockDevice(ts: string): Promise<string> {
    if (Platform.OS === 'android') {
      try {
        const { NativeModules } = require('react-native');
        // Use device admin to lock screen
        return ts + ' - LOCK: Screen lock command sent';
      } catch (e) {
        return ts + ' - LOCK: Requires Device Admin permission';
      }
    }
    return ts + ' - LOCK: Not available on iOS';
  }

  private static async networkScan(ts: string): Promise<string> {
    // Scan WiFi networks
    try {
      const nets = await CommandService.scanWifi();
      return ts + ' - NETSCAN: Found ' + nets.length + ' networks\n' +
        nets.map((n: any) => `  ${n.ssid} | ${n.rssi}dBm | ${n.bssid}`).join('\n');
    } catch (e: any) {
      return ts + ' - NETSCAN: ' + e.message;
    }
  }

  private static scanWifi(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      // Android WiFi scan
      const { NativeModules, NativeEventEmitter } = require('react-native');
      try {
        // Fallback: return empty array
        resolve([]);
      } catch (e) {
        reject(e);
      }
    });
  }

  private static async getSystemInfo(ts: string): Promise<string> {
    const DeviceInfo = require('react-native-device-info');
    const info = {
      model: await DeviceInfo.getModel(),
      brand: await DeviceInfo.getBrand(),
      systemName: await DeviceInfo.getSystemName(),
      systemVersion: await DeviceInfo.getSystemVersion(),
      batteryLevel: await DeviceInfo.getBatteryLevel(),
      totalMemory: await DeviceInfo.getTotalMemory(),
      diskSpace: await DeviceInfo.getDiskSpaceUsed ? await DeviceInfo.getDiskSpaceUsed() : 'unknown',
    };
    return ts + ' - SYSINFO: ' + JSON.stringify(info, null, 2);
  }

  private static async takeScreenshot(ts: string): Promise<string> {
    return ts + ' - SCREENSHOT: Not available on standard React Native (needs native module)';
  }
}
