# 项目交接文档：Android 真机自动化稳定性修复

> 更新时间：2026-08-05（Asia/Shanghai）
> 项目根目录：`/Users/hanzhen/Documents/云测试的项目`
> 当前分支：`main`
> 当前 HEAD：`bdf9003`（`chore: establish phase 0 baseline`）
> 交接对象：完全没有本会话上下文的新 Codex 会话

---

## 0. 接手后第一件事

先执行只读检查：

```bash
cd '/Users/hanzhen/Documents/云测试的项目'
git status --short
git diff --check
git diff -- apps/api/src/adb.ts \
  apps/api/src/apk-protocols.ts \
  apps/api/src/execution/adb-streams.ts \
  apps/api/src/execution/morpho-startup.ts \
  apps/api/src/execution/android-app-preparation
```

**不要先执行任何恢复、清理、格式化或暂存操作。** 当前工作区有大量跨阶段、跨任务的已暂存和未暂存改动；不少文件是 `MM` 状态，说明同一文件同时包含已暂存旧改动和未暂存新改动。

绝对禁止在没有逐文件确认归属前执行：

```bash
git reset
git reset --hard
git clean -fd
git checkout -- .
git restore .
git add -A
pnpm prettier --write .
```

本轮没有执行 stage、commit、reset、clean，也没有创建分支。

---

## 1. 我们在做什么

当前主任务是修复 Android 真机 APK 自动化流程中的三类问题，同时确保不影响数据库、前端框架、任务队列和其他厂商的安装弹窗逻辑：

1. **服务健康检查误报与 ADB 重复扫描**
   - API 实际在线，但健康接口因隐式 ADB 扫描或异常 Network Endpoint 被拖慢，前端误报“服务未启动”；
   - `listRegistered()` 曾把“读取设备”与“真实发现设备”耦合；
   - 首页轮询可能重复触发全量 ADB 扫描，增加 ADB daemon 压力。

2. **小米 15 Pro / HyperOS 安装弹窗和输入权限问题**
   - 需要严格识别 Morpho APK 的 HyperOS USB 安装确认页；
   - 弹窗识别成功后，HyperOS 可能拒绝 `adb shell input tap`，错误为 `SecurityException / INJECT_EVENTS`；
   - 该问题通常是设备没有真正开启或保留“USB 调试（安全设置）”，代码不能绕过系统安全策略。

3. **整体自动化变慢、Mate X5 卡在 Morpho SDK 流程**
   - 共享执行链路长期采集全量 Verbose Logcat，尤其会占用 Network ADB；
   - 旧逻辑把 `am start` 成功当作 Morpho 业务已启动，实际服务没启动时仍可能进入最长 900 秒的无效处理等待；
   - 最新一轮修复集中解决这一问题，**没有改 APK 安装协调器，也没有放宽任何厂商弹窗 Profile**。

当前代码和静态测试已完成，**现在主要卡在 Mate X5、小米 15 Pro、荣耀 X50 以及 Network Endpoint 的真机回归验收**。

---

## 2. 已经完成的内容

## 2.1 健康检查与设备扫描解耦

主要文件：

- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/devices/device-registry.ts`
- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/routes/device-routes.ts`
- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/routes/system-routes.ts`
- `/Users/hanzhen/Documents/云测试的项目/web/src/layouts/serviceHealth.ts`
- `/Users/hanzhen/Documents/云测试的项目/web/src/pages/DevicesPage.tsx`

已实现：

- `listRegisteredSnapshot(platform)`：只读取数据库中的设备、Endpoint 和队列快照，不执行 Provider/ADB，不写在线状态和 `lastSeen`；
- `refreshRegistered(platform)`：执行真实设备发现和状态刷新；
- 同一平台的并发全量刷新复用同一个 in-flight Promise，不把重复扫描排队；
- `GET /api/devices` 使用快照读取；
- `POST /api/devices/refresh` 执行真实刷新；
- `/api/health` 使用轻量快照，不应因 ADB、FFmpeg 或异常 Network Endpoint 阻塞；
- 设备页使用“快照 + 手动刷新”，刷新期间禁止重复点击；
- 前端健康状态已经分层为：

```text
checking / online / slow / degraded / retrying / offline / mock
```

判定约定：

| 检查结果 | 前端状态 | 文案 |
|---|---|---|
| HTTP 2xx 且 3 秒内返回 | `online` | 服务正常 |
| 超过 3 秒 | `slow` | 服务响应慢 |
| HTTP 4xx/5xx | `degraded` | 服务异常 |
| 第一次真实网络失败 | `retrying` | 正在重试 |
| 连续第二次网络失败 | `offline` | 服务未连接 |

重要现场结论：曾经有一次“服务失败”是**电脑/浏览器和服务所在设备连接了不同 Wi-Fi，处于不同局域网**。这种情况属于网络不可达，不是 API 内部异常。排查时先确认 IP、路由和 Wi-Fi，不要为了这个现象放宽健康检查或延长超时。

---

## 2.2 小米 15 Pro / HyperOS 严格安装弹窗 Profile

主要文件：

- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/dialog-profiles.ts`
- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/apk-protocols.ts`
- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/__fixtures__/xiaomi-hyperos-adb-install-confirmation.xml`

