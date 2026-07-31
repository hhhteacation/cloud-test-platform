# 真实 SDK 接入边界

ADB 真机任务固定使用 `RealSdkAdapter`。它通过反射加载：

```text
com.sdktest.integration.VendorSdkBridgeImpl
```

该类必须实现：

```text
com.sdktest.platform.VendorSdkBridge
```

实现位置可以是 `app/src/main/java/com/sdktest/integration/VendorSdkBridgeImpl.java`，也可以放在引入的 Android Library 中。

## 必须满足

1. 使用厂商真实 SDK 读取 `inputPath`；
2. 将处理后视频写入 `outputPath`；
3. 初始化完成调用 `callback.onInitialized()`；
4. 处理进度调用 `callback.onProgress(...)`；
5. 文件完全写入并关闭后才调用 `callback.onCompleted()`；
6. 失败调用 `callback.onFailed(code, message)`；
7. `cancel()` 和 `release()` 必须转发到真实 SDK；
8. 禁止直接复制 input.mp4 生成 output.mp4 并报告成功。

参考骨架：

```text
android/sdk-integration-template/com/sdktest/integration/VendorSdkBridgeImpl.java.example
```

在没有该实现时，APK 会生成真实失败结果：

```text
failureCode = SDK_INITIALIZE_FAILED
```
