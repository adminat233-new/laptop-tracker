package com.find.tracker;

import android.os.Handler;
import android.os.Looper;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public class ApiClient {
    private static final String TAG = "FindAPI";
    private static ApiClient instance;
    private OkHttpClient http;
    private ExecutorService executor;
    private Handler mainHandler;
    private String baseUrl;

    public interface ApiCallback {
        void onSuccess(JSONObject response);
        void onError(String error);
    }

    private ApiClient() {
        http = new OkHttpClient.Builder().connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS).build();
        executor = Executors.newFixedThreadPool(3);
        mainHandler = new Handler(Looper.getMainLooper());
    }

    public static synchronized ApiClient getInstance() {
        if (instance == null) instance = new ApiClient();
        return instance;
    }

    public void setServer(String url) {
        this.baseUrl = url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }

    public String getServer() { return baseUrl; }

    public void post(String path, JSONObject body, ApiCallback cb) {
        executor.execute(() -> {
            try {
                RequestBody reqBody = RequestBody.create(body.toString(), MediaType.parse("application/json"));
                Request req = new Request.Builder()
                        .url(baseUrl + path)
                        .post(reqBody)
                        .build();
                Response resp = http.newCall(req).execute();
                String json = resp.body() != null ? resp.body().string() : "{}";
                JSONObject obj = new JSONObject(json);
                mainHandler.post(() -> cb.onSuccess(obj));
            } catch (Exception e) {
                mainHandler.post(() -> cb.onError(e.getMessage()));
            }
        });
    }

    public void get(String path, ApiCallback cb) {
        executor.execute(() -> {
            try {
                Request req = new Request.Builder()
                        .url(baseUrl + path)
                        .get()
                        .build();
                Response resp = http.newCall(req).execute();
                String json = resp.body() != null ? resp.body().string() : "{}";
                JSONObject obj = new JSONObject(json);
                mainHandler.post(() -> cb.onSuccess(obj));
            } catch (Exception e) {
                mainHandler.post(() -> cb.onError(e.getMessage()));
            }
        });
    }

    public JSONObject postSync(String path, JSONObject body) throws IOException {
        try {
            RequestBody reqBody = RequestBody.create(body.toString(), MediaType.parse("application/json"));
            Request req = new Request.Builder().url(baseUrl + path).post(reqBody).build();
            Response resp = http.newCall(req).execute();
            String json = resp.body() != null ? resp.body().string() : "{}";
            return new JSONObject(json);
        } catch (Exception e) {
            try { return new JSONObject().put("success", false).put("error", e.getMessage()); } catch (Exception ex) { return new JSONObject(); }
        }
    }

    public JSONObject getSync(String path) throws IOException {
        try {
            Request req = new Request.Builder().url(baseUrl + path).get().build();
            Response resp = http.newCall(req).execute();
            String json = resp.body() != null ? resp.body().string() : "{}";
            return new JSONObject(json);
        } catch (Exception e) {
            try { return new JSONObject().put("success", false).put("error", e.getMessage()); } catch (Exception ex) { return new JSONObject(); }
        }
    }
}
