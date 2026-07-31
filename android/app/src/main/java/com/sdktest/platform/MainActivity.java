package com.sdktest.platform;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.media.MediaPlayer;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.VideoView;
import java.io.File;
import java.util.regex.Pattern;

public final class MainActivity extends Activity {
    private static final Pattern SAFE_TASK_ID = Pattern.compile("[A-Za-z0-9-]{1,120}");
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView statusView;
    private TextView logView;
    private VideoView videoView;
    private VideoProcessorAdapter processor;
    private StructuredLogger logger;
    private TestResult result;
    private TaskFiles files;
    private String taskId;
    private boolean finished;
    private boolean firstFrameRendered;
    private long outputValidationStartedAt;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        taskId = getIntent().getStringExtra("task_id");
        boolean autoRun = getIntent().getBooleanExtra("auto_run", false);

        if (taskId == null || !SAFE_TASK_ID.matcher(taskId).matches()) {
            setStatus("等待任务", "请由测试平台通过 task_id 启动 APK");
            return;
        }

        logger = new StructuredLogger(taskId);
        result = new TestResult(taskId);
        try {
            files = new TaskFiles(this, taskId);
            files.prepareOutputDirectories();
        } catch (Exception error) {
            fail("RESULT_MISSING", "无法创建任务目录：" + error.getMessage());
            return;
        }

