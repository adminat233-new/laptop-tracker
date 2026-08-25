# Laptop Tracker - React Native Android App

Native Android companion app for the Laptop Tracker system.

## Setup

```bash
cd LaptopTracker
npm install
cd android
./gradlew assembleDebug
```

## Features

- **GPS Tracking**: High-accuracy foreground + background location
- **WiFi Scanning**: Detect nearby networks for trilateration
- **BLE Detection**: Find AirTags, Tiles, SmartTags nearby
- **Remote Commands**: Siren, Alarm, Lock, Noise, Scan, Info
- **Real-time Map**: See laptop location on interactive map
- **Background Service**: Continues tracking when app is minimized
- **Boot Restart**: Auto-restarts location service on device boot

## Permissions

| Permission | Purpose |
|------------|---------|
| ACCESS_FINE_LOCATION | GPS tracking |
| ACCESS_BACKGROUND_LOCATION | Track when app is closed |
| ACCESS_WIFI_STATE | WiFi scanning |
| BLUETOOTH_SCAN | BLE device detection |
| CAMERA | Remote screenshot |
| FOREGROUND_SERVICE | Background location |
| RECEIVE_BOOT_COMPLETED | Auto-restart on boot |
| VIBRATE | Alarm/siren vibration |

## Architecture

```
LaptopTracker/
  App.tsx                      # Main app entry
  src/
    services/
      ServerService.ts         # WebSocket + HTTP to cloud
      LocationService.ts       # GPS tracking
      CommandService.ts        # Execute remote commands
    screens/
      PairScreen.tsx           # Code entry for pairing
      DashboardScreen.tsx      # Map + commands UI
      SettingsScreen.tsx       # Device info + unpair
  android/
    app/src/main/
      AndroidManifest.xml      # Permissions
      java/com/laptoptracker/
        LocationForegroundService.java  # Native GPS service
        BootReceiver.java               # Auto-restart
```

## Native Location Service

The `LocationForegroundService` runs as an Android foreground service with:
- `FusedLocationProviderClient` for efficient GPS
- 5-second update interval
- Automatic HTTP heartbeat to server
- Persistent notification (required by Android)
- Survives app minimization
- Restarts on device boot

## Building Release APK

```bash
cd android
./gradlew assembleRelease
# APK at: android/app/build/outputs/apk/release/
```
