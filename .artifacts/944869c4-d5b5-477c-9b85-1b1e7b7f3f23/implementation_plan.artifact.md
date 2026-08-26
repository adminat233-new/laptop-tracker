# Implementation Plan - Fix Location Tracking & Add Forensic Logs

Fix the location tracking issue where the tracker stays "connecting" and implement a forensic output log in the interface.

## User Review Required

> [!IMPORTANT]
> The project currently has two server files (`server.js` and `cloud-server.js`). `cloud-server.js` is the main entry point but lacks many endpoints used by the frontend. I will consolidate the necessary logic into `cloud-server.js`.

## Proposed Changes

### Database Layer

#### [MODIFY] [schema.prisma](file:///C:/Users/Admin/Documents/Default Project/laptop-tracker/prisma/schema.prisma)
- Add `Log` model to store forensic outputs.
- Add `accuracy` and `source` fields to `Location` model.
- Add `status` field to `Device` model.

### Server Layer

#### [MODIFY] [cloud-server.js](file:///C:/Users/Admin/Documents/Default Project/laptop-tracker/cloud-server.js)
- Implement missing API endpoints:
    - `GET /api/status/:deviceId`: Returns device status and location.
    - `GET /api/poll/:deviceId`: Returns pending commands for the agent.
    - `POST /api/command`: Queues a command for a device.
    - `POST /api/result`: Records command results.
    - `GET /api/history/:deviceId`: Returns location history.
    - `GET /api/logs/:deviceId`: Returns forensic logs.
- Update WebSocket logic to broadcast location updates and logs in real-time.
- Enhance `/api/heartbeat` to store location more reliably.

### Agent Layer

#### [MODIFY] [agent.js](file:///C:/Users/Admin/Documents/Default Project/laptop-tracker/agent.js)
- Improve `getPreciseLocation` with better timeouts and fallbacks.
- Implement forensic logging: send command outputs and system events to `/api/log`.
- Increase heartbeat frequency when actively tracking.

### Frontend Layer

#### [MODIFY] [index.html](file:///C:/Users/Admin/Documents/Default Project/laptop-tracker/public/index.html)
- Add a dedicated **Forensic Output Log** section.
- Fix broken API calls (e.g., ensure it uses the correct `deviceId`).
- Improve the "Connecting" state UI to show status updates (e.g., "Waiting for Agent GPS...").
- Ensure it fetches logs from the new `/api/logs` endpoint.

## Verification Plan

### Automated Tests
- Run `node cloud-server.js` and verify all endpoints return 200 OK.
- Run `node agent.js` and verify it connects to the server and sends heartbeats.

### Manual Verification
- Open the web dashboard.
- Pair a "Phone" with a "Laptop".
- Verify that the laptop location appears on the map.
- Trigger a command (e.g., `wifi-scan`) and verify the output appears in the Forensic Log.
