# Guardian Ultimate - Advanced Forensic Recovery

A real-time, AI-driven laptop tracking and forensic intelligence tool designed for modern recovery scenarios.

## 🛡️ One-Click Deployment
To start both the secure cloud relay and the intelligence agent automatically:
1.  Double-click `start-guardian.bat`.
2.  The system will initialize the server, launch the agent, and open your dashboard.

Database provisioning is a separate operator step: the container generates Prisma Client at build time but does not run `prisma db push` on startup. For a fresh database, run `npm run db:push` with the intended `DATABASE_URL` before routing traffic. The Render service must also define `DATABASE_URL`; `GET /api/health` reports `database: "unavailable"` when it is missing or invalid, and pairing endpoints will fail until it is corrected. The live service is `https://laptop-tracker-k9vi.onrender.com`.

On IPv4-only hosts such as Render's free tier, use Supabase's **Session pooler** connection string, not the direct `db.<project-ref>.supabase.co:5432` endpoint, which is IPv6-only without the IPv4 add-on. If more than one hosted instance shares a database, point all clients at one instance: WebSocket sessions are held in that process, so splitting clients across instances breaks agent/browser delivery.

## 🚀 Advanced Features
- **TTAL v9.0 Smart Brain**: Adaptive coordinate fusion using GPS, WiFi Fingerprinting, and IP Geolocation. It learns signal reliability over time for pinpoint accuracy.
- **Forensic Suite**: 
    - **DNS Cache Dump**: View target browsing intelligence and visited domains.
    - **USB History Audit**: Monitor physical hardware interactions and connected drives.
    - **Port Auditing**: Identify all open network listeners and potential vulnerabilities.
    - **Persistence Check**: Scan for unauthorized startup entries and services.
- **AI-Driven Interface**: A modern, human-like interaction node that provides real-time telemetry updates and intelligence briefings.
- **Forensic Terminal**: Live-streaming log of all agent activities and ethical hacking tool outputs.
- **Authenticated Pairing**: An 8-character pairing code plus a per-device token. The token is stored as a hash and required for WebSocket registration; remote commands are disabled in this build.

## 🛠️ Tech Stack
- **Backend**: Node.js, Express, Prisma, WebSocket.
- **Database**: PostgreSQL (Prisma).
- **Tracking**: Leaflet.js, TTAL Fusion Algorithm.
- **Mobile**: React Native (Android/iOS).

## 🌍 Real-World Problem Solving
Guardian Ultimate is designed for high-stress recovery scenarios. Whether your device is stolen or you are performing a security audit, the "Smart Brain" uses multi-path network traces and RSSI-to-distance logic to find the device even when traditional GPS fails.