工作区中已经存在：

```text
xiaomi-hyperos-package-installer-v1
```

该 Profile 只允许：

- 厂商：Xiaomi、Redmi、POCO、小米、红米；
- 当前安装 APK：`com.morphoinc.videopostprocessor`；
- 窗口包：`com.miui.securitycenter`；
- 精确 component：

```text
com.miui.securitycenter/com.miui.permcenter.install.AdbInstallActivity
```

- 页面同时具备真实采集到的 HyperOS 文案和 resource-id；
- 点击目标只能是：

```text
resource-id=android:id/button2
text=继续安装
```

Profile 保持：

```ts
allowUncheckedConfirmation: false
```

原因是页面上的“拒绝后下次安装不再提示”复选框不是风险确认框，不能自动勾选。

该 Profile 只在 Morpho 协议的 `install.dialogAutomation.profileIds` 中启用，没有全局启用给其他 APK。

**不要看到其他页面也有“安装”“继续”“允许”就放宽这个 Profile。** 如果小米点击后出现第二层未知弹窗，必须先采集窗口、XML、截图和系统包身份，再新增独立 Profile。

---

## 2.3 HyperOS 输入权限拒绝的准确分类

主要文件：

- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/input-automation-compatibility.ts`
- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/device-readiness.ts`
- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/system-dialog-controller.ts`

已经集中识别以下精确错误组合：

```text
SecurityException
INJECT_EVENTS
Injecting input events requires the caller
injectInputEvent / injectInputEventToTarget
```

命中后转换为：

```text
DEVICE_INPUT_AUTOMATION_DENIED
```

小米提示明确说明：保持手机解锁，并在开发者选项开启“USB 调试（安全设置）”；Network ADB 同样受该设置限制。

安全边界：

- 普通网络断开、ADB 超时、daemon 错误和无关 `SecurityException` 不得误分类；
- 点击被拒绝时保存当前窗口、UI XML 和截图；
- 不自动重试确定性的 `INJECT_EVENTS` 拒绝；
- 不修改系统设置、不执行 `settings put`/`setprop`；
- 不引入 Accessibility、Appium、UIAutomator2、OCR 或固定坐标；
- 不从 Network Endpoint 偷偷回退到 USB。

设备侧正确处理顺序：

1. 手机亮屏并物理解锁；
2. 开启“USB 调试”；
3. 开启的是“USB 调试（安全设置）”，不要误认为“USB 安装”；
4. 若已显示开启，先关闭再重新开启，并完成 HyperOS 的账号/倒计时确认；
5. 撤销旧 USB 调试授权；
6. USB 重连并勾选“始终允许此计算机”；
7. 断开并重新建立 Network ADB；
8. 先测 USB Endpoint，再测 Network Endpoint。

---

## 2.4 最新完成：APK 自动化变慢与 Morpho 启动卡死修复

这是当前最重要、最新的一轮改动。

### A. 运行时 Logcat 改为业务 Tag 白名单

主要文件：

- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/adb-streams.ts`
- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/apk-protocols.ts`

旧命令是持续全量 Verbose：

```bash
adb logcat -b all -v threadtime '*:V'
```

现在运行时使用原生 Tag filter 和 `*:S`，Morpho 只采集：

```text
MORPHO
MorphoVideoPProc/Controller
MorphoVideoPProc/Decoder
MorphoVideoPProc/Encoder
MorphoVideoPProc/Interface
MorphoVideoPProc/Parser
MorphoVideoPProc/Sensor
MorphoVideoPProc/Stabilizer
MorphoVideoPProc/WDR
```

平台载体只采集：

```text
SDK_COMPAT
```

命令形态：

```bash
adb logcat -T 1 -v threadtime <业务Tag>:V '*:S'
```

`-T 1` 用于避免任务开始前的旧 Morpho 日志被误认为本次任务的启动证据。

Logcat 启动时机已经后移到：

```text
APK 安装、权限与弹窗处理完成
→ 视频上传完成
→ 启动前设备检查完成
→ 才启动业务 Logcat
```

因此安装、弹窗、权限和视频上传阶段不再与全量日志流争抢 Network ADB。

### B. Morpho 增加 15 秒启动握手

新增文件：

- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/morpho-startup.ts`
- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/morpho-startup.test.ts`

`am start` 返回成功不再等于业务启动成功。现在必须得到以下任一证据：

```text
MORPHO_LOG
```

业务日志证据包含以下任意真实日志：

```text
Starting batch processing for path:
Found <n> mp4
Found mp4 file:
Processing file
Input:
Output:
```

或者：

```text
BATCH_SERVICE
```

Service 严格匹配：

```text
com.morphoinc.videopostprocessor/.BatchProcessService
```

或完整 component：

```text
com.morphoinc.videopostprocessor/com.morphoinc.videopostprocessor.BatchProcessService
```

时间规则：

- 0～3 秒：快速等待业务日志；
- 第 3 秒：开始检查进程、Service、屏幕和 Keyguard；
- 3～15 秒：每秒检查一次双证据和设备状态；
- 第 15 秒：结束启动阶段，不进入 900 秒无效等待。

失败分类：

| 状态 | 错误码 |
|---|---|
| Morpho 进程退出 | `APP_CRASHED` |
| 设备重新休眠或进入锁屏，Service 未启动 | `DEVICE_LOCKED` |
| Logcat 异常退出且无 Service 证据 | `LOGCAT_START_FAILED` |
| 进程存活、设备正常，但没有业务日志和 Service | `SDK_START_FAILED` |

业务 Intent 只发送一次，等待期间不会重复发送 `ACTION_BATCH_PROCESS`。

### C. 启动状态探测合并为一次 ADB shell

`/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/morpho-startup.ts` 中通过一次 shell 调用收集：

```text
dumpsys activity services
pidof
dumpsys power
dumpsys window policy
```

目的：避免每秒发送四条独立 ADB 命令，减少 Network ADB 往返压力。

状态探测还受启动阶段剩余时间限制，避免出现“15 秒业务超时 + 多个 10 秒 dumpsys 超时”导致实际耗时远超 15 秒。

### D. 启动前设备检查改为只读优先

主要文件：

- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/device-readiness.ts`

