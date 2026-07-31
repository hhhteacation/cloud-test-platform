package com.sdktest.platform;

/** Loads the real SDK bridge without coupling Activity code to a vendor API. */
public final class RealSdkAdapter implements VideoProcessorAdapter {
    public static final String BRIDGE_CLASS = "com.sdktest.integration.VendorSdkBridgeImpl";
    private VendorSdkBridge bridge;

    @Override
    public void process(String inputPath, String outputPath, ProcessingListener listener) {
        try {
            Class<?> bridgeType = Class.forName(BRIDGE_CLASS);
            Object instance = bridgeType.getDeclaredConstructor().newInstance();
            if (!(instance instanceof VendorSdkBridge)) {
                listener.onFailed("SDK_INITIALIZE_FAILED", BRIDGE_CLASS + " 必须实现 VendorSdkBridge");
                return;
            }
            bridge = (VendorSdkBridge) instance;
            bridge.process(inputPath, outputPath, new VendorSdkBridge.Callback() {
                @Override public void onInitialized() { listener.onInitialized(); }
                @Override public void onProgress(int progress, String message) { listener.onProgress(progress, message); }
                @Override public void onCompleted() { listener.onCompleted(outputPath); }
                @Override public void onFailed(String code, String message) { listener.onFailed(code, message); }
            });
        } catch (ClassNotFoundException error) {
            listener.onFailed(
                "SDK_INITIALIZE_FAILED",
                "真实 SDK 尚未接入：请提供 " + BRIDGE_CLASS
            );
        } catch (Exception error) {
            listener.onFailed("SDK_INITIALIZE_FAILED", error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    @Override public void cancel() { if (bridge != null) bridge.cancel(); }
    @Override public void release() { if (bridge != null) bridge.release(); bridge = null; }
}
