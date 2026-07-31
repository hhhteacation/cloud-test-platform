package com.sdktest.platform;

/** Stable boundary between the test carrier and the vendor SDK. */
public interface VideoProcessorAdapter {
    void process(String inputPath, String outputPath, ProcessingListener listener);
    void cancel();
    void release();

    interface ProcessingListener {
        void onInitialized();
        void onProgress(int progress, String message);
        void onCompleted(String outputPath);
        void onFailed(String code, String message);
    }
}