视频上传后先执行只读检查：

```bash
dumpsys power
dumpsys window policy
```

行为：

- 已亮屏、可交互、无 Keyguard：不发送唤醒命令；
- 休眠：按需发送一次 `KEYCODE_WAKEUP`；
- 非安全 Keyguard：尝试 `wm dismiss-keyguard`；
- PIN、图案或密码锁：返回 `DEVICE_LOCKED`；
- 重新检查后仍不可交互，才使用 `KEYCODE_MENU` 作为兼容兜底；
- 小米拒绝输入：保持 `DEVICE_INPUT_AUTOMATION_DENIED`；
- 其他厂商仍保留 PowerManager 唤醒 fallback。

没有增加测试点击，没有绕过安全锁，也没有修改手机设置。

### E. 成功日志与失败诊断分离

成功任务只保存过滤后的：

```text
logcat.txt
```

业务日志上限：

```ts
Math.min(config.maxLogcatBytes, 16 * 1024 * 1024)
```

全局 `MAX_LOGCAT_BYTES` 默认值仍是 256 MiB，没有修改全局环境变量语义。

非取消失败任务额外执行一次：

```bash
adb logcat -d -b all -v threadtime
```

保存到：

```text
diagnostics/logcat-full-failure.txt
```

失败快照最多 16 MiB，只读取一次，不启动第二条持续流，不清空设备缓冲区；采集失败只记告警，不能覆盖原任务错误。取消任务不采集。

