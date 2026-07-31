# SDK 云测试平台整体架构与后端学习指南

本文档用于说明当前 SDK 云测试平台的整体架构、后端框架、SQLite 数据库、ADB 真机执行流程、APK 执行协议，以及后续 iOS 与 HarmonyOS 的扩展边界。

> 适用项目：`云测试的项目`  
> 主要后端目录：`apps/api/src`

## 目录

1. 整体结论
2. 项目目录职责
3. 后端框架
4. 浏览器访问后端的过程
5. 后端 API
6. SQLite 数据库
7. 数据库表结构
8. SQLite 与磁盘文件的关系
9. ADB 基础
10. 多设备队列
11. ADB Worker
12. APK 执行协议
13. 无人值守安装模块
14. 多设备任务进度聚合
15. 当前架构优点
16. 当前架构问题
17. iOS 与 HarmonyOS 扩展情况
18. 后端学习顺序
19. 完整数据链

---

## 一、先给你一个整体结论

你现在这个项目已经不只是“一个前端页面”，而是一个可以本地运行的完整测试平台：

```text
React 前端
    ↓ HTTP API
Fastify 后端
    ↓
SQLite 数据库 + 本地文件目录
    ↓
设备队列
    ↓
ADB
    ↓
Android 真机
    ↓
Morpho APK 处理 MP4
    ↓
后端回收 output.mp4
    ↓
前端报告页面播放
```

你可以把几个部分口语化理解为：

| 模块 | 口语化理解 |
|---|---|
| 前端 React | 操作面板 |
| Fastify 后端 | 总指挥、调度中心 |
| API | 前端和后端之间的对话窗口 |
| SQLite | 记账本，记录任务、设备、结果 |
| `data/` 文件目录 | 仓库，真正存放 APK、MP4、日志 |
| 设备队列 | 排队系统 |
| ADB Worker | 真正操作手机的自动化工人 |
| APK 执行协议 | 告诉工人“这个 APK 应该怎么使用”的说明书 |
| UI Automator Profile | 识别并处理不同手机系统弹窗的白名单规则 |

---

## 二、项目完整目录分别负责什么

```text
云测试的项目/
├── web/                    前端 React 页面
├── apps/api/               后端 Fastify、SQLite、ADB
├── android/                平台自己的 Android 测试 APK
├── data/                   真实数据库和任务文件
├── dist/                   前端打包结果
├── node_modules/           安装的依赖
├── package.json            项目启动、测试、构建命令
├── vite.config.ts          前端开发服务器和 API 代理
└── README.md               项目说明
```

其中你现在最需要学习的是：

```text
apps/api/src/
```

后端主要结构是：

```text
apps/api/src/
├── index.ts                 启动后端
├── server.ts                注册所有 HTTP 接口
├── config.ts                路径、端口、ADB、AAPT 配置
├── types.ts                 后端核心类型
├── database.ts              SQLite 数据读写
├── database/
│   ├── schema.ts            数据库表结构和迁移
│   └── mappers.ts           数据库字段转换
├── artifacts.ts             APK、MP4 上传和校验
├── apk-protocols.ts         不同 APK 的执行说明
├── queue.ts                 多设备队列
├── adb.ts                   单次 Android 真机任务总流程
├── devices/                 ADB 设备扫描和录入
├── execution/               ADB 执行辅助模块
└── task-deletion.ts         安全删除任务
```

---

## 三、后端使用的是什么框架

后端技术组合是：

```text
Fastify
TypeScript
Node.js
node:sqlite
@fastify/multipart
```

### 1. Fastify

Fastify 和 Express 类似，主要负责：

```text
接收浏览器请求
→ 校验参数
→ 调用数据库或业务模块
→ 返回 JSON、MP4、图片、日志
```

后端启动入口是：

```text
apps/api/src/index.ts
```

核心代码逻辑非常简单：

```ts
const server = await buildServer()

await server.listen({
  host: config.host,
  port: config.port,
})
```

实际配置在：

```text
apps/api/src/config.ts
```

目前默认：

```text
host = 127.0.0.1
port = 3000
```

所以后端地址是：

```text
http://127.0.0.1:3000
```

### 2. `server.ts`

文件：

```text
apps/api/src/server.ts
```

它相当于后端的“总装配文件”。

启动时会创建：

