# SDK 视频兼容性测试平台（Phase 0 治理中）

> **当前正式开发基线（2026-08-10）**
>
> - 开发目录：`/Users/hanzhen/Documents/cloud-test-platform`
> - 分支：`main`
> - 稳定 commit：`3bd41668f0177121a7e6899d4cc771ce1944e6cd`
> - 稳定标签：`baseline/pkr110-stabilized-2026-08-09`
> - 历史混合工作树：`/Users/hanzhen/Documents/云测试的项目`，仅用于追溯和按业务切片迁移，不作为开发目录
> - 当前基线的验证范围和未完成机型 Gate，见 [`docs/当前稳定基线状态-2026-08-10.md`](docs/当前稳定基线状态-2026-08-10.md)。


这是一个**模块化单体**的本地 Android SDK 视频兼容性测试平台。当前阶段的目标不是增加网络 ADB、账号或新平台，而是先把现有 Android USB 真机流程治理稳定，让后续一期可以安全地扩展到 8 台 Android 真机的 USB 与受控网络 ADB 双连接。

## 当前边界

- **Phase 0（当前）：**风险止血、代码模块化、数据/进程可靠性、媒体完整性、中文文档和项目熟悉。
- **一期：**8 台 Android 真机完成 USB 与网络 ADB 兼容性测试闭环；每台设备继续保留 USB 数据线测试能力。
- **二期：**4 台 iOS、5 台鸿蒙真机完成有线与受控网络测试闭环，并尝试部署到服务器/公网。
- **三期：**稳定性、健壮性、SDK 业务场景、CI/CD、企业 SSO 和平台化治理。

Phase 0 明确不实现网络 ADB、远程 Runner、账号/RBAC、iOS、鸿蒙、公网部署、设备池、SDK 稳定性测试或 APK 签名白名单。不要把当前本地服务直接映射到局域网或公网。

> 当前安全模型：本机访问、可信内部人员、专用测试设备。当前服务不适合多人共享或公网使用。

## 一次任务的真实链路

```text
浏览器
  → Fastify API（127.0.0.1）
  → TaskService（校验任务、设备和磁盘）
  → SQLite Store（任务、设备、Artifact、DeviceRun、审计）
  → DeviceQueueManager（每台设备独立串行队列）
  → Android AdbWorker
  → AdbDeviceClient / AndroidAppPreparer / APK 协议适配器
  → USB ADB 真机
  → 拉回 output.mp4、日志、截图、UI XML
  → MediaIntegrityChecker（FFprobe 探测 + FFmpeg 完整解码）
  → 前端分别展示执行结论和媒体完整性结论
```

“执行流程通过”与“输出媒体有效”是两个独立维度。设备操作成功但输出文件损坏时，不能继续显示为完整通过。

## 目录和模块

```text
.
├── web/                         React + TypeScript + Ant Design 前端
├── apps/api/src/
│   ├── index.ts                 进程入口
│   ├── server.ts                Composition Root，只组装模块和生命周期
│   ├── config.ts                AppConfig 统一配置
│   ├── routes/                  HTTP 参数解析、校验和响应转换
│   ├── tasks/task-service.ts    任务用例入口
│   ├── devices/                 设备登记、发现和状态
│   ├── execution/               Android 执行深模块及进程/ADB 适配
│   ├── database/                migration、Store 和数据库契约
│   ├── artifacts.ts              上传、Artifact 生命周期和孤儿报告
│   ├── media-integrity.ts        基础媒体完整性
│   ├── process.ts                受控子进程（超时、取消、输出上限）
│   └── task-deletion.ts          任务、文件和数据库记录的一致删除
├── android/                     可选的测试 APK 工程
├── scripts/                     备份、恢复和孤儿 Artifact 报告
├── docs/                        中文架构、需求和学习资料
└── data/                        本地运行数据（已被 Git 忽略）
```

### 为什么保留模块化单体

现在只有一个本机用户和一台/少量专用设备，拆成微服务会增加部署、通信和排障成本。模块之间通过小接口连接：路由不知道 SQL，TaskService 不操作 ADB，Store 不编排任务，Android 执行器不负责 HTTP。未来真的出现第二种设备连接方式时，再在明确的 seam 上增加 Adapter，而不是提前创建空的 iOS/HarmonyOS/远程接口。

## 环境要求

- Node.js 22.5+（使用内置 `node:sqlite`，推荐 Node.js 24）
- pnpm 11
- Android SDK Platform Tools（ADB）
- Android Build Tools（AAPT）
- FFmpeg 和 FFprobe（由项目依赖提供，通常不需要全局安装）
- Android 构建需要 JDK 17

