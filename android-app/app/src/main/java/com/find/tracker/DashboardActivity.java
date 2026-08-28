package com.find.tracker;

import android.Manifest;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.location.Location;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.ProgressBar;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.drawerlayout.widget.DrawerLayout;
import androidx.localbroadcastmanager.content.LocalBroadcastManager;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationServices;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class DashboardActivity extends AppCompatActivity {
    private static final String TAG = "FindDash";
    private static final int PERM_REQ = 200;
    private static final int PERM_REQ_FINE = 201;
    private static final int PERM_REQ_CAMERA = 202;
    private static final int PERM_REQ_LOCATION_BG = 203;
    private ApiClient api;
    private FindWebSocket ws;
    private SharedPreferences prefs;

    String pairCode, deviceId, role;
    WebView mapView;
    DrawerLayout drawerLayout;
    Button btnToggleNav, btnCloseNav;
    Handler statusHandler, hbHandler;
    Runnable statusRunnable, hbRunnable;
    LinearLayout logBox;
    TextView mainStatus, agentStatus, intelOutput;
    TextView lpName, lpOs, lpCoords, lpAcc, phName, phCoords;
    TextView trackDist, trackBearing;
    View trackInfo, intelScroll;
    Button foundBtn, btnStreet, btnSat, btnTerrain;
    boolean sirenActive = false;
    ToneGenerator toneGen;
    Vibrator vibrator;
    double laptopLat = 0, laptopLng = 0, phoneLat = 0, phoneLng = 0;
    boolean mapReady = false;
    List<String> pendingPermissions = new ArrayList<>();

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

        requestAllPermissions();
        initViews();
        setupMap();
        connectWebSocket();
        startStatusPoll();
        startHeartbeat();
        startLocationService();
        registerLocationReceiver();
    }

    private void requestAllPermissions() {
        List<String> perms = new ArrayList<>();
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
            perms.add(Manifest.permission.ACCESS_FINE_LOCATION);
            perms.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        // Android 13+ notification permission
        if (android.os.Build.VERSION.SDK_INT >= 33 && !hasPermission("android.permission.POST_NOTIFICATIONS")) {
            perms.add("android.permission.POST_NOTIFICATIONS");
        }
        if (perms.size() > 0) {
            String[] arr = perms.toArray(new String[0]);
            try {
                new androidx.appcompat.app.AlertDialog.Builder(this)
                    .setTitle("Permissions Needed")
                    .setMessage("FIND needs location and notification access to track this device.")
                    .setPositiveButton("Allow", (d, w) -> ActivityCompat.requestPermissions(this, arr, PERM_REQ))
                    .setNegativeButton("Deny", (d, w) -> Toast.makeText(this, "Limited tracking", Toast.LENGTH_LONG).show())
                    .setCancelable(true)
                    .show();
            } catch (Exception e) {
                ActivityCompat.requestPermissions(this, arr, PERM_REQ);
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERM_REQ) {
            Toast.makeText(this, "Location permission granted", Toast.LENGTH_SHORT).show();
            sendLocation();
        } else if (requestCode == PERM_REQ_CAMERA) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(this, "Camera permission granted", Toast.LENGTH_SHORT).show();
            }
        } else if (requestCode == PERM_REQ_LOCATION_BG) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(this, "Background location granted", Toast.LENGTH_SHORT).show();
                startLocationService();
            }
        }
    }

    private boolean hasPermission(String perm) {
        return ActivityCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestPermission(String perm, int reqCode, String title, String msg) {
        if (hasPermission(perm)) return;
        new AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(msg)
            .setPositiveButton("Allow", (d, w) -> {
                ActivityCompat.requestPermissions(this, new String[]{perm}, reqCode);
            })
            .setNegativeButton("Deny", null)
            .show();
    }

    private void initViews() {
        drawerLayout = findViewById(R.id.drawerLayout);
        btnToggleNav = findViewById(R.id.btnToggleNav);
        btnCloseNav = findViewById(R.id.btnCloseNav);
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
        intelScroll = findViewById(R.id.intelScroll);
        foundBtn = findViewById(R.id.foundBtn);
        btnStreet = findViewById(R.id.btnStreet);
        btnSat = findViewById(R.id.btnSat);
        btnTerrain = findViewById(R.id.btnTerrain);

        btnToggleNav.setOnClickListener(v -> drawerLayout.openDrawer(android.view.Gravity.START));
        btnCloseNav.setOnClickListener(v -> drawerLayout.closeDrawer(android.view.Gravity.START));
    }

    private void setupMap() {
        mapView = findViewById(R.id.mapView);
        WebSettings ws = mapView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        ws.setAllowFileAccessFromFileURLs(true);
        ws.setAllowUniversalAccessFromFileURLs(true);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);

        mapView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.proceed();
            }
        });
        mapView.setWebChromeClient(new WebChromeClient());

        mapView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void trackUpdate(String txt) {
                runOnUiThread(() -> {
                    if (trackDist != null) trackDist.setText(txt);
                    if (trackInfo != null) trackInfo.setVisibility(View.VISIBLE);
                });
            }
        }, "AndroidBridge");

        mapView.loadUrl("file:///android_asset/map.html");
        new Handler(Looper.getMainLooper()).postDelayed(() -> { mapReady = true; }, 4000);
    }

    private void runMapCommand(String js) {
        if (mapView != null && mapReady) {
            runOnUiThread(() -> mapView.evaluateJavascript(js, null));
        } else if (mapView != null) {
            // Queue command for when map is ready
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (mapView != null) {
                    runOnUiThread(() -> mapView.evaluateJavascript(js, null));
                }
            }, 5000);
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
                showIntelResult(result);
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
            case "locate": sendLocation(); break;
            case "lock": sendCommand("lock"); break;
            case "siren": sendCommand("siren"); break;
            case "screenshot": sendCommand("screenshot"); break;
            case "lost-mode-on": sendCommand("lost-mode-on"); addLog("LOST MODE ACTIVATED", "SYS"); break;
            case "lost-mode-off": sendCommand("lost-mode-off"); addLog("Device recovered", "SYS"); break;
            default: sendCommand(cmdType); break;
        }
    }

    private void sendLocation() {
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
            requestPermission(Manifest.permission.ACCESS_FINE_LOCATION, PERM_REQ,
                "Location Required", "FIND needs location access to send this device's position.");
            return;
        }
        FusedLocationProviderClient fusedClient = LocationServices.getFusedLocationProviderClient(this);
        try {
            // Always request fresh location — don't use stale cached getLastLocation()
            com.google.android.gms.location.LocationRequest locReq = new com.google.android.gms.location.LocationRequest.Builder(3000, com.google.android.gms.location.Priority.PRIORITY_HIGH_ACCURACY)
                .setMaxUpdates(1)
                .setDurationMillis(8000)
                .build();
            fusedClient.requestLocationUpdates(locReq,
                new com.google.android.gms.location.LocationCallback() {
                    @Override
                    public void onLocationResult(com.google.android.gms.location.LocationResult result) {
                        if (result != null && result.getLastLocation() != null) {
                            Location loc = result.getLastLocation();
                            JSONObject locData = new JSONObject();
                            try {
                                locData.put("lat", loc.getLatitude());
                                locData.put("lng", loc.getLongitude());
                                locData.put("accuracy", loc.getAccuracy());
                                locData.put("source", "android-gps");
                            } catch (Exception e) {}
                            ws.sendLocation(deviceId, locData);
                            updatePhoneLocation(loc.getLatitude(), loc.getLongitude());
                            addLog("GPS: " + loc.getLatitude() + ", " + loc.getLongitude() + " (±" + Math.round(loc.getAccuracy()) + "m)", "GPS");
                            try { fusedClient.removeLocationUpdates(this); } catch (Exception ex) {}
                        }
                    }
                },
                Looper.getMainLooper()
            );
            // Timeout fallback: if no GPS in 8s, use IP
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try { fusedClient.removeLocationUpdates(new com.google.android.gms.location.LocationCallback() {}); } catch (Exception ex) {}
                if (phoneLat == 0 && phoneLng == 0) {
                    addLog("GPS timeout — using IP fallback", "GPS");
                    sendIPLocation();
                }
            }, 8000);
        } catch (Exception e) {
            addLog("Location error — using IP fallback", "GPS");
            sendIPLocation();
        }
    }

    private void sendIPLocation() {
        new Thread(() -> {
            try {
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) new java.net.URL("https://ipinfo.io/json").openConnection();
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                java.io.InputStream is = conn.getInputStream();
                java.io.BufferedReader br = new java.io.BufferedReader(new java.io.InputStreamReader(is));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
                br.close();
                JSONObject ipData = new JSONObject(sb.toString());
                if (ipData.has("loc")) {
                    String[] parts = ipData.getString("loc").split(",");
                    double lat = Double.parseDouble(parts[0]);
                    double lng = Double.parseDouble(parts[1]);
                    JSONObject locData = new JSONObject();
                    locData.put("lat", lat);
                    locData.put("lng", lng);
                    locData.put("accuracy", 3000);
                    locData.put("source", "android-ip");
                    locData.put("city", ipData.optString("city", ""));
                    locData.put("region", ipData.optString("region", ""));
                    ws.sendLocation(deviceId, locData);
                    runOnUiThread(() -> {
                        updatePhoneLocation(lat, lng);
                        addLog("IP location: " + lat + ", " + lng + " (" + ipData.optString("city") + ")", "IP");
                    });
                }
            } catch (Exception e) {
                runOnUiThread(() -> addLog("IP location failed: " + e.getMessage(), "ERR"));
            }
        }).start();
    }

    private void updateLaptopLocation(double lat, double lng) {
        laptopLat = lat;
        laptopLng = lng;
        runMapCommand("updateLp(" + lat + "," + lng + ")");
        if (lpCoords != null) lpCoords.setText(String.format("Coords: %.4f, %.4f", lat, lng));
        addLog("Laptop location: " + lat + ", " + lng, "GPS");
    }

    private void updatePhoneLocation(double lat, double lng) {
        phoneLat = lat;
        phoneLng = lng;
        runMapCommand("updatePh(" + lat + "," + lng + ")");
        if (phCoords != null) phCoords.setText(String.format("Coords: %.4f, %.4f", lat, lng));
    }

    public void onMapStreetClick(View v) { runMapCommand("setMapType('street')"); }
    public void onMapSatelliteClick(View v) { runMapCommand("setMapType('sat')"); }
    public void onMapTerrainClick(View v) { runMapCommand("setMapType('terrain')"); }

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

                                if (!response.isNull("laptop")) {
                                    JSONObject laptop = response.getJSONObject("laptop");
                                    if (lpOs != null && !laptop.isNull("systemInfo")) {
                                        JSONObject si = laptop.getJSONObject("systemInfo");
                                        lpName.setText("💻 " + si.optString("hostname", "Laptop"));
                                        lpOs.setText("OS: " + si.optString("platform", "--"));
                                    }
                                }
                                if (!response.isNull("laptopLocation")) {
                                    JSONObject ll = response.getJSONObject("laptopLocation");
                                    double lat = ll.getDouble("lat");
                                    double lng = ll.getDouble("lng");
                                    if (lat != 0 || lng != 0) {
                                        updateLaptopLocation(lat, lng);
                                    }
                                }
                                if (!response.isNull("phoneLocation")) {
                                    JSONObject pl = response.getJSONObject("phoneLocation");
                                    double lat = pl.getDouble("lat");
                                    double lng = pl.getDouble("lng");
                                    if (lat != 0 || lng != 0) {
                                        updatePhoneLocation(lat, lng);
                                    }
                                }

                                // Fit bounds if both markers exist
                                if (laptopLat != 0 && phoneLat != 0) {
                                    runMapCommand("map.fitBounds([[" + laptopLat + "," + laptopLng + "],[" + phoneLat + "," + phoneLng + "]],{padding:50})");
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
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) return;
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

    private void showIntelResult(String result) {
        if (intelOutput != null) {
            intelOutput.setText(result);
            intelScroll.setVisibility(View.VISIBLE);
        }
        addLog("Result received", "RES");
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

    // === TOOL CLICK HANDLERS ===
    public void onLocateClick(View v) { requestLocationThenSend("locate"); }
    public void onWifiClick(View v) { sendCommand("wifi-scan"); }
    public void onArpClick(View v) { sendCommand("arp-scan"); }
    public void onBtClick(View v) { sendCommand("bt-proximity"); }
    public void onScreenshotClick(View v) {
        requestPermission(Manifest.permission.CAMERA, PERM_REQ_CAMERA,
            "Camera Permission", "FIND needs camera access to take screenshots.");
        sendCommand("screenshot");
    }
    public void onSirenClick(View v) { sendCommand("siren"); }
    public void onLockClick(View v) { sendCommand("lock"); }
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
    public void onCookieDumpClick(View v) { sendCommand("cookie-dump"); }
    public void onClipboardClick(View v) { sendCommand("clipboard-grab"); }
    public void onEnvDumpClick(View v) { sendCommand("env-dump"); }
    public void onHistoryClick(View v) { sendCommand("history-dump"); }
    public void onAppsClick(View v) { sendCommand("installed-apps"); }
    public void onGeoTriClick(View v) { sendCommand("geo-triangulate"); }
    public void onDeepPortClick(View v) { sendCommand("open-ports-deep"); }
    public void onRegistryClick(View v) { sendCommand("registry-dump"); }
    public void onConnectionsClick(View v) { sendCommand("active-connections"); }
    public void onSysScreenshotClick(View v) { sendCommand("system-screenshot"); }

    public void onMarkLostClick(View v) {
        new AlertDialog.Builder(this)
            .setTitle("Mark as Lost")
            .setMessage("This will activate lost mode on the tracked device. Continue?")
            .setPositiveButton("Yes", (d, w) -> {
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
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    public void onRecoveredClick(View v) {
        new AlertDialog.Builder(this)
            .setTitle("Mark as Recovered")
            .setMessage("This will deactivate lost mode. Continue?")
            .setPositiveButton("Yes", (d, w) -> {
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
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    public void onRePairClick(View v) {
        new AlertDialog.Builder(this)
            .setTitle("Re-pair / Reset")
            .setMessage("This will clear all saved data and return to the pairing screen. Continue?")
            .setPositiveButton("Yes", (d, w) -> {
                prefs.edit().clear().apply();
                Intent intent = new Intent(DashboardActivity.this, MainActivity.class);
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                startActivity(intent);
                finish();
            })
            .setNegativeButton("Cancel", null)
            .show();
    }

    private void requestLocationThenSend(String cmdType) {
        if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
            requestPermission(Manifest.permission.ACCESS_FINE_LOCATION, PERM_REQ,
                "Location Required", "FIND needs location access to locate this device.");
            return;
        }
        sendCommand(cmdType);
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
        if (mapView != null) mapView.destroy();
    }
}