```ts
const database = new PlatformDatabase()
const androidDeviceProvider = new AndroidAdbDeviceProvider()
const deviceRegistry = new DeviceRegistryService(...)
const adbWorker = new AdbWorker(database)
const queue = new DeviceQueueManager(database, adbWorker)
const artifactService = new ArtifactService(database)
const taskDeletionService = new TaskDeletionService(database)
```

口语化解释就是：

```text
准备数据库
→ 准备设备扫描器
→ 准备 ADB 工人
→ 准备任务队列
→ 准备文件上传模块
→ 准备任务删除模块
→ 注册 HTTP 接口
→ 恢复等待中的任务
```

---

## 四、浏览器是怎么访问后端的

前端开发服务器地址：

```text
http://localhost:5173
```

后端地址：

```text
http://127.0.0.1:3000
```

Vite 配置文件：

```text
vite.config.ts
```

里面有：

```ts
proxy: {
  '/api': 'http://127.0.0.1:3000',
}
```

因此浏览器发出：

```text
GET http://localhost:5173/api/devices
```

Vite 实际转发到：

```text
GET http://127.0.0.1:3000/api/devices
```

完整过程：

```text
前端页面
→ web/src/platform/httpClient.ts
→ fetch('/api/devices')
→ Vite 5173
→ Vite 代理
→ Fastify 3000
→ server.ts 对应路由
→ DeviceRegistryService
→ ADB / SQLite
→ 返回 JSON
→ 前端显示设备
```

前端决定使用真实后端还是 Mock 的文件是：

```text
web/src/platform/client.ts
```

规则是：

```text
配置 VITE_API_BASE_URL=/api
→ 使用 HttpTestPlatformClient
→ 访问真实 Fastify 后端

没有配置
→ 使用 MockTestPlatformClient
→ 数据保存在浏览器 localStorage
```

所以启动完整真实平台要使用：

```bash
npm run dev
```

或者：

```bash
npm run dev:api
npm run dev:web:real
```

如果只运行：

```bash
npm run dev:web
```

默认可能进入 Mock 模式，不会真正操作数据库和手机。

---

## 五、项目现在有哪些后端 API

### 1. 健康检查

```http
GET /api/health
```

作用：

```text
检查后端是否正常运行
统计已录入设备数量
统计在线设备数量
返回 Android/iOS/HarmonyOS 当前开放状态
```

---

### 2. APK 执行协议

```http
GET /api/apk-protocols
GET /api/apk-protocols/:id
```

作用：

```text
查看后端目前支持哪些 APK
查看 APK 的输入、安装、启动、输出、完成判断协议
```

当前支持：

```text
com.sdktest.platform
com.morphoinc.videopostprocessor
```

---

### 3. 设备接口

```http
GET /api/devices
POST /api/devices/discover
POST /api/devices/register
```

#### `GET /api/devices`

读取已经录入 SQLite 的设备，并结合当前 ADB 状态返回：

```text
设备名称
型号
厂商
Android 版本
API Level
ABI
Serial
是否在线
是否可执行
```

#### `POST /api/devices/discover`

执行：

```bash
adb devices -l
```

然后对在线设备执行：

```bash
adb -s {serial} shell getprop
```

读取设备详细信息。

#### `POST /api/devices/register`

输入：

```json
{
  "serial": "DE45R8ZPSGIBQOTC"
}
```

后端会重新扫描 ADB，确认设备：

```text
确实存在
已经授权
状态在线
```

然后写入 SQLite。

前端不能自己伪造设备型号或系统版本。

---

### 4. 文件上传接口

```http
POST /api/artifacts?kind=apk
POST /api/artifacts?kind=video
GET  /api/artifacts/:id
GET  /api/artifacts/:id/content
```

文件上传模块：

```text
apps/api/src/artifacts.ts
```

#### 上传 APK 时

后端执行：

```text
接收文件流
→ 检查是否为空
→ 检查文件大小
→ 检查 .apk 扩展名
→ 使用 AAPT 读取包名
→ 查找对应 APK 执行协议
→ 计算 SHA-256
→ 保存磁盘
→ 写入 artifacts 表
```

AAPT 的作用不是安装 APK，而是“查看 APK 身份”。

实际命令类似：

```bash
aapt dump badging test.apk
```

它读取：

```text
package name
version
application label
SDK 信息
```

读取到包名后，后端通过：