首次安装依赖：

```bash
corepack enable
pnpm install --frozen-lockfile
```

项目默认使用依赖中携带的 FFmpeg/FFprobe，不要求通过 Homebrew 等方式全局安装。只有需要切换自定义版本时，才配置 `FFMPEG_PATH` 和 `FFPROBE_PATH`；路径不可执行时，正式 API 会在启动检查阶段停止，避免服务带病运行。

## 配置和启动

复制 `.env.example` 为 `.env.local`，仅填写本机实际路径。最重要的原则是：**不配置 `ADB_SERIAL` 就不登记、不自动连接、不操作任何真机。**

```dotenv
API_HOST=127.0.0.1
API_PORT=3000
CLOUD_TEST_DATA_DIR=/absolute/path/to/cloud-test-data
ADB_SERIAL=仅在明确选择一台 USB 真机时填写
ADB_PATH=/absolute/path/to/android-sdk/platform-tools/adb
AAPT_PATH=/absolute/path/to/android-sdk/build-tools/36.0.0/aapt
# 通常不用填写；只有覆盖项目内置媒体工具时才设置
# FFMPEG_PATH=/absolute/path/to/ffmpeg
# FFPROBE_PATH=/absolute/path/to/ffprobe
```

开发启动：

```bash
pnpm dev
```

- Web：<http://127.0.0.1:5173>
- API：<http://127.0.0.1:3000>
- 前端默认连接真实 `/api`，不会因为遗漏环境变量而静默进入 Mock。
- 只有执行 `pnpm dev:web:mock` 或显式设置 `VITE_PLATFORM_MODE=mock` 才会进入纯前端演示模式；Mock 不能用于真机测试。

`pnpm dev:api` 和 `pnpm start:api` 会读取项目根目录中存在的 `.env.local`。开发页面会显示“Phase 0 · 本机单用户”。不要使用 `--host 0.0.0.0`，不要设置非 loopback 的 `API_HOST`，不要通过反向代理把 API 暴露到其他设备。

### 启动前检查

服务启动前会检查数据目录、子目录、磁盘最低剩余空间、ADB/AAPT/FFmpeg/FFprobe。任一项失败都会用清晰错误停止启动。这样可以在任务开始前发现环境问题，而不是测试中途产生难以解释的失败。

## 验证命令

```bash
pnpm test
pnpm build
./android/gradlew -p android assembleDebug
```

也可以分别检查：

```bash
./node_modules/.bin/tsc -p apps/api/tsconfig.json
./node_modules/.bin/tsc -p tsconfig.app.json
./node_modules/.bin/vitest run
```

CI 文件为 `.github/workflows/phase0-ci.yml`，包含 Web/API 测试构建和 Android `assembleDebug`。

## USB Android 真机使用原则

Phase 0 只治理现有 USB ADB 流程，不实现网络 ADB。连接真机前：

1. 只连接专用测试设备，不连接个人手机。
2. 通过数据线连接并在手机上确认 USB 调试授权。
3. 执行 `adb devices -l`，确认 Serial 与目标手机一致。
4. 只把该 Serial 写入 `ADB_SERIAL`。
5. 提交一条小任务，先观察日志、截图和 output.mp4，再进行正式验证。

测试 APK 当前不做签名证书白名单校验。签名证书指纹可以确认 APK 确实由可信开发者签名，防止同包名伪装；在白名单完成前，只能用“本机、可信人员、专用设备”作为补偿性边界。正式扩大使用范围前必须重新评估这个残余风险。

## 结果可信度规则

Phase 0 的媒体 Gate 只有：

- 文件存在且非空；
- FFprobe 能识别容器和视频流；
- FFmpeg 能从头到尾完整解码。

系统会记录容器、编码、分辨率、帧率、实际帧数、时长、音频流和编码等元数据，但以下指标**暂不影响通过/失败**：

- 总帧数是否为 808 或 808±5；
- 输入/输出分辨率是否一致；
- 输入有音频时输出是否必须有音频；
- 输入/输出帧率是否一致；
- 输入/输出时长偏差。

“自动回退执行结果”是指真实 UI/设备流程失败后，改用预设结果、模拟结果或旧文件继续判定成功。Phase 0 禁止这样做；任何真实失败都必须保留失败代码和原因。

## 数据目录、保留和清理

默认数据目录由代码位置推导，不依赖启动时 `process.cwd()`；也可以通过绝对路径 `CLOUD_TEST_DATA_DIR` 固定到指定磁盘。

