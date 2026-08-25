import { Platform, PermissionsAndroid } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';

export interface BleDevice {
  id: string;
  name: string | null;
  rssi: number;
  vendor: string;
  isTracker: boolean;
  distance?: number;
}

const TRACKER_MANUFACTURERS = [
  { id: 76, name: 'Apple (AirTag)' },
  { id: 224, name: 'Samsung (SmartTag)' },
  { id: 76, name: 'Tile' }
];

class BleServiceClass {
  private manager: BleManager;
  private isScanning = false;
  private scannedDevices: Map<string, BleDevice> = new Map();
  private onDeviceCallback: ((device: BleDevice) => void) | null = null;

  constructor() {
    this.manager = new BleManager();
  }

  async requestPermission(): Promise<boolean> {
    if (Platform.OS === 'android') {
      const apiLevel = Platform.Version;
      
      if (apiLevel >= 31) {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        ]);
        return Object.values(granted).every(
          result => result === PermissionsAndroid.RESULTS.GRANTED
        );
      } else {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      }
    }
    return true;
  }

  async startScanning(duration: number = 10000): Promise<BleDevice[]> {
    const hasPermission = await this.requestPermission();
    if (!hasPermission) {
      throw new Error('BLE permission denied');
    }

    this.isScanning = true;
    this.scannedDevices.clear();

    await this.manager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
      if (error) {
        console.error('BLE scan error:', error);
        return;
      }

      if (device) {
        const bleDevice = this.processDevice(device);
        this.scannedDevices.set(device.id, bleDevice);
        this.onDeviceCallback?.(bleDevice);
      }
    });

    await new Promise(resolve => setTimeout(resolve, duration));
    this.stopScanning();

    return Array.from(this.scannedDevices.values());
  }

  private processDevice(device: Device): BleDevice {
    const isTracker = this.detectTracker(device);
    const vendor = this.getVendor(device);
    const distance = device.rssi ? this.calculateDistance(device.rssi) : undefined;

    return {
      id: device.id,
      name: device.name || 'Unknown Device',
      rssi: device.rssi || 0,
      vendor,
      isTracker,
      distance
    };
  }

  private detectTracker(device: Device): boolean {
    if (device.serviceUUIDs?.some(uuid => uuid.includes('fff0'))) return true;
    if (device.serviceUUIDs?.some(uuid => uuid.includes('feaa'))) return true;
    if (device.localName?.toLowerCase().includes('airtag')) return true;
    if (device.localName?.toLowerCase().includes('tile')) return true;
    if (device.localName?.toLowerCase().includes('smarttag')) return true;
    return false;
  }

  private getVendor(device: Device): string {
    if (device.localName?.toLowerCase().includes('airtag')) return 'Apple (AirTag)';
    if (device.localName?.toLowerCase().includes('tile')) return 'Tile';
    if (device.localName?.toLowerCase().includes('smarttag')) return 'Samsung (SmartTag)';
    if (device.localName?.toLowerCase().includes('apple')) return 'Apple';
    if (device.localName?.toLowerCase().includes('samsung')) return 'Samsung';
    if (device.localName?.toLowerCase().includes('google')) return 'Google';
    return 'Unknown';
  }

  private calculateDistance(rssi: number): number {
    const txPower = -59;
    if (rssi === 0) return -1;
    const ratio = rssi / txPower;
    if (ratio < 1.0) return Math.pow(ratio, 10);
    return (0.89976 * Math.pow(ratio, 7.7095) + 0.111);
  }

  stopScanning() {
    this.isScanning = false;
    this.manager.stopDeviceScan();
  }

  onDevice(callback: (device: BleDevice) => void) {
    this.onDeviceCallback = callback;
  }

  getScannedDevices(): BleDevice[] {
    return Array.from(this.scannedDevices.values());
  }

  isCurrentlyScanning(): boolean {
    return this.isScanning;
  }

  destroy() {
    this.manager.destroy();
  }
}

export const BleService = new BleServiceClass();