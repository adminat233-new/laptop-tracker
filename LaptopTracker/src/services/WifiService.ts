import { Platform, PermissionsAndroid } from 'react-native';
import WifiManager from 'react-native-wifi-reborn';

export interface WifiNetwork {
  ssid: string;
  bssid: string;
  rssi: number;
  frequency: number;
  distance?: number;
}

class WifiServiceClass {
  private isScanning = false;

  async requestPermission(): Promise<boolean> {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_WIFI_STATE,
        PermissionsAndroid.PERMISSIONS.CHANGE_WIFI_STATE
      ]);
      return Object.values(granted).every(
        result => result === PermissionsAndroid.RESULTS.GRANTED
      );
    }
    return true;
  }

  async scanNetworks(): Promise<WifiNetwork[]> {
    const hasPermission = await this.requestPermission();
    if (!hasPermission) {
      throw new Error('WiFi permission denied');
    }

    this.isScanning = true;

    try {
      await WifiManager.forceWifiUsage(true);
      const networks = await WifiManager.loadWifiList();
      
      return networks.map(network => ({
        ssid: network.SSID || 'Unknown',
        bssid: network.BSSID,
        rssi: network.level,
        frequency: network.frequency,
        distance: this.calculateDistance(network.level, network.frequency)
      }));
    } catch (error) {
      console.error('WiFi scan failed:', error);
      return [];
    } finally {
      this.isScanning = false;
      await WifiManager.forceWifiUsage(false);
    }
  }

  private calculateDistance(rssi: number, frequency: number): number {
    const exp = (27.55 - (20 * Math.log10(frequency)) + Math.abs(rssi)) / 20;
    return Math.pow(10, exp);
  }

  async getCurrentNetwork(): Promise<{ ssid: string; bssid: string } | null> {
    try {
      const ssid = await WifiManager.getCurrentWifiSSID();
      return { ssid, bssid: '' };
    } catch (error) {
      console.error('Failed to get current network:', error);
      return null;
    }
  }

  isCurrentlyScanning(): boolean {
    return this.isScanning;
  }
}

export const WifiService = new WifiServiceClass();