建议保留策略：

| 数据 | 建议保留 |
|---|---:|
| 输入 APK、输入视频、输出视频、日志、截图、UI XML | 7 天 |
| Task/兼容性报告元数据 | 30 天 |
| 审计记录 | 180 天 |
| 金样本/问题复现样本 | 在引用期间保留 |

当前 Phase 0 不自动删除孤儿目录，只启动报告，避免误删证据。手动报告：

```bash
pnpm report:orphans
```

## 备份和恢复

备份脚本使用脚本自身位置定位项目根目录，因此从任何工作目录执行都指向同一数据目录：

```bash
pnpm backup:data
# 或 CLOUD_TEST_DATA_DIR=/absolute/path/to/data pnpm backup:data
```

备份目录包含 SQLite 在线备份、`manifest.json`、Artifact 和任务文件。恢复必须恢复到新的绝对路径，脚本拒绝覆盖非空目录：

```bash
pnpm restore:data /absolute/path/to/data/backups/cloud-test-... /tmp/cloud-test-restored
```

恢复后先用恢复目录启动一次并执行验证，不要直接替换正在运行的正式数据目录。数据库 migration 在有待迁移时会先生成 `data/backups/schema/before-migration-*.sqlite`，checksum 变化或迁移失败会阻止启动。

## 常见排障路径

| 现象 | 先看哪里 | 常见原因 |
|---|---|---|
| 页面打不开 | Web 终端、`/api/health` | Vite/API 未启动或端口占用 |
| API 返回 403 | API 日志、Host/Origin | 当前只允许 loopback |
| API 启动失败 | 启动终端 | 工具路径、磁盘、数据目录或 migration 检查失败 |
| 设备未上线 | 设备页、ADB 输出 | Serial 错误、USB 未授权、设备离线 |
| APK 上传失败 | API 日志、Artifact 目录 | 类型/大小/磁盘限制，临时文件会清理 |
| 任务停在执行中 | Task、DeviceRun、logcat | ADB、弹窗、APK 协议或设备状态 |
| 执行通过但报告失败 | DeviceRun 两个结果区 | 输出 MP4 不存在、不可探测或无法完整解码 |
| 找不到输出文件 | Artifact/Task 输出记录 | 执行失败或文件补偿清理 |

建议排障顺序：前端 → HTTP/API → TaskService → DeviceRun/队列 → ADB → 设备 → APK/SDK → FFprobe/FFmpeg → 文件和数据库。

## 修改需求应该从哪里开始

1. 先在 `docs/Phase0基础治理与项目熟悉手册.md` 和现有需求报告中确认范围，避免把一期/二期功能提前混入 Phase 0。
2. 如果是请求参数或响应展示：先看对应 `routes/` 和 `web/src/types/`。
3. 如果是任务规则：从 `TaskService` 开始，不在路由里写 SQL 或 ADB。
4. 如果是设备操作：从 Android 执行模块/Adapter 开始，不在 UI 里拼 ADB 命令。
5. 如果是文件生命周期：从 `ArtifactService` 或 `TaskDeletionService` 开始。
6. 如果是数据库字段：新增 migration、Store 测试和兼容字段，不直接改旧数据库。
7. 每批只解决一个风险或一个结构问题：先写测试，再小提交，最后记录回滚方式。

## Phase 0 交接练习

项目负责人完成以下练习即表示熟悉度达到进入一期前的最低要求：

- 启动/停止服务，运行 `pnpm test`、`pnpm build`。
- 连接一台已登记的 USB Android 设备并提交一条兼容性测试。
- 从页面和数据库中找到一个 Task、DeviceRun、logcat、截图和输出 Artifact。
- 判断一次失败属于前端、API、ADB、设备还是媒体文件。
- 修改一个小型校验规则并补一条测试。
- 用 Git 查看差异、提交，并在本地回滚自己的提交。
- 用 `pnpm backup:data` 备份，并恢复到一个新的绝对目录。

## 后续三期准入

只有 Phase 0 的 Git 基线、恢复方案、持续测试构建、loopback 访问、显式设备配置、上传/磁盘/进程/migration/孤儿治理、媒体完整性结论和中文交接资料全部通过，才开始一期的网络 ADB、PhysicalDevice、USB/网络双 Endpoint、设备租约和 16 条 Android 强制基线开发。

一期和二期仍必须给每台真机保留数据线连接测试能力。三期再评估稳定性、健壮性和 SDK 场景的长期运行模型；不能因为 Phase 0 已经有媒体完整性检查，就宣称已经完成稳定性或 SDK 业务测试平台。
