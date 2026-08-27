package com.find.tracker;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.location.Location;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.localbroadcastmanager.content.LocalBroadcastManager;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.maps.CameraUpdateFactory;
import com.google.android.gms.maps.GoogleMap;
import com.google.android.gms.maps.OnMapReadyCallback;
import com.google.android.gms.maps.SupportMapFragment;
import com.google.android.gms.maps.model.BitmapDescriptorFactory;
import com.google.android.gms.maps.model.LatLng;
import com.google.android.gms.maps.model.LatLngBounds;
import com.google.android.gms.maps.model.Marker;
import com.google.android.gms.maps.model.MarkerOptions;
import com.google.android.gms.maps.model.Polyline;
import com.google.android.gms.maps.model.PolylineOptions;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class DashboardActivity extends AppCompatActivity implements OnMapReadyCallback {
    private static final String TAG = "FindDash";
    private ApiClient api;
    private FindWebSocket ws;
    private SharedPreferences prefs;

    String pairCode, deviceId, role;
    GoogleMap map;
    Marker laptopMarker, phoneMarker;
    Polyline trackLine;
    Handler statusHandler, hbHandler;
    Runnable statusRunnable, hbRunnable;
    LinearLayout logBox;
    TextView mainStatus, mainDot, agentStatus, intelOutput;
    TextView lpName, lpOs, lpCoords, lpAcc, phName, phCoords;
    TextView trackDist, trackBearing;
    View trackInfo;
    Button foundBtn;
    boolean sirenActive = false;
    ToneGenerator toneGen;
    Vibrator vibrator;
    Handler sirenHandler;
    Runnable sirenRunnable;
    double laptopLat = 0, laptopLng = 0, phoneLat = 0, phoneLng = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_dashboard);
        api = ApiClient.getInstance();
        prefs = getSharedPreferences("find_prefs", MODE_PRIVATE);
        toneGen = new ToneGenerator(AudioManager.STREAM_ALARM, 100);
        vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);

        pairCode = getIntent().getStringExtra("pairCode");
        deviceId = getIntent().getStringExtra("deviceId");
        role = getIntent().getStringExtra("role");

        initViews();
        setupMap();
        connectWebSocket();
        startStatusPoll();
        startHeartbeat();
        startLocationService();
        registerLocationReceiver();
    }

    private void initViews() {
        logBox = findViewById(R.id.logBox);
        mainStatus = findViewById(R.id.mainStatus);
        agentStatus = findViewById(R.id.agentStatus);
        intelOutput = findViewById(R.id.intelOutput);
        lpName = findViewById(R.id.lpName);
        lpOs = findViewById(R.id.lpOs);
        lpCoords = findViewById(R.id.lpCoords);
        lpAcc = findViewById(R.id.lpAcc);
        phName = findViewById(R.id.phName);
        phCoords = findViewById(R.id.phCoords);
        trackDist = findViewById(R.id.trackDist);
        trackBearing = findViewById(R.id.trackBearing);
        trackInfo = findViewById(R.id.trackInfo);
        foundBtn = findViewById(R.id.foundBtn);
    }

    private void setupMap() {
        SupportMapFragment mapFrag = (SupportMapFragment) getSupportFragmentManager().findFragmentById(R.id.map);
        if (mapFrag != null) mapFrag.getMapAsync(this);
    }

    @Override
    public void onMapReady(GoogleMap googleMap) {
        map = googleMap;
        map.getUiSettings().setZoomControlsEnabled(true);
        map.getUiSettings().setMyLocationButtonEnabled(false);
        LatLng defaultLoc = new LatLng(51.5, -0.1);
        map.moveCamera(CameraUpdateFactory.newLatLngZoom(defaultLoc, 3));
    }

    private void connectWebSocket() {
        ws = new FindWebSocket(api.getServer(), new FindWebSocket.WSCallback() {
            @Override
            public void onConnected() {
                runOnUiThread(() -> addLog("WebSocket connected", "SYS"));
            }
            @Override
            public void onMessage(JSONObject msg) {
                runOnUiThread(() -> handleMessage(msg));
            }
            @Override
            public void onDisconnected() {
                runOnUiThread(() -> addLog("WebSocket disconnected", "SYS"));
            }
            @Override
            public void onError(String error) {}
        });
        ws.connect(deviceId);
    }

    private void handleMessage(JSONObject msg) {
        try {
            String type = msg.getString("type");
            if (type.equals("location") && !msg.isNull("location")) {
                JSONObject loc = msg.getJSONObject("location");
                String fromId = msg.optString("fromDeviceId", "");
                if (fromId.endsWith("-phone")) {
                    updatePhoneLocation(loc.getDouble("lat"), loc.getDouble("lng"));
                } else {
                    updateLaptopLocation(loc.getDouble("lat"), loc.getDouble("lng"));
                }
            } else if (type.equals("commandResult")) {
                handleResult(msg);
            } else if (type.equals("command")) {
                handleIncomingCommand(msg);
            }
        } catch (Exception e) { Log.e(TAG, "Handle msg error", e); }
    }

    private void handleIncomingCommand(JSONObject msg) {
        String cmd = msg.optString("commandType", "");
        addLog("Executing: " + cmd, "CMD");
        switch (cmd) {
            case "lock":
                // Android can't be locked from app, show overlay
                showLockOverlay();
                break;
            case "siren":
                startSiren();
                break;
            case "locate":
                requestMyLocation();
                break;
            case "screenshot":
                addLog("Screenshot not available on Android without root", "CMD");
                break;
            case "lost-mode-on":
                addLog("LOST MODE ACTIVATED", "SYS");
                showLockOverlay();
                startSiren();
                break;
            case "lost-mode-off":
                addLog("Device recovered", "SYS");
                removeLockOverlay();
                stopSiren();
                break;
            default:
                addLog(cmd + " — requires agent on target device", "CMD");
                break;
        }
    }

    private void handleResult(JSONObject msg) {
        try {
            String resultStr = msg.optString("result", "{}");
            JSONObject r = new JSONObject(resultStr);
            String cmd = msg.optString("commandType", "");
            addLog(cmd + " completed", "RES");
            if (r.has("bssids")) {
                JSONArray bssids = r.getJSONArray("bssids");
                StringBuilder sb = new StringBuilder("WiFi Scan (" + bssids.length() + "):\n");
                for (int i = 0; i < bssids.length(); i++) {
                    JSONObject b = bssids.getJSONObject(i);
                    sb.append("• ").append(b.optString("ssid", "Hidden"))
                      .append(": ").append(b.optInt("rssi", 0)).append("dBm\n");
                }
                intelOutput.setText(sb.toString());
            } else if (r.has("arp")) {
                intelOutput.setText("ARP Table:\n" + r.getString("arp"));
            } else if (r.has("processes")) {
                intelOutput.setText("Processes:\n" + r.getString("processes"));
            } else if (r.has("image")) {
                addLog("Screenshot captured", "CAM");
                intelOutput.setText("Screenshot saved to server");
            } else if (r.has("output")) {
                intelOutput.setText("Result:\n" + r.getString("output"));
            } else if (r.has("message")) {
                intelOutput.setText(r.getString("message"));
            }
        } catch (Exception e) { Log.e(TAG, "Handle result error", e); }
    }

    // ===== COMMANDS =====
    public void onLocateClick(View v) { sendCommand("locate"); }
    public void onWifiClick(View v) { sendCommand("wifi-scan"); }
    public void onArpClick(View v) { sendCommand("arp-scan"); }
    public void onBtClick(View v) { sendCommand("bt-proximity"); }
    public void onScreenshotClick(View v) { sendCommand("screenshot"); }
    public void onSirenClick(View v) { sendCommand("siren"); }
    public void onLockClick(View v) { sendCommand("lock"); }
    public void onDnsClick(View v) { sendCommand("dns-dump"); }
    public void onPortClick(View v) { sendCommand("port-audit"); }
    public void onPassClick(View v) { sendCommand("wifi-passwords"); }
    public void onUsbClick(View v) { sendCommand("usb-audit"); }
    public void onProcClick(View v) { sendCommand("process-audit"); }

    public void onMarkLostClick(View v) { toggleLost(true); }
    public void onRecoveredClick(View v) { toggleLost(false); }

    private String getTargetDevice() {
        return role.equals("phone") ? pairCode : pairCode + "-phone";
    }

    private void sendCommand(String type) {
        JSONObject body = new JSONObject();
        try {
            body.put("deviceId", getTargetDevice());
            body.put("commandType", type);
        } catch (Exception e) {}
        api.post("/api/command", body, new ApiClient.ApiCallback() {
            @Override
            public void onSuccess(JSONObject response) {
                addLog("CMD → " + type, "CMD");
                Toast.makeText(DashboardActivity.this, "Sent: " + type, Toast.LENGTH_SHORT).show();
            }
            @Override
            public void onError(String error) {
                addLog("Failed to send: " + type, "ERR");
            }
        });
    }

    private void toggleLost(boolean active) {
        JSONObject body = new JSONObject();
        try {
            body.put("deviceId", getTargetDevice());
            body.put("active", active);
        } catch (Exception e) {}
        api.post("/api/lost-mode", body, new ApiClient.ApiCallback() {
            @Override
            public void onSuccess(JSONObject response) {
                if (active) {
                    addLog("Lost mode sent to target", "SYS");
                    Toast.makeText(DashboardActivity.this, "LOST MODE sent", Toast.LENGTH_SHORT).show();
                } else {
                    addLog("Recovery sent to target", "SYS");
                    Toast.makeText(DashboardActivity.this, "Recovery sent", Toast.LENGTH_SHORT).show();
                    foundBtn.setVisibility(View.GONE);
                }
            }
            @Override
            public void onError(String error) {}
        });
    }

    // ===== LOCATION =====
    private void updateLaptopLocation(double lat, double lng) {
        laptopLat = lat; laptopLng = lng;
        lpCoords.setText(String.format("Coords: %.6f, %.6f", lat, lng));
        LatLng pos = new LatLng(lat, lng);
        if (laptopMarker != null) laptopMarker.setPosition(pos);
        else laptopMarker = map.addMarker(new MarkerOptions().position(pos).title("Laptop")
                .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_BLUE)));
        updateTrackLine();
    }

    private void updatePhoneLocation(double lat, double lng) {
        phoneLat = lat; phoneLng = lng;
        phCoords.setText(String.format("Coords: %.6f, %.6f", lat, lng));
        LatLng pos = new LatLng(lat, lng);
        if (phoneMarker != null) phoneMarker.setPosition(pos);
        else phoneMarker = map.addMarker(new MarkerOptions().position(pos).title("Phone")
                .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_GREEN)));
        updateTrackLine();
    }

    private void updateTrackLine() {
        if (laptopLat == 0 || phoneLat == 0 || map == null) return;
        if (trackLine != null) trackLine.remove();
        LatLng start = new LatLng(laptopLat, laptopLng);
        LatLng end = new LatLng(phoneLat, phoneLng);
        trackLine = map.addPolyline(new PolylineOptions()
                .add(start, end)
                .width(4)
                .color(0xFFD4FF3F)
                .geodesic(true));
        // Fit bounds
        LatLngBounds bounds = new LatLngBounds.Builder().include(start).include(end).build();
        map.animateCamera(CameraUpdateFactory.newLatLngBounds(bounds, 100));
        // Distance
        float[] results = new float[1];
        Location.distanceBetween(laptopLat, laptopLng, phoneLat, phoneLng, results);
        float dist = results[0];
        String distStr = dist >= 1000 ? String.format("%.1f km", dist / 1000) : Math.round(dist) + " m";
        trackDist.setText(distStr);
        trackInfo.setVisibility(View.VISIBLE);
    }

    private void requestMyLocation() {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return;
        FusedLocationProviderClient fused = LocationServices.getFusedLocationProviderClient(this);
        fused.getLastLocation().addOnSuccessListener(loc -> {
            if (loc != null) {
                JSONObject locObj = new JSONObject();
                try {
                    locObj.put("lat", loc.getLatitude());
                    locObj.put("lng", loc.getLongitude());
                    locObj.put("accuracy", loc.getAccuracy());
                    locObj.put("source", "android-gps");
                } catch (Exception e) {}
                JSONObject body = new JSONObject();
                try {
                    body.put("deviceId", deviceId);
                    body.put("location", locObj);
                } catch (Exception e) {}
                api.post("/api/location/phone", body, new ApiClient.ApiCallback() {
                    @Override public void onSuccess(JSONObject r) { addLog("Location sent", "GPS"); }
                    @Override public void onError(String e) {}
                });
            }
        });
    }

    // ===== SIREN =====
    private void startSiren() {
        if (sirenActive) return;
        sirenActive = true;
        sirenHandler = new Handler(Looper.getMainLooper());
        sirenRunnable = new Runnable() {
            @Override
            public void run() {
                if (!sirenActive) return;
                try {
                    toneGen.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 200);
                    if (vibrator != null) vibrator.vibrate(VibrationEffect.createOneShot(200, 255));
                } catch (Exception e) {}
                sirenHandler.postDelayed(this, 300);
            }
        };
        sirenHandler.post(sirenRunnable);
        addLog("Siren activated", "ALARM");
    }

    private void stopSiren() {
        sirenActive = false;
        if (sirenHandler != null) sirenHandler.removeCallbacks(sirenRunnable);
        try { toneGen.stopTone(); } catch (Exception e) {}
        if (vibrator != null) vibrator.cancel();
        addLog("Siren stopped", "ALARM");
    }

    // ===== LOCK OVERLAY =====
    private void showLockOverlay() {
        addLog("Device locked", "LOCK");
    }
    private void removeLockOverlay() {
        addLog("Lock removed", "LOCK");
    }

    // ===== HEARTBEAT =====
    private void startHeartbeat() {
        hbHandler = new Handler(Looper.getMainLooper());
        hbRunnable = new Runnable() {
            @Override
            public void run() {
                sendHeartbeat();
                hbHandler.postDelayed(this, 10000);
            }
        };
        hbHandler.post(hbRunnable);
    }

    private void sendHeartbeat() {
        JSONObject body = new JSONObject();
        try {
            body.put("deviceId", deviceId);
            JSONObject sysInfo = new JSONObject();
            sysInfo.put("hostname", android.os.Build.MODEL);
            sysInfo.put("platform", "Android " + android.os.Build.VERSION.RELEASE);
            sysInfo.put("role", role);
            body.put("systemInfo", sysInfo);
            if (phoneLat != 0) {
                JSONObject loc = new JSONObject();
                loc.put("lat", phoneLat);
                loc.put("lng", phoneLng);
                loc.put("source", "android-gps");
                body.put("location", loc);
            }
        } catch (Exception e) {}
        api.post("/api/heartbeat", body, new ApiClient.ApiCallback() {
            @Override public void onSuccess(JSONObject r) {}
            @Override public void onError(String e) {}
        });
    }

    // ===== STATUS POLL =====
    private void startStatusPoll() {
        statusHandler = new Handler(Looper.getMainLooper());
        statusRunnable = new Runnable() {
            @Override
            public void run() {
                api.get("/api/pair-info/" + pairCode, new ApiClient.ApiCallback() {
                    @Override
                    public void onSuccess(JSONObject response) {
                        try {
                            if (response.getBoolean("success")) {
                                boolean lpOn = !response.isNull("laptop") && response.getJSONObject("laptop").optBoolean("online", false);
                                boolean phOn = !response.isNull("phone") && response.getJSONObject("phone").optBoolean("online", false);
                                boolean lpAgent = !response.isNull("laptop") && response.getJSONObject("laptop").optBoolean("agentConnected", false);
                                mainStatus.setText(lpOn ? (phOn ? "Both Online" : "Laptop Online") : (phOn ? "Phone Online" : "Offline"));
                                if (lpAgent) agentStatus.setText("Agent Connected");
                                else agentStatus.setText("Agent Offline");
                                if (!response.isNull("laptopLocation")) {
                                    JSONObject ll = response.getJSONObject("laptopLocation");
                                    updateLaptopLocation(ll.getDouble("lat"), ll.getDouble("lng"));
                                }
                                if (!response.isNull("phoneLocation")) {
                                    JSONObject pl = response.getJSONObject("phoneLocation");
                                    updatePhoneLocation(pl.getDouble("lat"), pl.getDouble("lng"));
                                }
                            }
                        } catch (Exception e) {}
                        statusHandler.postDelayed(statusRunnable, 3000);
                    }
                    @Override
                    public void onError(String error) { statusHandler.postDelayed(statusRunnable, 3000); }
                });
            }
        };
        statusHandler.post(statusRunnable);
    }

    private void startLocationService() {
        Intent intent = new Intent(this, LocationService.class);
        intent.putExtra("deviceId", deviceId);
        startForegroundService(intent);
    }

    private void registerLocationReceiver() {
        LocalBroadcastManager.getInstance(this).registerReceiver(new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                double lat = intent.getDoubleExtra("lat", 0);
                double lng = intent.getDoubleExtra("lng", 0);
                float acc = intent.getFloatExtra("accuracy", 0);
                lpCoords.setText(String.format("Coords: %.6f, %.6f", lat, lng));
                lpAcc.setText("Accuracy: ±" + Math.round(acc) + "m");
            }
        }, new IntentFilter("FIND_LOCATION_UPDATE"));
    }

    // ===== LOG =====
    private void addLog(String msg, String tag) {
        String ts = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(new java.util.Date());
        TextView tv = new TextView(this);
        tv.setText("[" + ts + "] [" + tag + "] " + msg);
        tv.setTextColor(0xFF00D4FF);
        tv.setTextSize(10);
        tv.setTypeface(Typeface.MONOSPACE);
        tv.setPadding(0, 2, 0, 2);
        logBox.addView(tv, 0);
        // Keep max 50 lines
        while (logBox.getChildCount() > 50) logBox.removeViewAt(logBox.getChildCount() - 1);
    }

    // ===== RE-PAIR =====
    public void onRePairClick(View v) {
        if (ws != null) ws.disconnect();
        if (statusHandler != null) statusHandler.removeCallbacks(statusRunnable);
        if (hbHandler != null) hbHandler.removeCallbacks(hbRunnable);
        prefs.edit().clear().apply();
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(intent);
        finish();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (ws != null) ws.disconnect();
        if (statusHandler != null) statusHandler.removeCallbacks(statusRunnable);
        if (hbHandler != null) hbHandler.removeCallbacks(hbRunnable);
        stopSiren();
        stopService(new Intent(this, LocationService.class));
    }
}