注意：代码中仍出现的 `-b all` 是**一次性失败快照**，不是运行时全量 Verbose 回归。不要仅凭搜索到 `-b all` 就删除它。

### F. 增加阶段耗时日志

主要文件：

- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/adb.ts`
- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/android-app-preparer.ts`
- `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/contracts.ts`

现在任务日志记录：

```text
APK 安装耗时
权限与启动前兼容处理耗时
应用准备总耗时
视频上传与远端校验耗时
Morpho 启动握手耗时
SDK 处理耗时
输出验证与回收耗时
```

启动握手还记录：

```text
证据=MORPHO_LOG
```

或：

```text
证据=BATCH_SERVICE
```

没有修改数据库结构，仍写入现有任务日志。

---

## 3. 明确没有修改或不应修改的范围

最新“自动化变慢/Morpho 卡死”修复没有修改：

```text
/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/apk-install-coordinator.ts
```

也没有为了性能问题修改小米、荣耀、vivo、OPPO 的弹窗匹配条件。

当前 Git 状态中 `dialog-profiles.ts` 显示已有修改，是此前小米/荣耀适配工作，不是最新性能修复新增的改动。不要因为文件同时出现在 diff 中就把所有变化归因于本轮。

不要修改以下范围，除非新的真机证据明确证明必须修改：

- HTTP API 契约；
- 数据库结构、Migration 和历史数据；
- 前端框架；
- 任务队列和同一物理设备的串行语义；
- Endpoint 选择、冻结和连接模式；
- USB/Network 之间的显式选择；
- Android APK 工程；
- 依赖、pnpm 版本、React、Fastify 或构建框架。

---

## 4. 当前验证状态

最近一次代码级验证结果（2026-08-05）：

### 定向测试

```text
7 个测试文件通过
59 个测试通过
```

覆盖：

- Logcat Tag 白名单；
- 业务日志 16 MiB 独立上限；
- 一次性失败快照；
- 3 秒诊断和 15 秒硬上限；
- 5 秒、12 秒出现业务日志；
- BatchProcessService 独立证据；
- 进程退出、锁屏、Logcat 失败分类；
- 单次启动状态 Probe；
- 小米输入权限错误；
- APK 安装协调器和系统弹窗控制器回归。

### 全量测试

```text
40 个测试文件通过
214 个测试通过
```

### Web/API 构建

```text
build:web 通过
build:api 通过
```

Vite 只有原有大 Chunk 警告，不是构建失败，也不是本轮 Android 后端改动造成的功能错误。

### Android 构建

```text
BUILD SUCCESSFUL
32 actionable tasks: 32 up-to-date
```

### Diff 检查

```text
git diff --check
```

通过。

注意：以上结果是在写本交接文档前完成的。写入 `HANDOFF.md` 后只改变了 Markdown，不需要因此重复 Android 真机构建；若继续修改代码，应重新运行相关测试。

---

## 5. 当前卡在哪里

代码实现和自动化测试已经完成，目前没有已知 TypeScript/构建阻塞。真正的阻塞是**缺少最新真机无人值守回归结果**。

需要确认：

1. Mate X5 自然休眠后，上传完成时能否按需唤醒；
2. Morpho 是否能在 15 秒内取得 `MORPHO_LOG` 或 `BATCH_SERVICE`；
3. 小米 15 Pro 的第一层弹窗仍严格点击 `android:id/button2`；
4. 小米未开启“USB 调试（安全设置）”时是否准确返回 `DEVICE_INPUT_AUTOMATION_DENIED`；
5. 荣耀 X50 的已有 Profile 是否仍能识别真机页面；
6. 两台 Network ADB 并行时，总体耗时是否明显改善，且不隐式回退 USB。

Mate X5 曾出现“卡在 SDK 流程”，但随后单独重测又可以自动化，因此它不是稳定复现的单一厂商 Profile 问题。当前更可能是共享执行链路压力、设备休眠状态或把 `am start` 误判为业务启动。不要基于一次偶发现象给 Mate X5 写品牌特判。

---

## 6. 下一步计划

## 6.1 Mate X5 真机验收

建议流程：