```text
apps/api/src/apk-protocols.ts
```

选择应该怎么操作这个 APK。

#### 上传 MP4 时

后端执行：

```text
检查文件非空
→ 检查 MP4 格式
→ 计算大小
→ 计算 SHA-256
→ 保存到 data/artifacts
→ 写入 artifacts 表
```

---

### 5. 任务接口

```http
POST   /api/tasks
GET    /api/tasks
GET    /api/tasks/:id
POST   /api/tasks/:id/cancel
DELETE /api/tasks/:id
GET    /api/tasks/:id/report
```

创建任务输入大致是：

```json
{
  "platform": "android",
  "name": "APK + MP4 Android 多真机兼容性测试",
  "apkArtifactId": "artifact-xxx",
  "videoArtifactId": "artifact-yyy",
  "deviceIds": [
    "adb-device-a",
    "adb-device-b"
  ],
  "testPlan": {
    "type": "sdk-video-processing-compatibility",
    "timeoutSeconds": 300
  }
}
```

后端会验证：

```text
任务名称存在
APK 已上传
MP4 已上传
APK 有执行协议
设备 ID 不重复
设备已录入
设备支持 ADB
设备当前在线
```

然后在一个数据库事务中创建：

```text
1 条 tasks
N 条 device_runs
```

例如选择三台设备：

```text
tasks
└── task-xxx
    ├── run-vivo
    ├── run-honor
    └── run-oppo
```

---

### 6. 日志和截图

```http
GET /api/tasks/:taskId/device-runs/:runId/logcat
GET /api/tasks/:taskId/device-runs/:runId/screenshots/final
```

每个设备运行都有自己独立的：

```text
logcat.txt
final.png
```

不会把三台手机的日志混在一起。

---

### 7. 输出视频

```http
GET /api/outputs/:id/content
GET /api/outputs/:id/download
```

#### `/content`

用于网页播放器，支持：

```http
Range: bytes=0-1023
```

返回：

```http
206 Partial Content
```

这就是为什么浏览器可以：

```text
播放视频
拖动进度条
从中间开始加载
```

#### `/download`

用于下载：

```text
output.mp4
```

---

## 六、SQLite 数据库是什么

是的，这个项目使用的是本地 SQLite。

数据库文件：

```text
data/cloud-test.sqlite
```

它不需要像 MySQL 一样再启动数据库服务器。

Fastify 进程直接通过：

```ts
import { DatabaseSync } from 'node:sqlite'
```

打开这个文件。

初始化位置：

```text
apps/api/src/database.ts
```

核心设置：

```ts
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
```

### `foreign_keys = ON`

表示启用外键关系。

例如删除一个任务时：

```text
tasks
→ device_runs
→ check_results
→ task_logs
→ task_outputs
```

该任务自己的数据可以级联删除。

但不会删除：

```text
devices
其他任务
仍被其他任务使用的 APK 和 MP4
```

### `journal_mode = WAL`

WAL 是 SQLite 的日志模式。

运行时可能看到：

```text
cloud-test.sqlite
cloud-test.sqlite-wal
cloud-test.sqlite-shm
```

这三个文件共同属于数据库运行状态。

因此后端运行时不要只复制：

```text
cloud-test.sqlite
```

来做备份。

项目已经提供了：

```bash
npm run backup:data
```

应该优先使用这个备份方式。

---

## 七、数据库每张表是什么意思

目前数据库共有八张主要表。

### 1. `devices`

设备档案：

```text
设备 ID
Serial
名称
厂商
型号
Android 版本
API Level
ABI
Build
安全补丁
最后在线时间
```

一台设备只保存一条。

---

### 2. `artifacts`

上传文件记录：

```text
APK
MP4
```

这里只保存：

```text
文件 ID
文件类型
原始文件名
磁盘路径
文件大小
SHA-256
APK 包名
```

不把 APK、MP4 二进制直接写进 SQLite。

---

### 3. `tasks`

一整个兼容性测试任务：

```text
任务名称
APK ID
视频 ID
任务状态
总体进度
通过率
超时时间
失败原因
创建时间
```

---

### 4. `device_runs`

每一台设备的独立执行记录。

例如一个任务选择三台设备：

```text
tasks：1 条
device_runs：3 条
```

每条记录包含：

```text
当前设备
当前阶段
当前进度
通过或失败
失败代码
开始时间
完成时间
```

