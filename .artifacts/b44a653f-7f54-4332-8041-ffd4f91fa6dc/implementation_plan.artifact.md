# Implementation Plan: Laptop Tracker "Haulix" Refactor & Location Enhancement

Refactor the laptop tracking system to adopt the "Haulix" fleet management UI/UX and enhance location tracking capabilities when OS-level location services are disabled.

## User Review Required

> [!IMPORTANT]
> **Google Geolocation API Key**: To enable precise location tracking when OS location is off, we will need a Google Maps Geolocation API key. I will add a placeholder in `agent.js` and `cloud-server.js`.
> **UI Accent Color**: The "Haulix" style uses a distinctive lime-yellow (#d4ff3f). I will apply this as the primary accent color.

## Proposed Changes

### UI/UX Refactoring (Haulix Style)

#### [MODIFY] [index.html](file:///C:/Users/Admin/Documents/Default Project/laptop-tracker/public/index.html)
- Replace the "Guardian Ultimate" cyberpunk theme with the Haulix "Operations Dashboard" layout.
- **Sidebar**: Implement a left-side navigation rail with icons for Dashboard, Map, Devices, and Logs.
- **Top Metrics**: Add a horizontal bar for key fleet stats (Active Laptops, Connected Users, Signal Strength, etc.).
- **Fleet List**: Create a detailed card-based view for laptops, showing status (Active, Idle, Offline), battery, and last known location.
- **Integrated Map**: Embed the Leaflet map into the main dashboard area.
- **Styling**: Update CSS to use dark charcoal backgrounds, minimalist typography (Inter), and lime-yellow accents.

### Location Tracking Enhancements

#### [MODIFY] [agent.js](file:///C:/Users/Admin/Documents/Default Project/laptop-tracker/agent.js)
- **WiFi-to-Geo Integration**: Update `getWifiSignals` to not just scan but prepare BSSID data for geolocation.
- **Advanced Fallbacks**: Implement a call to the Google Geolocation API (or similar) when `getWindowsGps` fails.
- **Bluetooth Scanning**: Add a PowerShell-based Bluetooth device scan to provide additional proximity signals.
- **Heartbeat Enrichment**: Include more environment data (nearby devices, public gateway MAC) in the heartbeat payload.

#### [NEW] [geolocation-service.js](file:///C:/Users/Admin/Documents/Default Project/laptop-tracker/geolocation-service.js)
- Create a dedicated service to handle API calls to external geolocation providers (Google, Mozilla, etc.).

#### [MODIFY] [cloud-server.js](file:///C:/Users/Admin/Documents/Default Project/laptop-tracker/cloud-server.js)
- **Fusion Brain Integration**: Activate `signal-engine.js` in the heartbeat route to fuse multiple location inputs into a single "best-guess" coordinate.
- **Reliability Learning**: Store and use `signalReliability` data to weight future location guesses.

### Tooling & Logic

#### [MODIFY] [signal-engine.js](file:///C:/Users/Admin/Documents/Default Project/laptop-tracker/signal-engine.js)
- Enhance the Kalman filter parameters for better stationary laptop tracking.
- Add "Signal Fingerprinting" logic to identify specific locations by unique WiFi/Bluetooth environment signatures even without GPS.

## Verification Plan

### Automated Tests
- Mock WiFi/Bluetooth scan data and verify the `UltimateFusionBrain` correctly calculates a location.
- Verify API endpoints for heartbeat and command results.

### Manual Verification
- Deploy the updated `agent.js` to a test laptop.
- Disable Windows Location services and verify if the dashboard can still estimate a location using WiFi/IP signals.
- Inspect the new UI for responsiveness and aesthetic alignment with the Haulix design.
