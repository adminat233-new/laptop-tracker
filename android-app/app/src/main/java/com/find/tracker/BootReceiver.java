package com.find.tracker;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            SharedPreferences prefs = context.getSharedPreferences("find_prefs", Context.MODE_PRIVATE);
            String deviceId = prefs.getString("deviceId", null);
            String server = prefs.getString("server", null);
            if (deviceId != null && server != null) {
                Intent serviceIntent = new Intent(context, LocationService.class);
                serviceIntent.putExtra("deviceId", deviceId);
                context.startForegroundService(serviceIntent);
            }
        }
    }
}