---

### 5. `check_results`

每台设备的检查项：

```text
输入视频校验
应用启动
SDK 处理
输出生成
```

绑定的是：

```text
device_run_id
```

所以每一台设备都有自己的检查结果。

---

### 6. `task_logs`

平台实时日志。

例如：

```text
开始检查 ADB
正在安装 APK
已处理 vivo 安装弹窗
正在推送 MP4
Morpho 已发现输入视频
正在拉取 output.mp4
```

---

### 7. `task_outputs`

输出视频元数据。

这里只保存：

```text
output ID
task ID
deviceRun ID
磁盘路径
大小
SHA-256
MIME
```

真正的视频在磁盘中。

---

### 8. `task_deletion_audits`

删除审计。

即使任务被删除，仍会保留：

```text
删除了哪个任务
删除前是什么状态
删除了多少条记录
哪些素材被删除
哪些共享素材被保留
删除时间
```

---

## 八、SQLite 和磁盘文件是什么关系

这是一个非常重要的概念。

### SQLite 是“账本”

例如数据库记录：

```text
output-xxx
storage_path =
data/tasks/task-xxx/device-runs/run-xxx/output.mp4
size = 33791751
sha256 = ...
```

### `data/` 是“仓库”

真正的视频文件放在：

```text
data/tasks/{taskId}/device-runs/{runId}/output.mp4
```

因此：

```text
SQLite 记录“视频在哪里”
磁盘真正保存视频
```

不能只备份数据库而不备份 `data/tasks`。

也不能只保留 MP4 而删除数据库，因为前端不知道视频属于哪个任务和设备。

当前真实数据情况是：

```text
devices                 6 条
artifacts              15 条
tasks                   8 条
device_runs            22 条
check_results          76 条
task_logs             545 条
task_outputs           19 条
task_deletion_audits   15 条
```

当前整个 `data` 大约：

```text
1.8 GB
```

大致分布：

```text
data/artifacts    426 MB
data/tasks        610 MB
data/backups      793 MB
```

这说明后续必须考虑：

```text
备份保留周期
旧任务清理
重复 APK/MP4 去重
磁盘容量提醒
```

---

## 九、ADB 到底是什么

ADB 全称：

```text
Android Debug Bridge
```

它不是后端框架，也不是数据库。

它是电脑控制 Android 手机的工具。

你可以把它理解成：

```text
电脑和 Android 手机之间的命令通道
```

后端可以通过 ADB 完成：

```text
扫描手机
读取设备信息
安装 APK
卸载 APK
推送 MP4
启动 Activity
发送 Intent
读取日志
检查文件
拉取 output.mp4
截图
停止应用
```

项目所有系统命令最终通过：

```text
apps/api/src/process.ts
```

执行。

关键写法：

```ts
spawn(command, args, {
  shell: false,
})
```

而不是：

```ts
exec(`adb -s ${serial} shell ...`)
```

这样能避免字符串拼接产生的命令注入和路径转义问题。

---

## 十、多设备队列是怎么工作的

文件：

```text
apps/api/src/queue.ts
```

核心类：

```ts
DeviceQueueManager
```

它会给每一台设备建立一条独立队列：

```text
vivo 队列
├── 任务 A
└── 任务 B

荣耀队列
├── 任务 A
└── 任务 C

OPPO 队列
└── 任务 A
```

规则：

```text
同一台设备串行执行
不同设备并行执行
```

例如：

```text
vivo 正在执行任务 A
vivo 的任务 B 必须等待

荣耀可以同时执行任务 A
OPPO 也可以同时执行任务 A
```

队列中的最小任务不是整个 `taskId`，而是：

```ts
interface DeviceRunJob {
  taskId: string
  runId: string
  deviceId: string
}
```

所以一台设备失败不会直接停止其他设备。

---

## 十一、ADB Worker 是做什么的

文件：

```text
apps/api/src/adb.ts
```

主要类：

```text
AdbWorker
└── AdbRunExecutor
```

`AdbWorker` 负责接收队列任务。

`AdbRunExecutor` 负责完成一台设备的一次完整测试。

完整执行顺序：

