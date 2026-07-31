package com.sdktest.platform;

import android.content.Context;
import java.io.File;

public final class TaskFiles {
    public final File taskDirectory;
    public final File inputFile;
    public final File outputFile;
    public final File resultFile;

    public TaskFiles(Context context, String taskId) {
        File externalRoot = context.getExternalFilesDir(null);
        if (externalRoot == null) throw new IllegalStateException("应用专属外部存储不可用");
        taskDirectory = new File(externalRoot, "tasks/" + taskId);
        inputFile = new File(taskDirectory, "input/input.mp4");
        outputFile = new File(taskDirectory, "output/output.mp4");
        resultFile = new File(taskDirectory, "result/result.json");
    }

    public void prepareOutputDirectories() {
        File outputDirectory = outputFile.getParentFile();
        File resultDirectory = resultFile.getParentFile();
        if (outputDirectory != null && !outputDirectory.mkdirs() && !outputDirectory.isDirectory()) {
            throw new IllegalStateException("无法创建输出目录");
        }
        if (resultDirectory != null && !resultDirectory.mkdirs() && !resultDirectory.isDirectory()) {
            throw new IllegalStateException("无法创建结果目录");
        }
    }
}
