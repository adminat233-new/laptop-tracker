const CACHE_NAME = 'laptop-tracker-v5';
const BG_SYNC_TAG = 'bg-location-sync';
const LOCATION_INTERVAL = 15000;
let locationTimer = null;
let trackedDeviceId = null;
let trackedDeviceType = null;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          return caches.delete(cacheName);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
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

  if (type === 'GET_LOCATION_NOW') {
    sendLocationOnce();
  }
});

function startBackgroundLocation() {
  if (locationTimer) clearInterval(locationTimer);
  sendLocationOnce();
  locationTimer = setInterval(() => {
    sendLocationOnce();
  }, LOCATION_INTERVAL);
}

function stopBackgroundLocation() {
  if (locationTimer) {
    clearInterval(locationTimer);
    locationTimer = null;
  }
}

function sendLocationOnce() {
  if (!trackedDeviceId) return;

  if (trackedDeviceType === 'phone') {
    if (self.registration.sync) {
      self.registration.sync.register(BG_SYNC_TAG + '-phone-' + Date.now());
    }
  }

  const coordsPromise = new Promise((resolve, reject) => {
    if (self.registration.sync) {
      reject(new Error('Using sync instead'));
      return;
    }
    reject(new Error('No GPS available in SW'));
  });

  self.clients.matchAll().then((clients) => {
    clients.forEach((client) => {
      client.postMessage({
        type: 'SW_LOCATION_REQUEST',
        deviceId: trackedDeviceId,
        deviceType: trackedDeviceType,
      });
    });
  });
}

self.addEventListener('sync', (event) => {
  if (event.tag.startsWith(BG_SYNC_TAG + '-phone')) {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'SW_LOCATION_REQUEST',
            deviceId: trackedDeviceId,
            deviceType: trackedDeviceType,
          });
        });
      })
    );
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'bg-location-periodic') {
    event.waitUntil(sendLocationOnce());
  }
});

if (self.registration && self.registration.periodicSync) {
  self.registration.periodicSync.register('bg-location-periodic', {
    minInterval: LOCATION_INTERVAL,
  }).catch(() => {});
}