```text
从数据库读取任务、设备、APK、MP4
→ 根据 APK 包名选择执行协议
→ 创建取消控制器
→ 检查设备在线状态
→ 读取厂商和型号
→ 准备 APK
→ 推送输入 MP4
→ 清理 logcat
→ 启动日志采集
→ 启动 APK
→ 监听处理进度
→ 等待完成标记
→ 检查手机端输出文件
→ adb pull 回电脑
→ 计算输出 SHA-256
→ 写 task_outputs
→ 保存 result.json
→ 保存 logcat
→ 截图
→ 更新任务为 passed
→ force-stop APK
→ 清理手机临时文件
```

失败时：

```text
捕获错误
→ 转换为 failureCode
→ 写入 device_runs
→ 写入 task_logs
→ 停止应用
→ 释放设备队列
```

---

## 十二、APK 执行协议为什么很重要

文件：

```text
apps/api/src/apk-protocols.ts
```

APK 执行协议相当于一份操作说明书：

```text
这个 APK 包名是什么
怎么安装
输入 MP4 放哪里
怎么启动
怎么判断进度
输出 MP4 放哪里
怎么判断完成
怎么取消
```

当前有两个协议。

### 1. 平台测试载体

包名：

```text
com.sdktest.platform
```

协议：

```text
覆盖安装
输入放 tasks/{taskId}/input/input.mp4
传 task_id
传 auto_run=true
APK 生成 result.json
APK 生成 output.mp4
```

### 2. Morpho

包名：

```text
com.morphoinc.videopostprocessor
```

协议：

```text
干净卸载后安装
输入放 VideoStabilizerDataPack
发送 ACTION_BATCH_PROCESS
通过 material_path 传输入目录
读取 MORPHO logcat
等待 .batch_processing_complete
寻找 *_stabilized.mp4
拉回电脑后统一保存为 output.mp4
后端生成 result.json
```

Morpho 手机输入目录：

```text
/storage/emulated/0/Android/data/
com.morphoinc.videopostprocessor/files/
VideoStabilizerDataPack/
```

输出目录：

```text
/storage/emulated/0/Android/data/
com.morphoinc.videopostprocessor/files/
VideoStabilizerDataPack/stabilized/
```

电脑统一保存：

```text
data/tasks/{taskId}/device-runs/{runId}/output.mp4
```

这就是为什么 AAPT 必须先读取包名：

```text
读取包名
→ 找到协议
→ 后端才知道怎么操作 APK
```

---

## 十三、无人值守安装模块在哪里

目录：

```text
apps/api/src/execution/android-app-preparation/
```

这部分已经被拆成了一个相对清晰的深模块。

对外主要接口：

```ts
prepareApplication(request)
```

内部复杂流程被隐藏起来。

### 主要文件

#### `android-app-preparer.ts`

总协调器：

```text
设备准备
→ 安装
→ 权限
→ 启动兼容提示
```

#### `device-readiness.ts`

负责：

```text
检查 ADB
点亮屏幕
尝试解除无密码锁屏
检测 PIN、图案、密码锁
```

#### `apk-install-coordinator.ts`

负责：

```text
干净卸载
启动 adb install
并行监控安装弹窗
验证安装完成
```

#### `runtime-permissions.ts`

负责：

```text
pm grant CAMERA
pm grant RECORD_AUDIO
dumpsys 验证授权
ColorOS 不允许 pm grant 时降级到 UI 自动处理
```

#### `system-dialog-controller.ts`

负责：

```text
读取当前窗口
读取 UI XML
确认系统包身份
调用 Profile 匹配
从 bounds 计算点击位置
保存未知弹窗诊断
```

#### `dialog-profiles.ts`

放不同厂商的严格白名单：

```text
vivo
荣耀
OPPO/ColorOS
Android Permission Controller
```

这里不是看到“继续”或者“确定”就点击。

需要同时确认：

```text
系统窗口包名
完整 Activity
手机厂商
应用名称
多个特征文案
resource-id
按钮 bounds
```

---

## 十四、任务进度是怎么从一台设备汇总成总体进度的

代码在：

```text
apps/api/src/database.ts
```

每次设备状态变化时会执行：

```ts
recomputeTaskState(taskId)
```

总体进度：

```text
所有 device_run.progress 的平均值
```

通过率：

```text
passed 设备数量 ÷ 全部设备数量 × 100%
```

状态规则：

```text
全部 queued                    → queued
存在 queued 或 running         → running
全部 passed                    → passed
全部结束但有 failed/blocked    → failed
用户取消                       → cancelled
```

