import { Platform, PermissionsAndroid, Alert } from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import { ServerService } from './ServerService';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BackgroundService from 'react-native-background-actions';

const LOCATION_CONFIG = {
  enableHighAccuracy: true,
  distanceFilter: 0, 
  interval: 3000,
  fastestInterval: 1000,
  showLocationDialog: true,
  forceRequestLocation: true,
};

const backgroundOptions = {
    taskName: 'GuardianTracker',
    taskTitle: 'Haulix Intelligence Active',
    taskDesc: 'Monitoring fleet telemetry in background',
    taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    color: '#d4ff3f',
    parameters: { delay: 10000 },
};

export interface Beacon {
  x: number;
  y: number;
  distance: number;
  rssi?: number;
}

export interface FusionInput {
  lat: number;
  lng: number;
  accuracy: number;
  speed: number;
  source: string;
  timestamp: number;
  heading?: number;
}

class KalmanFilter {
  private q: number; 
  private r: number; 
  private x: number | null = null; 
  private p: number = 1; 

  constructor(q: number = 0.0001, r: number = 0.001) {
    this.q = q;
    this.r = r;
  }

  update(measurement: number): number {
    if (this.x === null) {
      this.x = measurement;
      return this.x;
    }
    this.p = this.p + this.q;
    const k = this.p / (this.p + this.r);
    this.x = this.x + k * (measurement - this.x);
    this.p = (1 - k) * this.p;
    return this.x;
  }
}

export class LocationService {
  private static watchId: number | null = null;
  private static lastLocation: any = null;
  private static isRunning = false;
  
  private static latFilter = new KalmanFilter(0.0000001, 0.00001);
  private static lngFilter = new KalmanFilter(0.0000001, 0.00001);

  private static sourceWeights: { [key: string]: number } = {
    'windows-gps': 0.99,
    'phone-gps': 0.95,
    'wifi-trilateration': 0.85,
    'ip-geo': 0.20
  };

  static async checkUserAgreement(): Promise<boolean> {
    const status = await AsyncStorage.getItem('user_agreement_accepted');
    return status === 'true';
  }

  static async showAgreement(): Promise<boolean> {
    return new Promise((resolve) => {
      Alert.alert(
        'Guardian Ultimate - Secure Uplink Agreement',
        'You are about to establish a secure telemetry uplink. This professional recovery suite includes:\n\n' +
        '• TTAL v9.0 Multi-Path Signal Fusion\n' +
        '• Advanced DNS & Network Forensics\n' +
        '• Real-time Intelligence Streaming\n' +
        '• Remote Hardware Lock & Control\n\n' +
        'By proceeding, you confirm you are authorized to monitor this device.',
        [
          { text: 'Decline', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Accept Authorization', onPress: async () => {
              await AsyncStorage.setItem('user_agreement_accepted', 'true');
              resolve(true);
            }
          },
        ]
      );
    });
  }

  static async requestPermissions(): Promise<boolean> {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
      ]);
      return granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true;
  }

  static fusePreciseCoordinate(inputs: FusionInput[]): any {
    if (!inputs.length) return this.lastLocation;

    let totalLat = 0, totalLng = 0, weightSum = 0;
    let combinedAccuracy = 0;

    inputs.forEach(input => {
      let reliability = this.sourceWeights[input.source] || 0.5;
      const accMetric = Math.max(1, input.accuracy || 100);
      const accWeight = 1 / (accMetric * accMetric);
      const finalWeight = reliability * accWeight;
      totalLat += input.lat * finalWeight;
      totalLng += input.lng * finalWeight;
      weightSum += finalWeight;
      combinedAccuracy += accMetric * finalWeight;
    });

    if (weightSum === 0) return inputs[0];

    const result = {
      lat: this.latFilter.update(totalLat / weightSum),
      lng: this.lngFilter.update(totalLng / weightSum),
      accuracy: Math.max(2, combinedAccuracy / weightSum),
      speed: inputs[0].speed || 0,
      source: 'TTAL-v9.0-Mobile',
      timestamp: Date.now(),
      confidence: Math.min(100, Math.round(weightSum * 1000000))
    };

    this.lastLocation = result;
    return result;
  }

  static async startTracking(deviceId: string, type: string, svc: ServerService) {
    if (this.isRunning) return;
    const hasPermission = await this.requestPermissions();
    if (!hasPermission) return;

    this.isRunning = true;

    await BackgroundService.start(async (taskData) => {
        await new Promise(async () => {
            while (BackgroundService.isRunning()) {
                Geolocation.getCurrentPosition(
                    (pos) => {
                        const input: FusionInput = {
                          lat: pos.coords.latitude,
                          lng: pos.coords.longitude,
                          accuracy: pos.coords.accuracy,
                          speed: pos.coords.speed || 0,
                          source: 'phone-gps',
                          timestamp: pos.timestamp,
                        };
                        const precise = this.fusePreciseCoordinate([input]);
                        svc.sendLocation(precise);
                    },
                    (err) => console.log('BG Geo Error:', err),
                    LOCATION_CONFIG
                );
                await new Promise(r => setTimeout(r, taskData!.delay));
            }
        });
    }, backgroundOptions);

    this.watchId = Geolocation.watchPosition(
      (pos) => {
        const input: FusionInput = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          speed: pos.coords.speed || 0,
          source: 'phone-gps',
          timestamp: pos.timestamp,
        };
        const precise = this.fusePreciseCoordinate([input]);
        svc.sendLocation(precise);
      },
      (err) => console.warn(err),
      LOCATION_CONFIG
    );
  }

  static async stopTracking() {
    this.isRunning = false;
    if (this.watchId !== null) Geolocation.clearWatch(this.watchId);
    await BackgroundService.stop();
  }

  static getLastLocation() { return this.lastLocation; }

  static rssiToMeters(rssi: number): number {
    return Math.pow(10, (-59 - rssi) / (10 * 3.0));
  }
}
