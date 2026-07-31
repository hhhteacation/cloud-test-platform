# APK + MP4 单真机兼容性测试平台

本项目是一个本地运行的 Android SDK 视频处理兼容性测试平台 MVP。

```text
浏览器上传 APK + MP4
→ Fastify 保存文件并写入 SQLite
→ 每台设备的独立队列调用 ADB
→ 根据 APK 包名选择执行协议
→ AndroidAppPreparer 完成设备唤醒、安装、弹窗处理和权限授权
→ 推送 input.mp4
→ APK 的 RealSdkAdapter 调用真实 SDK
→ APK 生成 output.mp4 + result.json
→ 后端拉取并保存结果
→ 前端查看进度、播放和下载 output.mp4
```

> 真机通过只代表当前 SDK、当前荣耀设备和当前 MP4 的处理链路通过，不等价于完整 SDK 算法质量验收。

## 目录

```text
.
├── web/                         React + TypeScript + Ant Design 前端
├── apps/api/                    Fastify + TypeScript + SQLite + ADB Worker
├── android/                     平台测试 APK（com.sdktest.platform，可选协议载体）
│   ├── SDK_INTEGRATION.md       真实 SDK Bridge 接入说明
│   └── sdk-integration-template/
├── data/                        SQLite 和运行产物（不提交 Git）
├── package.json                 统一命令
└── vite.config.ts               Vite 与 /api 代理
```

## 本地地址

```text
前端：http://localhost:5173
后端：http://127.0.0.1:3000
设备：A2AV024719001034
可识别 APK 包名：
- com.sdktest.platform
- com.morphoinc.videopostprocessor
```

## 环境要求

- Node.js 22.5+（项目使用内置 `node:sqlite`，推荐 Node 24）
- pnpm 11
- Java 17
- Android SDK 36 / Build Tools 36
- ADB：`$ANDROID_SDK_ROOT/platform-tools/adb`
- AAPT：`$ANDROID_SDK_ROOT/build-tools/36.0.0/aapt`

## 启动完整平台（真实模式）

```bash
pnpm install
pnpm dev
```

根命令会同时执行：

```text
VITE_API_BASE_URL=/api vite --host 0.0.0.0
pnpm dev:api
```

浏览器访问 `http://localhost:5173`。Vite 把 `/api` 请求代理到 `127.0.0.1:3000`，因此前端不会直接跨域访问后端。

单独启动：

```bash
pnpm dev:web          # 未配置 API，使用 localStorage Mock 模式
pnpm dev:web:real     # 使用 /api 访问真实后端
pnpm dev:api          # 只启动 Fastify API
```

## 构建

```bash
pnpm build
./android/gradlew -p android assembleDebug
```

APK 输出：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Gradle 第一次执行需要下载 Gradle 8.11.1 和 Android Gradle Plugin 8.10.1。网络中断会产生不完整 zip；删除对应的 `~/.gradle/wrapper/dists/gradle-8.11.1-bin/...` 临时目录后重试即可。

## 真实 SDK 前置条件

当前仓库没有厂商 SDK AAR/JAR/SO 和调用文档。`RealSdkAdapter` 会加载：

```text
com.sdktest.integration.VendorSdkBridgeImpl
```

没有这个实现时，APK 会如实返回：

```text
SDK_INITIALIZE_FAILED
```

不会复制输入文件伪造成功。接入方式见：

```text
android/SDK_INTEGRATION.md
```

## 数据和输出位置

电脑：

```text
data/cloud-test.sqlite
data/artifacts/{storageKey}/test.apk
data/artifacts/{storageKey}/input.mp4
data/tasks/{taskId}/device-runs/{runId}/
├── result.json
├── output.mp4
├── logcat.txt
├── screenshots/final.png
└── diagnostics/                 # 未识别/超时安装弹窗的 XML、截图和窗口信息
```

手机：

```text
/sdcard/Android/data/{APK_PACKAGE_NAME}/files/tasks/{taskId}/
├── input/input.mp4
├── output/output.mp4
└── result/result.json
```

报告视频通过以下接口提供：

```text
GET /api/outputs/:id/content    支持 HTTP Range / 206，用于在线播放和拖动
GET /api/outputs/:id/download   附件下载
```

## API

```text
GET  /api/health
GET  /api/devices
POST /api/artifacts?kind=apk|video
GET  /api/artifacts/:id
GET  /api/artifacts/:id/content
POST /api/tasks
GET  /api/tasks
GET    /api/tasks/:id
POST   /api/tasks/:id/cancel
DELETE /api/tasks/:id
GET    /api/tasks/:id/report
GET  /api/tasks/:taskId/device-runs/:runId/logcat
GET  /api/tasks/:taskId/device-runs/:runId/screenshots/final
GET  /api/outputs/:id/content
GET  /api/outputs/:id/download
```

## Android 无人值守应用准备

Android 安装前置逻辑集中在深模块：

```text
apps/api/src/execution/android-app-preparation/
├── android-app-preparer.ts      对 Worker 暴露的统一入口
├── device-readiness.ts          点亮屏幕、解除无密码锁屏、检测安全锁
├── apk-install-coordinator.ts   干净安装与弹窗监控并行协调
├── runtime-permissions.ts       pm grant、dumpsys 跨厂商验证、AppOps 诊断
├── system-dialog-controller.ts  UI XML 读取、系统包校验、诊断保存
├── dialog-profiles.ts           vivo/荣耀/Android 权限白名单 Profile
└── ui-xml.ts                    UI Automator XML 和 bounds 解析
```

Morpho 协议声明：

```text
安装方式：clean（先卸载后安装）
运行时权限：CAMERA、RECORD_AUDIO
弹窗策略：strict-whitelist
最大自动操作：4 次
```