        pass("launch", "应用启动", "测试载体已启动", 2, null);
        if (autoRun) handler.post(this::startProcessing);
        else setStatus("等待开始", "auto_run=false，当前不会执行真实 SDK");
    }

    private void startProcessing() {
        if (!files.inputFile.isFile() || files.inputFile.length() <= 0) {
            fail("INPUT_PUSH_FAILED", "没有找到平台传入的 input.mp4");
            return;
        }
        pass("input", "输入 MP4 校验", files.inputFile.length() + " bytes", 8, null);
        if (files.outputFile.exists() && !files.outputFile.delete()) {
            fail("SDK_PROCESSING_FAILED", "无法删除旧的 output.mp4");
            return;
        }

        processor = new RealSdkAdapter();
        setStatus("SDK 处理中", "正在调用 RealSdkAdapter");
        logger.event("processing_started", "processing", "SDK 视频处理", "running", 12, "开始调用真实 SDK");
        processor.process(
            files.inputFile.getAbsolutePath(),
            files.outputFile.getAbsolutePath(),
            new VideoProcessorAdapter.ProcessingListener() {
                @Override public void onInitialized() {
                    runOnUiThread(() -> pass("sdk_init", "SDK 初始化", "真实 SDK 初始化成功", 18, null));
                }

                @Override public void onProgress(int progress, String message) {
                    runOnUiThread(() -> {
                        int safeProgress = Math.max(20, Math.min(55, 20 + progress * 35 / 100));
                        setStatus("SDK 处理中 " + progress + "%", message == null ? "正在生成 output.mp4" : message);
                        logger.event("processing_progress", "processing", "SDK 视频处理", "running", safeProgress, message);
                    });
                }

                @Override public void onCompleted(String outputPath) {
                    runOnUiThread(() -> handleProcessingCompleted(new File(outputPath)));
                }

                @Override public void onFailed(String code, String message) {
                    runOnUiThread(() -> fail(code == null ? "SDK_PROCESSING_FAILED" : code, message));
                }
            }
        );
    }

    private void handleProcessingCompleted(File outputFile) {
        pass("processing", "SDK 视频处理", "SDK 处理完成", 58, null);
        if (!outputFile.isFile()) {
            fail("OUTPUT_MISSING", "SDK 回调完成，但 output.mp4 不存在");
            return;
        }
        if (outputFile.length() <= 0) {
            fail("OUTPUT_EMPTY", "SDK 生成的 output.mp4 为空");
            return;
        }
        pass("output_generated", "输出 MP4 生成", outputFile.length() + " bytes", 62, null);
        validateOutputPlayback(outputFile);
    }

    private void validateOutputPlayback(File outputFile) {
        setStatus("验证输出视频", "正在加载处理后的 output.mp4");
        outputValidationStartedAt = System.currentTimeMillis();
        firstFrameRendered = false;
        videoView.setOnErrorListener((mediaPlayer, what, extra) -> {
            fail("OUTPUT_PLAYBACK_FAILED", "输出视频无法播放，MediaPlayer=" + what + "/" + extra);
            return true;
        });
        videoView.setOnCompletionListener(mediaPlayer -> {
            if (finished) return;
            if (!firstFrameRendered) {
                fail("OUTPUT_PLAYBACK_FAILED", "播放完成前没有收到首帧回调");
                return;
            }
            pass("complete", "播放完成", "输出视频播放完成", 96, elapsed());
            pass("no_crash", "全过程无崩溃", "自动测试正常完成", 98, null);
            finishSuccess();
        });
        videoView.setOnPreparedListener(mediaPlayer -> onOutputPrepared(mediaPlayer));
        videoView.setVideoPath(outputFile.getAbsolutePath());
        handler.postDelayed(() -> {
            if (!finished) fail("OUTPUT_PLAYBACK_FAILED", "输出视频播放验证超过 45 秒");
        }, 45_000);
    }

    private void onOutputPrepared(MediaPlayer mediaPlayer) {
        if (finished) return;
        int duration = mediaPlayer.getDuration();
        if (duration < 7_000) {
            fail("OUTPUT_PLAYBACK_FAILED", "输出视频不足 7 秒，无法完成连续播放 5 秒检查");
            return;
        }
        pass("output_load", "输出视频加载", "播放器准备完成", 66, elapsed());
        mediaPlayer.setOnInfoListener((player, what, extra) -> {
            if (!firstFrameRendered && what == MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) {
                firstFrameRendered = true;
                pass("first_frame", "输出首帧展示", "首帧已渲染", 69, elapsed());
            }
            return false;
        });
        videoView.start();
        pass("play", "开始播放", "输出视频开始播放", 71, null);

        handler.postDelayed(() -> {
            if (finished) return;
            if (!videoView.isPlaying()) {
                fail("OUTPUT_PLAYBACK_FAILED", "输出视频未连续播放满 5 秒");
                return;
            }
            pass("continuous", "连续播放 5 秒", "连续播放正常", 76, 5_000L);
            videoView.pause();
            pass("pause", "暂停", "输出视频已暂停", 79, null);

            handler.postDelayed(() -> {
                if (finished) return;
                videoView.start();
                pass("resume", "恢复播放", "输出视频已恢复", 82, null);

                handler.postDelayed(() -> {
                    if (finished) return;
                    videoView.seekTo(duration / 2);
                    pass("seek", "进度拖动", "已拖动到视频中间位置", 85, null);
                    mediaPlayer.setLooping(true);
                    if (!mediaPlayer.isLooping()) {
                        fail("OUTPUT_PLAYBACK_FAILED", "播放器无法启用循环播放");
                        return;
                    }
                    pass("loop", "循环播放", "播放器循环模式已启用", 88, null);
                    setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);

                    handler.postDelayed(() -> {
                        if (finished) return;
                        if (!videoView.isPlaying()) {
                            fail("OUTPUT_PLAYBACK_FAILED", "旋转屏幕后视频没有继续播放");
                            return;
                        }
                        pass("rotation", "旋转后继续播放", "横屏后播放状态正常", 92, null);
                        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
                        mediaPlayer.setLooping(false);
                        videoView.seekTo(Math.max(0, duration - 1_500));
                    }, 1_200);
                }, 800);
            }, 500);
        }, 5_000);
    }

    private void pass(String key, String name, String message, int progress, Long durationMs) {
        if (finished) return;
        result.check(key, name, "passed", message, durationMs);
        logger.event("check", key, name, "passed", progress, message);
        appendLog("✓ " + name + "：" + message);
        setStatus(name, message);
    }

    private void fail(String code, String message) {
        if (finished) return;
        finished = true;
        result.check(code.toLowerCase(), "测试失败", "failed", message, null);
        logger.event("failed", code.toLowerCase(), "测试失败", "failed", 100, code + "：" + message);
        result.write(files, "failed", code, message);
        setStatus("测试失败", code + "：" + message);
        appendLog("✕ " + code + "：" + message);
    }

    private void finishSuccess() {
        if (finished) return;
        finished = true;
        result.write(files, "passed", null, null);
        logger.event("completed", "complete", "测试完成", "passed", 100, "output.mp4 已生成并通过播放验证");
        setStatus("测试完成", "output.mp4 已生成并通过播放验证");
    }

    private long elapsed() { return Math.max(0, System.currentTimeMillis() - outputValidationStartedAt); }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(28, 24, 28, 28);
        scroll.addView(root);

        TextView title = new TextView(this);
        title.setText("SDK 视频处理兼容性测试");
        title.setTextSize(22);
        title.setTextColor(0xFF172033);
        root.addView(title, new LinearLayout.LayoutParams(-1, 64));

        statusView = new TextView(this);
        statusView.setTextSize(15);
        statusView.setTextColor(0xFF1677FF);
        root.addView(statusView, new LinearLayout.LayoutParams(-1, 72));

        videoView = new VideoView(this);
        videoView.setBackgroundColor(0xFF000000);
        root.addView(videoView, new LinearLayout.LayoutParams(-1, 500));

        logView = new TextView(this);
        logView.setTextSize(12);
        logView.setTextColor(0xFF344054);
        logView.setPadding(16, 18, 16, 18);
        root.addView(logView, new LinearLayout.LayoutParams(-1, -2));
        setContentView(scroll);
        setStatus("准备中", "等待平台任务参数");
    }

    private void setStatus(String title, String message) {
        if (statusView != null) statusView.setText(title + "\n" + message);
    }

    private void appendLog(String message) {
        if (logView == null) return;
        CharSequence existing = logView.getText();
        logView.setText(existing.length() == 0 ? message : existing + "\n" + message);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (processor != null) processor.release();
        if (videoView != null) videoView.stopPlayback();
        super.onDestroy();
    }
}