前端不是自己猜任务状态，而是每秒请求：

```http
GET /api/tasks/:id
```

后端返回数据库中的真实状态。

轮询代码：

```text
web/src/platform/httpClient.ts
```

终态后停止：

```text
passed
failed
cancelled
```

---

## 十五、当前架构哪些地方设计得比较好

### 1. 文件与数据库分开

MP4 不写进 SQLite，避免数据库过大。

### 2. 每台设备独立 `device_run`

多设备的日志、结果、输出不会串在一起。

### 3. APK 执行协议独立

没有把 Morpho 的路径、Intent、完成判断散落到所有代码中。

### 4. Android 应用准备是独立深模块

厂商弹窗不会继续全部堆到 `adb.ts`。

### 5. 使用严格白名单

未知弹窗宁可失败，也不盲目点击。

### 6. 队列按设备隔离

一台设备失败不会阻塞其他设备。

### 7. 删除模块有事务、审计和文件隔离区

不会简单执行无条件删除。

### 8. 测试情况良好

我刚刚重新执行了：

```bash
npm test
```

结果：

```text
19 个测试文件通过
78 项测试通过
```

同时：

```bash
npm run build:api
npm run build:web
```

都构建成功。

---

## 十六、目前还存在的架构问题

### 1. `server.ts` 开始偏集中

目前 301 行，所有路由都放在一个文件里。

后续建议按领域拆分：

```text
routes/
├── health-routes.ts
├── device-routes.ts
├── artifact-routes.ts
├── task-routes.ts
├── report-routes.ts
└── output-routes.ts
```

`server.ts` 只负责组装。

---

### 2. `database.ts` 职责过多

当前 463 行，同时负责：

```text
设备
素材
任务
设备运行
检查项
日志
输出
报告
状态聚合
```

后续可以按模块拆成：

```text
database/
├── platform-database.ts
├── device-repository.ts
├── artifact-repository.ts
├── task-repository.ts
├── run-repository.ts
└── report-query.ts
```

但底层仍然可以共享一个 SQLite 连接和事务管理器。

---

### 3. `adb.ts` 仍然比较长

当前大约 549 行。

它已经把安装和权限拆出去了，但仍负责：

```text
输入传输
日志解析
任务完成判断
结果拉取
报告生成
清理
```

未来可以继续拆成：

```text
AndroidRunExecutor
├── InputTransferModule
├── ProgressCollector
├── CompletionDetector
├── OutputCollector
└── RunCleanupModule
```

---

### 4. 当前队列主要在内存中

队列状态的事实来源是 SQLite，但调度中的 Lane 在内存。

服务重启后：

```text
running → failed / SERVICE_RESTARTED
queued → 重新加载
```

这是 MVP 可接受方案，但不支持真正的断点恢复。

---

### 5. 数据会快速增长

当前 `data/` 已经约 1.8GB。

四台设备、每台一个 30MB 输出时，一个任务可能增加：

```text
120MB 输出
+ APK
+ 输入 MP4
+ 日志
+ 截图
+ 备份副本
```

后面要增加：

```text
磁盘使用量统计
输出保留时间
备份保留数量
素材 SHA-256 去重
任务归档
```

---

### 6. 当前视频验证比较基础

现在主要验证：

```text
文件存在
文件大小大于 0
完成标记存在
日志没有明显失败
```

还没有做：

```text
ffprobe 可解码检查
视频时长
音视频流
黑帧
绿帧
损坏帧
封装完整性
```

因此“passed”表示处理链路跑通，不等于视频质量完全正确。

---

### 7. 前端构建包偏大

当前前端 JS 打包后约：

```text
1.32 MB
gzip 后约 414 KB
```

Vite 已经给出 chunk 大于 500KB 的警告。

后续可以对：

```text
ECharts
Ant Design
报告页面
设备管理页面
```

使用动态导入和路由懒加载。

但这不影响现在本地运行。

---

## 十七、iOS 和鸿蒙扩展目前做到什么程度

目前已经存在一些预留：

```ts
type DevicePlatform =
  | 'android'
  | 'ios'
  | 'harmonyos'
```

设备执行方式也预留了：

```ts
'adb'
'simulated'
'xctest'
'hdc'
```

设备发现也有统一的接口：