系统弹窗点击坐标只从当前 UI XML 节点的 `bounds` 计算，不使用固定坐标。只有窗口属于可信系统安装器/权限控制器、设备厂商匹配、界面包含 Morpho 应用身份且至少两个 Profile 特征时才会点击。未知弹窗会保存到当前 `deviceRun/diagnostics` 并让该设备运行失败，不影响其他设备队列。

新增 Android 厂商支持时只添加新的 Dialog Profile 和去除个人信息后的 XML fixture；不要把厂商文案判断写回 `adb.ts`。未来 iOS 与 HarmonyOS 应实现各自的应用准备模块，不复用 ADB、UI Automator 或 Android 权限语义。


## 安全删除测试任务

任务列表的“删除”操作只对以下终态开放：

```text
passed
failed
cancelled
```

排队中或执行中的任务必须先取消，前端按钮会禁用，后端也会再次校验。删除由
`apps/api/src/task-deletion.ts` 中的 `TaskDeletionService` 统一完成，HTTP 路由不会自行执行 SQL 或删除文件。

删除范围仅限指定任务：

```text
目标 tasks 记录
├── device_runs / check_results
├── task_logs
├── task_outputs
└── data/tasks/{taskId}
```

APK 和 MP4 只有在数据库确认没有其他任务引用、且磁盘路径通过白名单校验时才会清理。共享素材、设备数据、其他任务和 SQLite 文件不会被删除。文件会先移动到 `data/.trash/delete-{uuid}`，数据库事务成功后才永久清理；事务失败会回滚数据库并恢复文件。

成功响应示例：

```json
{
  "taskId": "task-xxx",
  "deletedAt": "2026-07-30T12:00:00.000Z",
  "deletedRecordCounts": {
    "tasks": 1,
    "deviceRuns": 1,
    "checkResults": 12,
    "logs": 35,
    "outputs": 1
  },
  "deletedArtifactIds": [],
  "retainedArtifactIds": ["artifact-shared-apk"],
  "fileCleanupWarnings": []
}
```

错误约定：

```text
400 INVALID_TASK_ID
404 TASK_NOT_FOUND
409 TASK_NOT_DELETABLE
409 TASK_STATE_CHANGED
500 TASK_DELETE_FAILED
```

删除摘要写入 `task_deletion_audits`，审计记录不关联 `tasks` 外键，因此目标任务删除后仍可追踪。目前执行人记录为 `local-user`。

## 真实数据删除前备份

第一次对真实任务使用删除按钮前，执行：

```bash
pnpm backup:data
```

如果当前环境只通过 Corepack 提供 pnpm：

```bash
corepack pnpm backup:data
```

备份输出到：

```text
data/backups/cloud-test-{时间}/
├── cloud-test.sqlite
├── artifacts/
├── tasks/
└── manifest.json
```

脚本使用 Node SQLite 在线 backup 接口生成一致的数据库备份，不是只复制可能仍依赖 WAL 的主数据库文件。备份先写入 `.incomplete-*` 临时目录，全部完成后再原子改名。`manifest.json` 会记录备份时间和各表行数。

恢复前应停止 API 服务，再将备份数据库、`artifacts` 和 `tasks` 恢复到单独的 `CLOUD_TEST_DATA_DIR` 进行验证；不要直接覆盖仍在运行的真实服务目录。

## 关键前端文件

| 层级 | 文件 | 作用 |
|---|---|---|
| 入口 | `index.html`、`web/src/main.tsx` | 浏览器页面和 React 挂载点 |
| 路由 | `web/src/App.tsx` | 地址与页面组件映射 |
| 数据类型 | `web/src/types/index.ts` | Task、Run、Artifact、Output 等类型 |
| 数据访问 | `web/src/platform/client.ts` | 决定使用真实 API 或 Mock |
| 数据访问 | `web/src/platform/httpClient.ts` | 上传、创建任务、轮询和报告 API |
| 数据访问 | `web/src/platform/mockClient.ts` | 无后端时的浏览器演示 |
| 删除深模块 | `apps/api/src/task-deletion.ts` | 删除计划、事务、隔离区、素材引用检查和审计 |
| 删除路由 | `apps/api/src/routes/task-deletion-route.ts` | 将删除结果和领域错误转换成 HTTP 响应 |
| 任务操作 | `web/src/features/tasks/TaskActions.tsx` | 查看、删除、禁用原因和二次确认 |
| 数据备份 | `scripts/backup-cloud-test-data.mjs` | SQLite 在线备份及 tasks/artifacts 文件备份 |
| 创建任务 | `web/src/pages/CreateTaskPage.tsx` | 保留真实 File、上传 APK/MP4、创建任务 |
| 执行详情 | `web/src/pages/ExecutionPage.tsx` | 阶段、进度、检查项和日志 |
| 测试报告 | `web/src/pages/ReportPage.tsx` | 输入/输出信息、在线播放和下载 |
| 样式布局 | `web/src/styles.css` | Flex、Grid、间距、颜色和视频区域 |

## 当前限制

1. 第一版真实调度只允许 `honor-magic-v3`；
2. 一台设备同一时间只运行一个任务；
3. 服务重启后，遗留 running 任务标记为 `SERVICE_RESTARTED`；
4. SQLite 使用 Node 内置 `node:sqlite`，启动时可能显示 ExperimentalWarning；
5. 第一版使用 Android 播放器验证输出可播放，尚未接 ffprobe、黑帧或绿帧分析；
6. 截图和完整 logcat 会落盘，报告页提供下载/查看入口；文件尚未生成时接口返回明确的 404；
7. 真实 SDK 未提供前，平台链路可以运行到 APK，但任务不能通过。
