const CACHE_NAME = 'laptop-tracker-v11-fixcommands';
const LOCATION_INTERVAL = 10000;
let locationTimer = null;
let trackedDeviceId = null;
let trackedDeviceType = null;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(cacheNames.map((name) => caches.delete(name)));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).then((r) => r).catch(() => caches.match(event.request))
  );
});

self.addEventListener('message', (event) => {
  const { type, deviceId, deviceType } = event.data;

  if (type === 'START_BG_LOCATION') {
    trackedDeviceId = deviceId;
    trackedDeviceType = deviceType || 'laptop';
    startBackgroundLocation();
  }

  if (type === 'STOP_BG_LOCATION') {
    stopBackgroundLocation();
  }

  if (type === 'SW_LOCATION_REQUEST') {
    sendLocationToClients();
  }
});

function startBackgroundLocation() {
  if (locationTimer) clearInterval(locationTimer);
  sendLocationToClients();
  locationTimer = setInterval(sendLocationToClients, LOCATION_INTERVAL);
}

function stopBackgroundLocation() {
  if (locationTimer) { clearInterval(locationTimer); locationTimer = null; }
}

function sendLocationToClients() {
  if (!trackedDeviceId) return;
  self.clients.matchAll().then((clients) => {
    clients.forEach((client) => {
      if (client.type === 'window') {
        client.postMessage({
          type: 'SW_LOCATION_REQUEST',
          deviceId: trackedDeviceId,
          deviceType: trackedDeviceType,
        });
      }
    });
  });
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'bg-location-sync') {
    event.waitUntil(sendLocationToClients());
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'bg-location-periodic') {
    event.waitUntil(sendLocationToClients());
  }
});
