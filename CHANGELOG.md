# 项目变更记录

本文件按功能或 Bug 独立记录业务行为、接口、状态所有权、验证证据和回退边界。

## 2026-08-14：一键连接全部联网设备及页面状态同步修复

### 问题和目标

- 新增对全部已配置联网 Endpoint 的一键连接能力，避免逐台点击。
- 修复批量连接已经在后端完成，但前端设备状态不自动刷新，必须再点击单台设备才显示全部连接结果的问题。
- 修复批量 operation 查询临时失败一次后永久停止轮询的问题。

### 已确认根因

- 开发环境启用了 React StrictMode。页面 Effect 清理时将 `mountedRef` 设为 `false`，再次建立时没有恢复为 `true`，导致 operation 查询结果被丢弃，也不会执行最终设备列表刷新。
- operation 查询异常分支只显示错误，没有重新安排轮询。

### 十项变更记录

1. **业务行为**：新增已配置联网 Endpoint 的批量连接、最多 3 并发、部分成功、忙碌跳过、服务端取消和进度展示；批量结束后页面自动重新读取设备快照。
2. **最终决策 Module**：`DeviceRegistryService`；ADB Provider 只执行命令并返回诊断证据。
3. **Interface**：新增批量创建、查询、取消 API；ADB 执行链增加可选 `AbortSignal`；原单台连接 API 保持兼容。
4. **状态唯一 Writer**：批量与 Endpoint 业务状态由 `DeviceRegistryService` 决定，SQLite 分别由 Operation Store 和 DeviceEndpointStore 写入；前端只读取权威快照。
5. **时序和取消**：增加异步 operation、最大并发 3、服务端取消、重启终止语义；前端轮询在 StrictMode 下可恢复，临时失败后继续查询并去重定时器。
6. **Failure/Evidence**：保存 ADB exit code、有界 stdout/stderr、超时、取消和身份失败；取消不伪装成普通失败。
7. **Fixture**：补充成功、部分失败、忙碌、取消、重复操作、服务重启、Migration 快照、StrictMode 和轮询重试测试。
8. **跨 Seam 测试**：相关前后端 7 个测试文件共 54 项通过；完整测试结果见提交验证。
9. **真机 Gate**：后端/API 已观察到真实设备批量结果；当前提交的浏览器自动刷新真机 UI Gate 尚未完成，不以自动化测试替代。
10. **独立回退**：现有单台连接 API 保留；批量 API、前端按钮和新增表可按提交边界回退；数据库结构回退必须使用 Migration 前备份，不直接改 checksum 或删除历史数据。

### 自动化证据

- StrictMode 修复前：批量终态后预期设备列表加载 3 次，实际 2 次。
- 查询重试修复前：预期第二次 operation 查询，实际只查询 1 次。
- 修复后：上述两个前端回归测试通过。
- 相关定向测试：54 passed。
- 全量测试最终复跑：53 个测试文件、383 项测试全部通过。
- 首次全量测试中的 `AdbStreams` 并发隔离用例曾出现 1 次时序失败；该用例随后独立连续运行 5 次均通过，全量复跑也通过。当前只能确认它具有偶发性，不能认定为本功能回归。
- Web 构建：通过。
- API 构建：通过。

### 当前运行证据

- `/api/health`：正常。
- 已登记设备：9。
- 当时在线设备：7。

### 回退边界

- 前端状态同步修复只涉及 `DevicesPage` 和对应回归测试，可独立回退。
- 后端批量能力涉及 Migration、Operation Store、Registry、Route、ADB Provider 和 ProcessRunner，应作为完整后端提交回退。
- 禁止手工修改 `schema_migrations.checksum`；若数据库结构需要恢复，使用 Migration 前备份。
