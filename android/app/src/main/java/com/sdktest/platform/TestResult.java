package com.sdktest.platform;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

public final class TestResult {
    private final String taskId;
    private final long startedAt = System.currentTimeMillis();
    private final Map<String, JSONObject> checks = new LinkedHashMap<>();

    public TestResult(String taskId) { this.taskId = taskId; }

    public void check(String key, String name, String status, String message, Long durationMs) {
        try {
            JSONObject item = new JSONObject();
            item.put("key", key);
            item.put("name", name);
            item.put("status", status);
            if (message != null) item.put("message", message);
            if (durationMs != null) item.put("durationMs", durationMs);
            checks.put(key, item);
        } catch (Exception ignored) {}
    }

    public void write(TaskFiles files, String status, String failureCode, String failureMessage) {
        try {
            JSONObject json = new JSONObject();
            json.put("protocolVersion", 1);
            json.put("taskId", taskId);
            json.put("status", status);
            json.put("adapter", "RealSdkAdapter");
            json.put("startedAt", Instant.ofEpochMilli(startedAt).toString());
            json.put("finishedAt", Instant.now().toString());

            JSONObject input = fileInfo(files.inputFile, "input/input.mp4");
            json.put("input", input);
            if (files.outputFile.isFile()) {
                json.put("output", fileInfo(files.outputFile, "output/output.mp4"));
            }
            JSONArray checkArray = new JSONArray();
            for (JSONObject check : checks.values()) checkArray.put(check);
            json.put("checks", checkArray);
            if (failureCode != null) json.put("failureCode", failureCode);
            if (failureMessage != null) json.put("failureMessage", failureMessage);

            files.prepareOutputDirectories();
            try (FileOutputStream output = new FileOutputStream(files.resultFile, false)) {
                output.write(json.toString(2).getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            }
        } catch (Exception error) {
            android.util.Log.e("SDK_COMPAT", "result_write_failed: " + error.getMessage(), error);
        }
    }

    private JSONObject fileInfo(File file, String relativePath) throws Exception {
        JSONObject info = new JSONObject();
        info.put("name", file.getName());
        info.put("relativePath", relativePath);
        info.put("sizeBytes", file.isFile() ? file.length() : 0);
        if (file.isFile()) info.put("sha256", sha256(file));
        return info;
    }

    private String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (java.io.FileInputStream input = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[1024 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) digest.update(buffer, 0, read);
        }
        StringBuilder result = new StringBuilder();
        for (byte value : digest.digest()) result.append(String.format("%02x", value));
        return result.toString();
    }
}
