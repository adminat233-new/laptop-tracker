package com.find.tracker;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import org.json.JSONObject;

public class MainActivity extends AppCompatActivity {
    private static final String SERVER_URL = "https://laptop-tracker-k9vi.onrender.com";
    private static final int PERM_REQ = 100;
    private ApiClient api;
    private SharedPreferences prefs;

    LinearLayout roleSelect, laptopView, phoneView;
    TextView codeDisplay, pairStatus, pairError;
    EditText[] codeInputs = new EditText[8];
    LinearLayout codeInputContainer;
    Button connectBtn;
    String pairCode, deviceId, role;
    android.os.Handler pollHandler;
    Runnable pollRunnable;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        api = ApiClient.getInstance();
        api.setServer(SERVER_URL);
        prefs = getSharedPreferences("find_prefs", MODE_PRIVATE);

        roleSelect = findViewById(R.id.roleSelect);
        laptopView = findViewById(R.id.laptopView);
        phoneView = findViewById(R.id.phoneView);
        codeDisplay = findViewById(R.id.codeDisplay);
        pairStatus = findViewById(R.id.pairStatus);
        pairError = findViewById(R.id.pairError);
        codeInputContainer = findViewById(R.id.codeInputContainer);
        connectBtn = findViewById(R.id.connectBtn);

        // Check if already paired
        String savedRole = prefs.getString("role", null);
        String savedPc = prefs.getString("pairCode", null);
        String savedMy = prefs.getString("deviceId", null);
        if (savedRole != null && savedPc != null && savedMy != null) {
            if (savedRole.equals("phone")) {
                pairCode = savedPc;
                deviceId = savedMy;
                role = savedRole;
                enterDashboard();
                return;
            }
        }

        setupCodeInputs();

