package com.sdktest.platform;

import android.util.Log;
import org.json.JSONObject;

public final class StructuredLogger {
    private static final String TAG = "SDK_COMPAT";
    private final String taskId;

    public StructuredLogger(String taskId) { this.taskId = taskId; }

    public void event(String eventType, String checkKey, String name, String status, int progress, String message) {
        try {
            JSONObject json = new JSONObject();
            json.put("protocolVersion", 1);
            json.put("taskId", taskId);
            json.put("eventType", eventType);
            if (checkKey != null) json.put("checkKey", checkKey);
            if (name != null) json.put("name", name);
            if (status != null) json.put("status", status);
            json.put("timestamp", java.time.Instant.now().toString());
            json.put("progress", progress);
            if (message != null) json.put("message", message);
            Log.i(TAG, json.toString());
        } catch (Exception error) {
            Log.e(TAG, "结构化事件生成失败", error);
        }
    }
}
