# ADR-0001：以 TaskVideo 和 VideoRunResult 建模多视频任务

- 状态：Accepted
- 日期：2026-08-14
- 决策者：产品负责人、平台实现方
- 关联需求：[多视频输入与左右视频对比测试报告需求基线](../多视频输入与左右视频对比测试报告-需求基线-v1.0.md)

## Context

当前任务表通过一个 `video_artifact_id` 引用单个输入视频；`device_runs` 以 `(task_id, device_id)` 唯一，输出、检查项和日志主要挂在设备执行下。这个模型能够表达“一条视频 × 多台设备”，但不能表达“多条视频 × 多台设备”。

多视频目标要求同时保留两个不同的执行作用域：

1. 设备级作用域：连接 Endpoint、设备准备、APK 安装、权限和设备级失败；
2. 视频级作用域：输入传输、视频处理、输出收集、媒体完整性、视频级失败和重试证据。

如果继续把所有状态放在 `DeviceRun`，同一设备上的多个视频会共享检查键、日志、输出文件名和失败状态，无法可靠追溯。若把每个视频直接建成独立 `DeviceRun`，又会丢失一个任务在一台物理设备上的共享准备上下文，并显著破坏现有设备队列和连接语义。

本决策很难在实现后低成本逆转，且存在多个真实替代方案，因此记录为 ADR。

## Decision

采用以下领域关系：

```text
Task
├── TaskVideo × N
├── DeviceRun × M
└── VideoRunResult × N × M
    └── VideoAttempt × 0..N
```

### 1. TaskVideo

`TaskVideo` 表示输入视频在某个任务中的身份，而不是视频文件内容本身。它引用不可变 Video Artifact，并保存任务内顺序和创建时展示名称。

约束：

- 一个任务至少一个、最多十个 TaskVideo；
- `(task_id, sequence)` 唯一；
- 同一任务不接受 SHA-256 相同的视频内容；
- TaskVideo 顺序在任务创建后不可修改。

### 2. DeviceRun

`DeviceRun` 继续表示一个 Task 分配到一台 Physical Device 的设备级运行上下文。它拥有设备连接、准备、共享环境和设备级结论，不因视频数量增加而复制为多个 DeviceRun。

同一物理设备的 DeviceRun 继续进入同一个串行设备 lane；不同设备的 lane 可以并行。

### 3. VideoRunResult

`VideoRunResult` 表示一个 TaskVideo 在一个 DeviceRun 上的结果。

约束：

- `(task_video_id, device_run_id)` 唯一；
- 状态、阶段、进度、失败、媒体完整性和主输出在视频级记录；
- 视频业务失败不终止同一 DeviceRun 的后续视频；
- 设备基础设施失败且恢复失败时，剩余 VideoRunResult 标记为 blocked。

### 4. VideoAttempt

每一次对 VideoRunResult 的物理处理尝试都产生一个新的 VideoAttempt。自动恢复或未来的手动重试不得覆盖已有 Attempt。

第一阶段不开放用户手动重试，但领域模型保留多个 Attempt；排队中的 VideoRunResult 可以尚无 Attempt。

### 5. 输出、检查项与日志作用域

- 正式主输出通过 `video_run_result_id` 关联视频执行结果；
- 每个 VideoRunResult 最多一个 `processed_video`；
- Check 同时支持设备级和视频级作用域；
- Log 同时支持设备级和视频级作用域；
- 设备级数据的 `video_run_result_id` 为空；
- 视频级数据必须提供 `video_run_result_id`；
- 原始文件名只用于展示，不能作为关联键或目录唯一键。

### 6. 历史兼容

- 保留 `tasks.video_artifact_id` 作为过渡兼容字段；
- 新任务将第一条 TaskVideo 的 Artifact ID 双写到该字段；
- 读取时以 `task_videos` 为多视频事实来源；
- 历史单视频任务迁移为一个 sequence=0 的 TaskVideo；
- 历史 DeviceRun 迁移为该 TaskVideo 对应的一个 VideoRunResult；
- 历史输出和检查项回填到该 VideoRunResult；
- 无法可靠区分作用域的历史日志保留为设备级日志。

## Alternatives Considered

### Alternative A：在 tasks 中保存 video_artifact_ids JSON

拒绝。JSON 数组不能自然表达任务内视频身份、稳定顺序、外键、唯一约束和视频级执行结果，查询和迁移也会把关联逻辑扩散到调用方。

### Alternative B：把每个“视频 × 设备”都建成 DeviceRun

拒绝。它会重复设备连接和 APK 准备语义，破坏现有 `(task_id, device_id)` 聚合关系，使设备级失败、连接 Endpoint 和共享准备证据难以表达。

### Alternative C：输出继续只关联 device_run_id，通过文件名区分视频

拒绝。文件名可重复、可变且不安全，无法承担稳定业务身份；统一的 `output.mp4` 也会在多视频目录中覆盖。

### Alternative D：一个 VideoRunResult 允许多个无角色输出

第一阶段拒绝。左右对比需要明确唯一主输出。未来可以增加输出角色和变体，但不能让调用方猜测哪个文件是主输出。

### Alternative E：第一阶段不建立 Attempt，只覆盖重试结果

拒绝。已接受的瞬时基础设施自动重试要求保留第一次失败证据；覆盖状态会让报告无法解释最终成功之前发生的故障。

## Consequences

### Positive

- 输入、设备、输出、检查和 Evidence 可以完整追溯；
- 保留现有设备队列和设备连接模型；
- 报告可以自然按视频导航、按设备切换；
- 视频失败与设备失败可以采用不同继续策略；
- 后续增加手动重试时不必破坏历史证据；
- 历史单视频任务可以平滑兼容。

### Negative

- 结果数量从设备数变为视频数 × 设备数；
- 状态和进度需要分层聚合；
- 检查项表需要重建唯一约束；
- 报告接口需要摘要与详情拆分，避免一次加载全部日志；
- 删除、保留和磁盘预算必须理解新的关联关系；
- 执行器目录和手机远端目录都必须增加视频级隔离。

### Risks

- 迁移时错误回填可能导致历史输出关联错误；
- 设备级和视频级失败若没有明确分类，剩余视频状态可能不一致；
- 双写兼容字段期间可能出现第一条视频与旧字段不一致；
- 未验证的 APK 批处理假设可能导致输出覆盖，因此第一阶段必须逐视频调用协议。

## Validation

本决策通过以下门禁验证：

1. 迁移测试：历史单视频任务回填 TaskVideo 和 VideoRunResult；
2. 约束测试：TaskVideo 顺序、视频设备组合和主输出唯一；
3. Store 测试：创建 N 条视频和 M 台设备时生成 N×M 条结果；
4. 兼容测试：旧 `videoArtifactId` 仍映射为一个 TaskVideo；
5. 真机测试：2 条 MP4 × 2 台设备的四条结果和输出全部正确关联。
