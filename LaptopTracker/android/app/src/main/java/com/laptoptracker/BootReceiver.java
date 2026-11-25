package com.laptoptracker;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            Log.d("BootReceiver", "Device booted, restarting location service");
            Intent serviceIntent = new Intent(context, LocationForegroundService.class);
            serviceIntent.putExtra("device_id", "auto-restart");
            serviceIntent.putExtra("server_url", "https://laptop-tracker-k9vi.onrender.com");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
        }
    }
}
