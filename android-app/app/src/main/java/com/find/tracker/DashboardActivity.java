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
    private static final int PERM_REQ = 200;
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

        try {
            toneGen = new ToneGenerator(AudioManager.STREAM_ALARM, 100);
        } catch (Exception e) {}
        vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);

        pairCode = getIntent().getStringExtra("pairCode");
        deviceId = getIntent().getStringExtra("deviceId");
        role = getIntent().getStringExtra("role");

        if (pairCode == null || deviceId == null) {
            Toast.makeText(this, "Missing session data", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }

        api.setServer("https://laptop-tracker-k9vi.onrender.com");

        requestPermissions();
        initViews();
        setupMap();
        connectWebSocket();
        startStatusPoll();
        startHeartbeat();
        startLocationService();
        registerLocationReceiver();
    }

    private void requestPermissions() {
        String[] perms = {
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        };
        boolean needRequest = false;
        for (String p : perms) {
            if (ActivityCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                needRequest = true;
                break;
            }
        }
        if (needRequest) {
            ActivityCompat.requestPermissions(this, perms, PERM_REQ);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERM_REQ && map != null) {
            try {
                if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    map.setMyLocationEnabled(true);
                }
            } catch (Exception e) {}
        }
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
        try {
            SupportMapFragment mapFrag = (SupportMapFragment) getSupportFragmentManager().findFragmentById(R.id.map);
            if (mapFrag != null) {
                mapFrag.getMapAsync(this);
            }
        } catch (Exception e) {
            Log.e(TAG, "Map setup failed: " + e.getMessage());
        }
    }

    @Override
    public void onMapReady(GoogleMap googleMap) {
        map = googleMap;
        try {
            map.getUiSettings().setZoomControlsEnabled(true);
            map.getUiSettings().setMyLocationButtonEnabled(false);
            LatLng defaultLoc = new LatLng(51.5, -0.1);
            map.moveCamera(CameraUpdateFactory.newLatLngZoom(defaultLoc, 3));
            if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                map.setMyLocationEnabled(true);
            }
        } catch (Exception e) {
            Log.e(TAG, "Map init failed: " + e.getMessage());
        }
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
                runOnUiThread(() -> addLog("WS disconnected — reconnecting...", "SYS"));
            }
            @Override
            public void onError(String error) {
                runOnUiThread(() -> addLog("WS error: " + error, "ERR"));
            }
        });
        ws.connect(deviceId);
    }

    private void handleMessage(JSONObject msg) {
        try {
            String type = msg.getString("type");
            if (type.equals("command")) {
                String cmdType = msg.optString("commandType", "");
                String cmdId = msg.optString("commandId", "");
                addLog("Command: " + cmdType, "CMD");
                executeCommand(cmdType, cmdId);
            } else if (type.equals("commandResult")) {
                String result = msg.optString("result", "");
                addLog("Result: " + result, "RES");
            } else if (type.equals("location") && !msg.isNull("location")) {
                JSONObject loc = msg.getJSONObject("location");
                String fromId = msg.optString("fromDeviceId", "");
                double lat = loc.getDouble("lat");
                double lng = loc.getDouble("lng");
                if (fromId.endsWith("-phone")) {
                    updatePhoneLocation(lat, lng);
                } else {
                    updateLaptopLocation(lat, lng);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Handle msg error: " + e.getMessage());
        }
    }

    private void executeCommand(String cmdType, String cmdId) {
        switch (cmdType) {
            case "locate":
                sendLocation();
                break;
            case "lock":
                showLockOverlay();
                break;
            case "siren":
                startSiren();
                break;
            case "screenshot":
                Toast.makeText(this, "Screenshot: use browser app", Toast.LENGTH_SHORT).show();
                break;
            case "lost-mode-on":
                showLockOverlay();
                startSiren();
                addLog("LOST MODE ACTIVATED", "SYS");
                break;
            case "lost-mode-off":
                addLog("Device recovered", "SYS");
                break;
            default:
                addLog("Command requires native agent: " + cmdType, "CMD");
                break;
        }
    }

    private void showLockOverlay() {
        View overlay = new View(this);
        overlay.setBackgroundColor(Color.BLACK);
        overlay.setClickable(true);
        addContentView(overlay, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.MATCH_PARENT));
        Toast.makeText(this, "Device Locked", Toast.LENGTH_LONG).show();
    }

    private void startSiren() {
        sirenActive = true;
        try {
            if (toneGen != null) {
                toneGen.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 500);
            }
            if (vibrator != null) {
                vibrator.vibrate(VibrationEffect.createOneShot(500, VibrationEffect.DEFAULT_AMPLITUDE));
            }
        } catch (Exception e) {}
        addLog("Siren activated", "SYS");
    }

    private void sendLocation() {
        FusedLocationProviderClient fusedClient = LocationServices.getFusedLocationProviderClient(this);
        try {
            if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                return;
            }
            fusedClient.getLastLocation().addOnSuccessListener(loc -> {
                if (loc != null) {
                    JSONObject locData = new JSONObject();
                    try {
                        locData.put("lat", loc.getLatitude());
                        locData.put("lng", loc.getLongitude());
                        locData.put("accuracy", loc.getAccuracy());
                        locData.put("source", "android-gps");
                    } catch (Exception e) {}
                    ws.sendLocation(deviceId, locData);
                    addLog("Location sent", "GPS");
                }
            });
        } catch (Exception e) {
            addLog("Location error: " + e.getMessage(), "ERR");
        }
    }

    private void updateLaptopLocation(double lat, double lng) {
        laptopLat = lat;
        laptopLng = lng;
        LatLng pos = new LatLng(lat, lng);
        if (laptopMarker != null) {
            laptopMarker.setPosition(pos);
        } else if (map != null) {
            laptopMarker = map.addMarker(new MarkerOptions()
                .position(pos)
                .title("Laptop")
                .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_GREEN)));
        }
        lpCoords.setText(String.format("Coords: %.4f, %.4f", lat, lng));
        updateTrackInfo();
        if (map != null) map.animateCamera(CameraUpdateFactory.newLatLngZoom(pos, 15));
    }

    private void updatePhoneLocation(double lat, double lng) {
        phoneLat = lat;
        phoneLng = lng;
        LatLng pos = new LatLng(lat, lng);
        if (phoneMarker != null) {
            phoneMarker.setPosition(pos);
        } else if (map != null) {
            phoneMarker = map.addMarker(new MarkerOptions()
                .position(pos)
                .title("Phone")
                .icon(BitmapDescriptorFactory.defaultMarker(BitmapDescriptorFactory.HUE_AZURE)));
        }
        phCoords.setText(String.format("Coords: %.4f, %.4f", lat, lng));
        updateTrackInfo();
    }

    private void updateTrackInfo() {
        if (laptopLat == 0 && phoneLat == 0) return;
        float[] results = new float[1];
        Location.distanceBetween(laptopLat, laptopLng, phoneLat, phoneLng, results);
        float distMeters = results[0];
        String distText;
        if (distMeters < 1000) {
            distText = String.format("%.0fm", distMeters);
        } else {
            distText = String.format("%.1fkm", distMeters / 1000);
        }
        trackDist.setText(distText);
        trackInfo.setVisibility(View.VISIBLE);

        double bearing = Math.toDegrees(Math.atan2(phoneLng - laptopLng, phoneLat - laptopLat));
        if (bearing < 0) bearing += 360;
        String[] dirs = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"};
        String dir = dirs[(int) Math.round(bearing / 45) % 8];
        trackBearing.setText(dir + " " + String.format("%.0f°", bearing));

        if (map != null) {
            if (trackLine != null) trackLine.remove();
            trackLine = map.addPolyline(new PolylineOptions()
                .add(new LatLng(laptopLat, laptopLng), new LatLng(phoneLat, phoneLng))
                .width(3).color(0xFFD4FF3F));
        }
    }

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

    private void startHeartbeat() {
        hbHandler = new Handler(Looper.getMainLooper());
        hbRunnable = new Runnable() {
            @Override
            public void run() {
                sendLocation();
                hbHandler.postDelayed(hbRunnable, 10000);
            }
        };
        hbHandler.post(hbRunnable);
    }

    private void startLocationService() {
        try {
            Intent intent = new Intent(this, LocationService.class);
            intent.putExtra("deviceId", deviceId);
            startForegroundService(intent);
        } catch (Exception e) {
            addLog("Location service error: " + e.getMessage(), "ERR");
        }
    }

    private void registerLocationReceiver() {
        LocalBroadcastManager.getInstance(this).registerReceiver(new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                double lat = intent.getDoubleExtra("lat", 0);
                double lng = intent.getDoubleExtra("lng", 0);
                if (lat != 0 && lng != 0) {
                    runOnUiThread(() -> updatePhoneLocation(lat, lng));
                }
            }
        }, new IntentFilter("location-update"));
    }

    private void addLog(String msg, String tag) {
        String ts = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(new java.util.Date());
        TextView tv = new TextView(this);
        tv.setTextSize(10);
        tv.setTypeface(Typeface.MONOSPACE);
        tv.setTextColor(0xFFD4FF3F);
        tv.setText("[" + ts + "] [" + tag + "] " + msg);
        tv.setPadding(0, 2, 0, 2);
        logBox.addView(tv, 0);
        if (logBox.getChildCount() > 100) logBox.removeViewAt(logBox.getChildCount() - 1);
    }

    public void onLocateClick(View v) { sendCommand("locate"); }
    public void onWifiClick(View v) { sendCommand("wifi-scan"); }
    public void onArpClick(View v) { sendCommand("arp-scan"); }
    public void onBtClick(View v) { sendCommand("bt-proximity"); }
    public void onScreenshotClick(View v) { sendCommand("screenshot"); }
    public void onSirenClick(View v) { startSiren(); sendCommand("siren"); }
    public void onLockClick(View v) { showLockOverlay(); sendCommand("lock"); }
    public void onDnsClick(View v) { sendCommand("dns-dump"); }
    public void onPortClick(View v) { sendCommand("port-audit"); }
    public void onPassClick(View v) { sendCommand("wifi-passwords"); }
    public void onUsbClick(View v) { sendCommand("usb-audit"); }
    public void onProcClick(View v) { sendCommand("process-audit"); }
    public void onIPScrapeClick(View v) { sendCommand("ip-scrape"); }
    public void onWifiIntelClick(View v) { sendCommand("wifi-analysis"); }
    public void onNetScanClick(View v) { sendCommand("network-scan"); }
    public void onBtScanClick(View v) { sendCommand("bt-scan"); }
    public void onNetFPClick(View v) { sendCommand("network-fingerprint"); }
    public void onMLReportClick(View v) { sendCommand("ml-report"); }
    public void onFullRecoveryClick(View v) { sendCommand("full-recovery-scan"); }

    public void onMarkLostClick(View v) {
        try {
            JSONObject body = new JSONObject();
            body.put("deviceId", deviceId.replace("-phone", ""));
            body.put("active", true);
            api.post("/api/lost-mode", body, new ApiClient.ApiCallback() {
                @Override
                public void onSuccess(JSONObject response) {
                    addLog("LOST MODE sent", "SYS");
                    Toast.makeText(DashboardActivity.this, "Lost mode activated", Toast.LENGTH_SHORT).show();
                }
                @Override
                public void onError(String error) { addLog("Lost mode failed: " + error, "ERR"); }
            });
        } catch (Exception e) {}
    }

    public void onRecoveredClick(View v) {
        try {
            JSONObject body = new JSONObject();
            body.put("deviceId", deviceId.replace("-phone", ""));
            body.put("active", false);
            api.post("/api/lost-mode", body, new ApiClient.ApiCallback() {
                @Override
                public void onSuccess(JSONObject response) {
                    addLog("Device recovered", "SYS");
                    Toast.makeText(DashboardActivity.this, "Device recovered", Toast.LENGTH_SHORT).show();
                }
                @Override
                public void onError(String error) { addLog("Recover failed: " + error, "ERR"); }
            });
        } catch (Exception e) {}
    }

    public void onRePairClick(View v) {
        prefs.edit().clear().apply();
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(intent);
        finish();
    }

    private void sendCommand(String type) {
        JSONObject body = new JSONObject();
        try {
            String targetId = role.equals("phone") ? pairCode : pairCode + "-phone";
            body.put("deviceId", targetId);
            body.put("commandType", type);
        } catch (Exception e) {}
        api.post("/api/command", body, new ApiClient.ApiCallback() {
            @Override
            public void onSuccess(JSONObject response) {
                addLog("Sent: " + type, "CMD");
                Toast.makeText(DashboardActivity.this, "Sent: " + type, Toast.LENGTH_SHORT).show();
            }
            @Override
            public void onError(String error) { addLog("Send failed: " + error, "ERR"); }
        });
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (ws != null) ws.disconnect();
        if (statusHandler != null && statusRunnable != null) statusHandler.removeCallbacks(statusRunnable);
        if (hbHandler != null && hbRunnable != null) hbHandler.removeCallbacks(hbRunnable);
        if (toneGen != null) toneGen.release();
    }
}