1. 只选择 Mate X5；
2. 安装期间允许设备自然休眠；
3. 全程不人工触摸；
4. 检查任务日志中的阶段耗时；
5. 检查启动握手证据是 `MORPHO_LOG` 还是 `BATCH_SERVICE`；
6. 若失败，确认是否在约 15 秒内返回 `APP_CRASHED`、`DEVICE_LOCKED`、`LOGCAT_START_FAILED` 或 `SDK_START_FAILED`；
7. 确认没有进入 900 秒无效等待。

重点保存：任务 ID、DeviceRun ID、Endpoint、每阶段耗时、失败 diagnostics。

## 6.2 小米 15 Pro 真机验收

分两组：

### 安全设置开启

- 手机亮屏并解锁；
- 开启“USB 调试（安全设置）”；
- 先用 USB Endpoint；
- 全程不人工点击；
- 日志必须记录小米 Profile 的 `continue-install`；
- 不得点击“拒绝后下次安装不再提示”；
- Morpho 安装、启动和处理完成。

### 安全设置关闭

- 任务应快速返回 `DEVICE_INPUT_AUTOMATION_DENIED`；
- 不得反复点击；
- 提示必须指向“USB 调试（安全设置）”；
- 点击阶段失败时应保存 TXT、XML、PNG 诊断。

然后重新建立 Network ADB，再显式测试 Network Endpoint；不允许自动回退 USB。

## 6.3 荣耀 X50 回归

- 验证已有 Honor Profile 和 `honor-x50-safe-mode-install-sheet.xml` 对应流程；
- 如果仍不能识别，先采集该次真实窗口、component、XML 和截图；
- 对比 Fixture 是否已因 MagicOS 页面升级失效；
- 不要用通用文字放宽已有 Profile。

## 6.4 Network ADB 并行验证

- 同时运行两台设备；
- 对比修复前后的安装、上传、启动和处理耗时；
- 确认运行时命令不再包含 `-b all '*:V'`；
- 确认成功任务日志只有业务 Tag；
- 失败任务才生成一次 `diagnostics/logcat-full-failure.txt`；
- 确认设备 Endpoint 记录与用户显式选择一致。

## 6.5 真机有问题时的诊断顺序

按此顺序，不要直接改代码：

1. 确认任务使用的物理设备和 Endpoint；
2. 确认电脑与 Network Endpoint 是否同一局域网；
3. 看阶段耗时，判断卡在安装、权限、上传、启动握手、SDK 处理还是输出回收；
4. 看启动证据和准确错误码；
5. 查看 `diagnostics/logcat-full-failure.txt`；
6. 涉及弹窗时采集 current window、UI XML、截图和 `pm path`；
7. 用真实证据补失败测试；
8. 最后才做最小代码修改。

---

## 7. 推荐验证命令

如果没有再修改代码，可先运行定向测试：

```bash
pnpm test -- \
  apps/api/src/execution/adb-streams.test.ts \
  apps/api/src/execution/morpho-startup.test.ts \
  apps/api/src/apk-protocols.test.ts \
  apps/api/src/execution/android-app-preparation/guards-and-permissions.test.ts \
  apps/api/src/execution/android-app-preparation/apk-install-coordinator.test.ts \
  apps/api/src/execution/android-app-preparation/system-dialog-controller.test.ts
```

完整验证：

```bash
git diff --check
pnpm test
pnpm build
./android/gradlew -p android assembleDebug
```

不要为了让测试变绿而删除真机 Fixture、降低严格匹配条件或跳过错误分类测试。

---

## 8. 踩过的坑：绝对不要再踩

### 8.1 不要把“读取设备列表”再次耦合到真实 ADB 扫描

`listRegisteredSnapshot()` 必须保持只读；真实刷新只能走 `refreshRegistered()`。否则健康接口和页面轮询会再次被异常 Endpoint 拖慢。

### 8.2 不要恢复首页每 5 秒真实扫描设备

健康轮询可以每 5 秒执行，但设备全量 ADB 扫描不能跟着健康轮询运行。设备页默认读快照，真实状态由手动刷新或任务开始前验证。

### 8.3 不要把 Wi-Fi/局域网不可达误认为后端代码故障

先确认电脑、浏览器、API 和 Network Endpoint 的 IP/路由。不同 Wi-Fi 导致的网络连接失败应显示“正在重试/服务未连接”，不能用延长后端超时掩盖。

### 8.4 不要把 `am start` 成功当作 Morpho SDK 已启动

