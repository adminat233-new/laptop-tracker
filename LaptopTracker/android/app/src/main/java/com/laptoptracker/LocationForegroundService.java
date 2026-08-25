package com.laptoptracker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class LocationForegroundService extends Service {
    private static final String TAG = "LocationService";
    private static final String CHANNEL_ID = "tracker_location";
    private static final int NOTIFICATION_ID = 1001;
    private static final long UPDATE_INTERVAL = 5000;
    private static final long FASTEST_INTERVAL = 2000;

    private FusedLocationProviderClient fusedClient;
    private LocationCallback locationCallback;
    private String deviceId;
    private String serverUrl;

    @Override
    public void onCreate() {
        super.onCreate();
        fusedClient = LocationServices.getFusedLocationProviderClient(this);
        createNotificationChannel();

        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult locationResult) {
                if (locationResult == null) return;
                Location loc = locationResult.getLastLocation();
                if (loc != null) {
                    sendLocationToServer(loc);
                }
            }
        };
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        deviceId = intent.getStringExtra("device_id");
        serverUrl = intent.getStringExtra("server_url");
        if (deviceId == null) deviceId = "unknown";
        if (serverUrl == null) serverUrl = "https://laptop-tracker-k9vi.onrender.com";

        Notification notification = buildNotification();
        startForeground(NOTIFICATION_ID, notification);
        startLocationUpdates();

        return START_STICKY;
    }

    private void startLocationUpdates() {
        try {
            LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, UPDATE_INTERVAL)
                    .setMinUpdateIntervalMillis(FASTEST_INTERVAL)
                    .setWaitForAccurateLocation(false)
                    .build();

            fusedClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper());
            Log.d(TAG, "Location updates started");
        } catch (SecurityException e) {
            Log.e(TAG, "Location permission not granted", e);
        }
    }

    private void sendLocationToServer(Location loc) {
        new Thread(() -> {
            try {
                String json = "{" +
                        "\"lat\":" + loc.getLatitude() + "," +
                        "\"lng\":" + loc.getLongitude() + "," +
                        "\"accuracy\":" + loc.getAccuracy() + "," +
                        "\"source\":\"gps\"," +
                        "\"intLat\":" + Math.round(loc.getLatitude() * 1000000) + "," +
                        "\"intLng\":" + Math.round(loc.getLongitude() * 1000000) +
                        "}";

                // Send via WebSocket (simplified HTTP fallback)
                String wsUrl = serverUrl.replace("https://", "wss://").replace("http://", "ws://");
                String httpUrl = serverUrl + "/api/heartbeat";

                URL url = new URL(httpUrl);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(5000);

                String body = "{\"deviceId\":\"" + deviceId + "\",\"location\":" + json + "}";
                OutputStream os = conn.getOutputStream();
                os.write(body.getBytes(StandardCharsets.UTF_8));
                os.flush();
                os.close();

                int code = conn.getResponseCode();
                Log.d(TAG, "Location sent: " + code);
                conn.disconnect();
            } catch (Exception e) {
                Log.e(TAG, "Failed to send location", e);
            }
        }).start();
    }

    private Notification buildNotification() {
        Intent intent = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Laptop Tracker")
                .setContentText("Tracking location in background")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentIntent(pending)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Location Tracking", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Background location tracking");
            NotificationManager mgr = getSystemService(NotificationManager.class);
            if (mgr != null) mgr.createNotificationChannel(channel);
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (fusedClient != null && locationCallback != null) {
            fusedClient.removeLocationUpdates(locationCallback);
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
