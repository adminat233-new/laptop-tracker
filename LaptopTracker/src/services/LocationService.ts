import { Platform, PermissionsAndroid, Alert } from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import { ServerService } from './ServerService';
import AsyncStorage from '@react-native-async-storage/async-storage';

const LOCATION_CONFIG = {
  enableHighAccuracy: true,
  distanceFilter: 0, 
  interval: 3000,
  fastestInterval: 1000,
  showLocationDialog: true,
  forceRequestLocation: true,
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
  source: 'windows-gps' | 'phone-gps' | 'wifi-trilateration' | 'ip-geo' | 'network-topology' | 'inertial-prediction';
  timestamp: number;
  heading?: number;
}

/**
 * KALMAN FILTER - SENSOR SMOOTHING ENGINE
 * Filters out jitter and noise from forensic signal data.
 */
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
  
  // Advanced Fusion Brain State
  private static latFilter = new KalmanFilter(0.0000001, 0.00001);
  private static lngFilter = new KalmanFilter(0.0000001, 0.00001);
  private static speedFilter = new KalmanFilter(0.01, 0.1);
  
  private static sourceWeights: { [key: string]: number } = {
    'windows-gps': 0.99,
    'phone-gps': 0.95,
    'wifi-trilateration': 0.85,
    'network-topology': 0.60,
    'ip-geo': 0.20,
    'inertial-prediction': 0.50
  };

  static async showAgreement(): Promise<boolean> {
    return new Promise((resolve) => {
      Alert.alert(
        'Guardian Ultimate - Secure Uplink Agreement',
        'You are about to establish a secure telemetry uplink with the target node. This professional recovery suite includes:\n\n' +
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
    const status = await AsyncStorage.getItem('user_agreement_accepted');
    if (status !== 'true') {
      const accepted = await this.showAgreement();
      if (!accepted) return false;
    }

    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
      ]);
      return granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true;
  }

  /**
   * INERTIAL DEAD RECKONING
   */
  static predictNextCoordinate(last: any, dtSeconds: number): any {
    if (!last || !last.speed) return last;
    const R = 6371e3;
    const distance = last.speed * dtSeconds;
    const bearing = (last.heading || 0) * Math.PI / 180;
    const lat1 = last.lat * Math.PI / 180;
    const lon1 = last.lng * Math.PI / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance/R) + Math.cos(lat1) * Math.sin(distance/R) * Math.cos(bearing));
    const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(distance/R) * Math.cos(lat1), Math.cos(distance/R) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: lat2 * 180 / Math.PI, lng: lon2 * 180 / Math.PI, accuracy: (last.accuracy || 10) + (distance * 0.5), source: 'inertial-prediction' };
  }

  /**
   * SMART SELF-LEARNING FUSION BRAIN (TTAL Logic)
   */
  static fusePreciseCoordinate(inputs: FusionInput[]): any {
    if (!inputs.length) {
        if (this.lastLocation) {
            const dt = (Date.now() - this.lastLocation.timestamp) / 1000;
            if (dt < 60) return this.predictNextCoordinate(this.lastLocation, dt);
        }
        return this.lastLocation;
    }

    let totalLat = 0, totalLng = 0, weightSum = 0;
    let combinedAccuracy = 0;
    const now = Date.now();

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

    const filteredLat = this.latFilter.update(totalLat / weightSum);
    const filteredLng = this.lngFilter.update(totalLng / weightSum);

    const result = {
      lat: filteredLat,
      lng: filteredLng,
      accuracy: Math.max(2, combinedAccuracy / weightSum),
      speed: inputs[0].speed || 0,
      heading: inputs[0].heading || 0,
      source: 'TTAL-v9.0-Mobile',
      timestamp: now,
      confidence: Math.min(100, Math.round(weightSum * 1000000))
    };

    this.lastLocation = result;
    return result;
  }

  static async startTracking(deviceId: string, type: string, svc: ServerService) {
    const hasPermission = await this.requestPermissions();
    if (!hasPermission) return;

    this.watchId = Geolocation.watchPosition(
      (pos) => {
        const input: FusionInput = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          speed: pos.coords.speed || 0,
          heading: pos.coords.heading || 0,
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

  static stopTracking() {
    if (this.watchId !== null) Geolocation.clearWatch(this.watchId);
  }

  static getLastLocation() { return this.lastLocation; }

  // ─── Forensic Tools ───────────────────────────────────────────────

  static solveForensicTrilateration(beacons: Beacon[]): { x: number; y: number } | null {
    if (beacons.length < 3) return null;
    try {
      const [b1, b2, b3] = beacons;
      const A = 2 * (b2.x - b1.x), B = 2 * (b2.y - b1.y);
      const C = b1.distance**2 - b2.distance**2 - b1.x**2 + b2.x**2 - b1.y**2 + b2.y**2;
      const D = 2 * (b3.x - b2.x), E = 2 * (b3.y - b2.y);
      const F = b2.distance**2 - b3.distance**2 - b2.x**2 + b3.x**2 - b2.y**2 + b3.y**2;
      const x = (C*E - F*B) / (E*A - B*D), y = (C*D - A*F) / (B*D - A*E);
      return (isNaN(x) || isNaN(y)) ? null : { x, y };
    } catch (e) { return null; }
  }

  static rssiToMeters(rssi: number): number {
    return Math.pow(10, (-59 - rssi) / (10 * 3.0));
  }
}
