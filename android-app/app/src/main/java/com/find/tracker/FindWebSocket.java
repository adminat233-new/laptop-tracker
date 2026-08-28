package com.find.tracker;

import android.util.Log;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;
import java.util.concurrent.TimeUnit;

public class FindWebSocket {
    private static final String TAG = "FindWS";
    private WebSocket ws;
    private OkHttpClient client;
    private String serverUrl;
    private String deviceId;
    private WSCallback callback;
    private boolean connected = false;
    private int reconnectDelay = 1000;

    public interface WSCallback {
        void onConnected();
        void onMessage(JSONObject msg);
        void onDisconnected();
        void onError(String error);
    }

    public FindWebSocket(String serverUrl, WSCallback callback) {
        this.serverUrl = serverUrl;
        this.callback = callback;
        this.client = new OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build();
    }

    public void connect(String deviceId) {
        this.deviceId = deviceId;
        String wsUrl = serverUrl.replace("https://", "wss://").replace("http://", "ws://");
        Request request = new Request.Builder().url(wsUrl).build();

        ws = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                connected = true;
                reconnectDelay = 1000;
                Log.d(TAG, "Connected");
                // Register
                try {
                    JSONObject reg = new JSONObject();
                    reg.put("type", "register");
                    reg.put("deviceId", deviceId);
                    reg.put("deviceType", "android");
                    webSocket.send(reg.toString());
                } catch (Exception e) { Log.e(TAG, "Register failed", e); }
                if (callback != null) callback.onConnected();
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                try {
                    JSONObject msg = new JSONObject(text);
                    if (callback != null) callback.onMessage(msg);
                } catch (Exception e) { Log.e(TAG, "Parse error", e); }
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(1000, null);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                connected = false;
                Log.d(TAG, "Closed: " + reason);
                if (callback != null) callback.onDisconnected();
                scheduleReconnect();
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                connected = false;
                Log.e(TAG, "Failed: " + t.getMessage());
                if (callback != null) callback.onError(t.getMessage());
                scheduleReconnect();
            }
        });
    }

    private void scheduleReconnect() {
        if (deviceId != null) {
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                if (!connected && deviceId != null) {
                    Log.d(TAG, "Reconnecting in " + reconnectDelay + "ms");
                    connect(deviceId);
                    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
                }
            }, reconnectDelay);
        }
    }

    public void send(JSONObject msg) {
        if (ws != null && connected) {
            ws.send(msg.toString());
        }
    }

    public void sendLocation(String deviceId, JSONObject location) {
        try {
            // Send via WebSocket
            JSONObject msg = new JSONObject();
            msg.put("type", "location");
            msg.put("deviceId", deviceId);
            msg.put("location", location);
            send(msg);

            // Also send via HTTP to store in DB + broadcast
            new Thread(() -> {
                try {
                    java.net.HttpURLConnection conn = (java.net.HttpURLConnection) new java.net.URL(serverUrl + "/api/location/phone").openConnection();
                    conn.setRequestMethod("POST");
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setDoOutput(true);
                    JSONObject body = new JSONObject();
                    body.put("deviceId", deviceId);
                    body.put("location", location);
                    java.io.OutputStream os = conn.getOutputStream();
                    os.write(body.toString().getBytes());
                    os.flush();
                    os.close();
                    conn.getResponseCode();
                    conn.disconnect();
                } catch (Exception e) { Log.e(TAG, "HTTP location failed", e); }
            }).start();
        } catch (Exception e) { Log.e(TAG, "Send location failed", e); }
    }

    public void disconnect() {
        deviceId = null;
        if (ws != null) {
            ws.close(1000, "Closing");
        }
    }

    public boolean isConnected() {
        return connected;
    }
}
