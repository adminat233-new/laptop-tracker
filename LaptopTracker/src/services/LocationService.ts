import { Platform, PermissionsAndroid } from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import { ServerService } from './ServerService';

const LOCATION_INTERVAL = 5000;
const BG_LOCATION_INTERVAL = 15000;

export class LocationService {
  private static watchId: number | null = null;
  private static bgTimer: ReturnType<typeof setInterval> | null = null;
  private static lastLocation: any = null;

  static async startTracking(deviceId: string, deviceType: string, serverService: ServerService) {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
      ]);
      if (granted['android.permission.ACCESS_FINE_LOCATION'] !== 'granted') {
        console.log('[Location] Permission denied');
        return;
      }
    }

    LocationService.watchId = Geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy, speed, heading } = pos.coords;
        const loc = {
          lat: latitude,
          lng: longitude,
          intLat: Math.round(latitude * 1000000),
          intLng: Math.round(longitude * 1000000),
          accuracy: accuracy || 10,
          speed: speed || 0,
          heading: heading || 0,
          source: 'gps',
        };
        LocationService.lastLocation = loc;
        serverService.sendLocation(loc);
      },
      (err) => console.log('[Location] Error:', err.message),
      {
        enableHighAccuracy: true,
        distanceFilter: 5,
        interval: LOCATION_INTERVAL,
        fastestInterval: 2000,
        showLocationDialog: true,
        forceRequestLocation: true,
      }
    );

    LocationService.bgTimer = setInterval(() => {
      if (LocationService.lastLocation) {
        serverService.sendHeartbeat(LocationService.lastLocation, { type: deviceType });
      }
    }, BG_LOCATION_INTERVAL);
  }

  static stopTracking() {
    if (LocationService.watchId !== null) {
      Geolocation.clearWatch(LocationService.watchId);
      LocationService.watchId = null;
    }
    if (LocationService.bgTimer) {
      clearInterval(LocationService.bgTimer);
      LocationService.bgTimer = null;
    }
  }

  static getLastLocation() {
    return LocationService.lastLocation;
  }
}