        // Request permissions after a short delay so UI loads first
        new Handler(Looper.getMainLooper()).postDelayed(this::requestPermissions, 500);
    }

    private void requestPermissions() {
        String[] perms = {
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.CAMERA,
            Manifest.permission.VIBRATE
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

    public void onLaptopClick(View v) {
        role = "laptop";
        roleSelect.setVisibility(View.GONE);
        laptopView.setVisibility(View.VISIBLE);
        generateCode();
    }

    public void onPhoneClick(View v) {
        role = "phone";
        roleSelect.setVisibility(View.GONE);
        phoneView.setVisibility(View.VISIBLE);
    }

    private void generateCode() {
        pairStatus.setText("Generating code...");
        JSONObject body = new JSONObject();
        try {
            body.put("platform", "Android " + android.os.Build.MODEL);
        } catch (Exception e) {}
        api.post("/api/generate", body, new ApiClient.ApiCallback() {
            @Override
            public void onSuccess(JSONObject response) {
                try {
                    if (response.getBoolean("success")) {
                        pairCode = response.getString("pairCode");
                        deviceId = response.getString("deviceId");
                        saveSession();
                        showCode(pairCode);
                        startPairDetection();
                        pairStatus.setText("Show this code to your phone");
                    } else {
                        pairStatus.setText("Error: " + response.optString("error"));
                    }
                } catch (Exception e) { pairStatus.setText("Error parsing response"); }
            }
            @Override
            public void onError(String error) {
                pairStatus.setText("Network error - retrying...");
                new Handler(Looper.getMainLooper()).postDelayed(() -> generateCode(), 3000);
            }
        });
    }

    private void showCode(String code) {
        codeDisplay.setText("");
        for (char c : code.toCharArray()) {
            codeDisplay.append(String.valueOf(c) + "  ");
        }
    }

    private void setupCodeInputs() {
        for (int i = 0; i < 8; i++) {
            EditText et = new EditText(this);
            et.setLayoutParams(new LinearLayout.LayoutParams(dpToPx(40), dpToPx(50)));
            et.setGravity(android.view.Gravity.CENTER);
            et.setTextSize(20);
            et.setInputType(android.text.InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS);
            et.setMaxLines(1);
            et.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(1)});
            et.setBackgroundResource(R.drawable.digit_bg);
            et.setTextColor(0xFFFFFFFF);
            et.setHintTextColor(0x44FFFFFF);

            final int idx = i;
            et.addTextChangedListener(new TextWatcher() {
                @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
                @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
                @Override
                public void afterTextChanged(Editable s) {
                    String text = s.toString().toUpperCase().replaceAll("[^A-Z0-9]", "");
                    if (!s.toString().equals(text)) et.setText(text);
                    if (text.length() >= 1 && idx < 7) {
                        codeInputContainer.getChildAt(idx + 1).requestFocus();
                    }
                    checkAllFilled();
                }
            });
            et.setOnKeyListener((v, keyCode, event) -> {
                if (keyCode == android.view.KeyEvent.KEYCODE_DEL && et.getText().length() == 0 && idx > 0) {
                    codeInputContainer.getChildAt(idx - 1).requestFocus();
                    ((EditText) codeInputContainer.getChildAt(idx - 1)).setText("");
                }
                return false;
            });
            codeInputContainer.addView(et);
            codeInputs[i] = et;
        }
        if (codeInputs.length > 0) codeInputs[0].requestFocus();
    }

    private void checkAllFilled() {
        StringBuilder sb = new StringBuilder();
        for (EditText et : codeInputs) {
            if (et.getText().length() == 0) { connectBtn.setEnabled(false); return; }
            sb.append(et.getText().toString());
        }
        connectBtn.setEnabled(true);
    }

    public void onConnectClick(View v) {
        StringBuilder sb = new StringBuilder();
        for (EditText et : codeInputs) sb.append(et.getText().toString().toUpperCase());
        final String code = sb.toString();
        if (code.length() < 8) { pairError.setText("Enter 8 characters"); return; }

        JSONObject body = new JSONObject();
        try { body.put("pairCode", code); } catch (Exception e) {}
        api.post("/api/verify", body, new ApiClient.ApiCallback() {
            @Override
            public void onSuccess(JSONObject response) {
                try {
                    if (response.getBoolean("success")) {
                        pairCode = response.getString("pairCode");
                        deviceId = response.getString("phoneId");
                        role = "phone";
                        saveSession();
                        connectWs();
                        enterDashboard();
                    } else {
                        pairError.setText(response.optString("error", "Invalid code"));
                    }
                } catch (Exception e) { pairError.setText("Error"); }
            }
            @Override
            public void onError(String error) { pairError.setText("Network error"); }
        });
    }

    private void connectWs() {
        // WS connection will be managed in DashboardActivity
    }

    private void startPairDetection() {
        pollHandler = new android.os.Handler(Looper.getMainLooper());
        pollRunnable = new Runnable() {
            @Override
            public void run() {
                if (isFinishing()) return;
                api.get("/api/pair-info/" + pairCode, new ApiClient.ApiCallback() {
                    @Override
                    public void onSuccess(JSONObject response) {
                        try {
                            if (response.getBoolean("success") && !response.isNull("phone")) {
                                pairStatus.setText("Phone connected! Entering...");
                                pollHandler.postDelayed(() -> enterDashboard(), 1000);
                                return;
                            }
                        } catch (Exception e) {}
                        pollHandler.postDelayed(pollRunnable, 2000);
                    }
                    @Override
                    public void onError(String error) { pollHandler.postDelayed(pollRunnable, 2000); }
                });
            }
        };
        pollHandler.postDelayed(pollRunnable, 2000);
    }

    private void enterDashboard() {
        if (pollHandler != null && pollRunnable != null) pollHandler.removeCallbacks(pollRunnable);
        Intent intent = new Intent(this, DashboardActivity.class);
        intent.putExtra("pairCode", pairCode);
        intent.putExtra("deviceId", deviceId);
        intent.putExtra("role", role);
        startActivity(intent);
        finish();
    }

    private void saveSession() {
        prefs.edit()
            .putString("role", role)
            .putString("pairCode", pairCode)
            .putString("deviceId", deviceId)
            .putString("server", SERVER_URL)
            .apply();
    }

    private int dpToPx(int dp) {
        return (int) (dp * getResources().getDisplayMetrics().density);
    }
}