必须以 `MORPHO_LOG` 或 `BATCH_SERVICE` 为证据。进程存活、MainActivity 显示或命令退出码 0 都不够。

### 8.5 不要恢复运行时全量 Verbose Logcat

禁止重新长期执行：

```bash
adb logcat -b all -v threadtime '*:V'
```

它会占用 Network ADB，拖慢安装、上传和启动。`-b all` 只保留给失败时的一次性快照。

### 8.6 不要把启动等待改回 45 秒或直接进入 900 秒等待

当前硬上限是 15 秒，并有 3 秒快速诊断。若真机稳定超过 15 秒，先收集多台设备的数据，再统一调整；不要按品牌写死 30/45 秒，更不要无证据地放大超时。

### 8.7 不要每秒发四条独立 ADB 状态命令

Morpho 启动状态已经合并为一次 shell Probe。拆开会增加 Network ADB 往返和超时叠加。

### 8.8 不要重复发送 `ACTION_BATCH_PROCESS`

启动握手等待期间只能检查证据，不能为了“重试”重复发 Intent，否则可能重复处理、覆盖输出或制造并发服务状态。

### 8.9 不要用通用文案或固定坐标处理厂商弹窗

禁止仅凭“安装”“继续”“允许”“下载”匹配，禁止固定屏幕坐标、OCR、截图模板盲点。必须验证厂商、APK 身份、系统包、component、关键文案、resource-id 和节点 bounds。

### 8.10 不要自动勾选小米的“拒绝后下次安装不再提示”

它不是风险确认，当前 Profile 明确 `allowUncheckedConfirmation: false`。

### 8.11 不要用代码绕过 HyperOS 安全设置

`INJECT_EVENTS` 是系统权限拒绝，不是瞬时网络错误。不要无限重试，不要自动改设置，不要引入 Accessibility，也不要把人工点击记作平台自动处理成功。

### 8.12 不要因 Network Endpoint 失败偷偷切 USB

任务必须使用已经选择并冻结的 Endpoint。Network 失败就返回真实错误；隐式切换会让执行记录失真，也破坏连接模式语义。

### 8.13 不要把所有 `SecurityException` 都归为输入权限错误

只有同时命中输入注入特征才返回 `DEVICE_INPUT_AUTOMATION_DENIED`。ADB 断线、超时和其他权限问题必须保留原始错误。

### 8.14 不要修改全局 `MAX_LOGCAT_BYTES` 默认值

全局仍是 256 MiB。本次只在业务日志和失败快照调用点使用最多 16 MiB 的局部限制，不能影响普通 ADB 命令、push、pull、截图和 UI XML。

### 8.15 不要破坏工作区中的混合改动

当前仓库大量文件同时存在 staged/unstaged 内容。新会话必须按文件、按 hunk 审查，不能用全仓恢复或全仓暂存。尤其不要顺手修改与本任务无关的文档尾随空格、依赖或框架配置。

---

## 9. 新会话应重点阅读的文件

按优先级：

1. `/Users/hanzhen/Documents/云测试的项目/apps/api/src/adb.ts`
2. `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/morpho-startup.ts`
3. `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/morpho-startup.test.ts`
4. `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/adb-streams.ts`
5. `/Users/hanzhen/Documents/云测试的项目/apps/api/src/apk-protocols.ts`
6. `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/device-readiness.ts`
7. `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/system-dialog-controller.ts`
8. `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/dialog-profiles.ts`
9. `/Users/hanzhen/Documents/云测试的项目/apps/api/src/execution/android-app-preparation/input-automation-compatibility.ts`
10. `/Users/hanzhen/Documents/云测试的项目/apps/api/src/devices/device-registry.ts`
11. `/Users/hanzhen/Documents/云测试的项目/web/src/layouts/serviceHealth.ts`

---

## 10. 一句话交接结论

**健康检查/设备扫描解耦、小米 HyperOS 严格弹窗识别与输入权限分类、Morpho 业务 Logcat 白名单及 15 秒双证据启动握手均已在当前工作区实现并通过代码级测试；现在不要继续猜测式改代码，应先完成 Mate X5、小米 15 Pro、荣耀 X50 和 Network ADB 的无人值守真机回归，并用阶段耗时与 diagnostics 决定是否需要下一次最小修复。**