```ts
interface DeviceDiscoveryProvider {
  platform: DevicePlatform
  discover(): Promise<...>
}
```

Worker 也有接口：

```ts
interface DeviceRunWorker {
  execute(job): Promise<void>
  cancelTask(taskId): void
}
```

这些是比较好的扩展缝隙。

但要注意：**iOS 和鸿蒙现在只是预留，并没有真正接入。**

当前仍然写死 Android 的地方包括：

```text
server.ts 创建的是 AndroidAdbDeviceProvider
server.ts 创建的是 AdbWorker
/api/devices 默认只查询 Android
POST /api/tasks 拒绝非 Android
ArtifactKind 只有 apk 和 video
tasks 表字段叫 apk_artifact_id
```

真正接入 iOS/HarmonyOS 时至少需要：

```text
IPA/HAP 素材类型
IosDeviceProvider
HarmonyDeviceProvider
XCTestWorker
HdcWorker
平台 Worker Router
平台安装协议
平台输入输出协议
前端平台创建任务表单
```

所以目前架构是：

```text
已经为多平台留了接口
但实际业务仍然是 Android 专用
```

这个判断要保持清楚。

---

## 十八、建议你按什么顺序学习后端

不要一开始直接读 549 行的 `adb.ts`，容易混乱。

### 第一阶段：先理解后端怎么启动

依次阅读：

```text
package.json
apps/api/src/index.ts
apps/api/src/config.ts
apps/api/src/server.ts
vite.config.ts
```

目标是理解：

```text
5173 是什么
3000 是什么
/api 是怎么转发的
Fastify 怎么启动的
```

### 第二阶段：学习 API 和类型

阅读：

```text
apps/api/src/types.ts
apps/api/src/server.ts
web/src/platform/httpClient.ts
```

目标是理解：

```text
前端传什么
后端收什么
后端返回什么
```

### 第三阶段：学习 SQLite

阅读：

```text
apps/api/src/database/schema.ts
apps/api/src/database.ts
apps/api/src/database/mappers.ts
```

重点先掌握：

```text
tasks 和 device_runs 的区别
外键是什么
事务是什么
级联删除是什么
```

### 第四阶段：学习文件上传

阅读：

```text
apps/api/src/artifacts.ts
apps/api/src/apk-protocols.ts
```

目标是理解：

```text
APK 为什么需要 AAPT
MP4 放在哪里
包名为什么决定执行协议
```

### 第五阶段：学习设备管理和队列

阅读：

```text
apps/api/src/devices/android-adb-provider.ts
apps/api/src/devices/device-registry.ts
apps/api/src/queue.ts
```

目标是理解：

```text
设备怎么发现
设备怎么录入
多设备为什么能并行
同设备为什么要排队
```

### 第六阶段：最后学习 ADB 执行

阅读：

```text
apps/api/src/adb.ts
apps/api/src/execution/adb-client.ts
apps/api/src/execution/adb-streams.ts
apps/api/src/execution/android-app-preparation/
```

目标是理解：

```text
一次 deviceRun 怎么从 queued 变成 passed
ADB 每一步执行了什么
失败代码从哪里产生
output.mp4 怎么回到电脑
```

---

## 十九、最重要的一条完整数据链

你只要先记住下面这一条，后端就不会那么抽象：

```text
CreateTaskPage 选择 APK、MP4、设备
→ HttpTestPlatformClient 上传文件
→ Fastify /api/artifacts
→ ArtifactService 保存文件
→ artifacts 表记录文件位置
→ Fastify /api/tasks
→ tasks 表创建任务
→ device_runs 为每台设备创建运行
→ DeviceQueueManager 排队
→ AdbWorker 读取任务资料
→ APK Protocol 决定怎么操作 APK
→ AndroidAppPreparer 安装并处理权限
→ adb push MP4
→ 启动 Morpho
→ 读取 MORPHO 日志
→ 等待完成标记
→ adb pull 输出视频
→ 保存 data/tasks/.../output.mp4
→ task_outputs 记录视频位置
→ 前端每秒查询任务状态
→ 报告页通过 /api/outputs/:id/content 播放视频
```

你可以把后端理解成三大部分：

```text
Fastify：对外接收请求
SQLite：记录事实和关系
ADB Worker：对内执行真机操作
```

这三个部分掌握以后，你就基本掌握了整个项目的后端核心。
