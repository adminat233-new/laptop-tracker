package com.find.tracker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import org.json.JSONObject;

public class LocationService extends Service {
    private static final String TAG = "FindLoc";
    private static final String CHANNEL_ID = "find_location";
    private static final int NOTIFICATION_ID = 1001;
    private FusedLocationProviderClient fusedClient;
    private LocationCallback locationCallback;
    private String deviceId;
    private ApiClient api;
    private FindWebSocket ws;

    @Override
    public void onCreate() {
        super.onCreate();
        fusedClient = LocationServices.getFusedLocationProviderClient(this);
        api = ApiClient.getInstance();
        createNotificationChannel();
        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                if (result != null && result.getLastLocation() != null) {
                    Location loc = result.getLastLocation();
                    sendLocation(loc);
                }
            }
        };
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        deviceId = intent.getStringExtra("deviceId");
        startForeground(NOTIFICATION_ID, buildNotification());
        requestLocationUpdates();
        return START_STICKY;
    }

    private void requestLocationUpdates() {
        LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 10000)
                .setMinUpdateIntervalMillis(5000)
                .build();
        try {
            fusedClient.requestLocationUpdates(req, locationCallback, Looper.getMainLooper());
        } catch (SecurityException e) {
            Log.e(TAG, "No location permission", e);
        }
    }

    private void sendLocation(Location loc) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("deviceId", deviceId);
            JSONObject location = new JSONObject();
            location.put("lat", loc.getLatitude());
            location.put("lng", loc.getLongitude());
            location.put("accuracy", loc.getAccuracy());
            location.put("source", "android-gps");
            payload.put("location", location);
            payload.put("systemInfo", getSystemInfo());
            api.post("/api/heartbeat", payload, new ApiClient.ApiCallback() {
                @Override
                public void onSuccess(JSONObject response) {}
                @Override
                public void onError(String error) { Log.e(TAG, "Heartbeat failed: " + error); }
            });
            // Broadcast to UI
            Intent intent = new Intent("FIND_LOCATION_UPDATE");
            intent.putExtra("lat", loc.getLatitude());
            intent.putExtra("lng", loc.getLongitude());
            intent.putExtra("accuracy", loc.getAccuracy());
            androidx.localbroadcastmanager.content.LocalBroadcastManager.getInstance(this).sendBroadcast(intent);
        } catch (Exception e) { Log.e(TAG, "Send location error", e); }
    }

    private JSONObject getSystemInfo() {
        try {
            JSONObject info = new JSONObject();
            info.put("hostname", Build.MODEL);
            info.put("platform", "Android " + Build.VERSION.RELEASE);
            info.put("role", "phone");
            info.put("brand", Build.BRAND);
            info.put("device", Build.DEVICE);
            return info;
        } catch (Exception e) { return new JSONObject(); }
    }

    private Notification buildNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("FIND Tracking")
                .setContentText("Location tracking active")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Location Tracking", NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        super.onDestroy();
        fusedClient.removeLocationUpdates(locationCallback);
    }
}
