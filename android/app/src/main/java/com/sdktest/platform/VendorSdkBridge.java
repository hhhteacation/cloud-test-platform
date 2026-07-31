package com.sdktest.platform;

/**
 * Implement this interface in the real SDK integration module. The platform deliberately
 * does not copy the input file and report a fake success when no SDK is configured.
 */
public interface VendorSdkBridge {
    void process(String inputPath, String outputPath, Callback callback);
    void cancel();
    void release();

    interface Callback {
        void onInitialized();
        void onProgress(int progress, String message);
        void onCompleted();
        void onFailed(String code, String message);
    }
}
