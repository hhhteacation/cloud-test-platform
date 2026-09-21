# iOS 自动化测试 · 需求与技术方案（v1）

> 2026-09-21 拍板。分支 `feat/ios-automation-v1`。本文是 iOS 线的需求基线与设计输入，
> 与 [iOS设备接入-初始化SOP-v1.md](iOS设备接入-初始化SOP-v1.md) 配套。

## 1. 目标与验收口径

把 Android 流水线（装包 → 跑视频 → 收 mp4 → 完整性校验 → 报告）在 **iPhone 真机**上
复刻进同一平台。**全链路验收硬标准：用户只在 web 界面操作（上传素材/选设备/看报告），
产物出现在报告页，全程不依赖 iMazing/爱思等任何外部手动工具。**

需求拍板记录：
- 首期范围：**全链路对齐 Android**（不先做窄口径）
- 设备形态：**真机 iPhone**（非模拟器）
- 测试触发：**UI 自动化**（WebDriverAgent 路线）
- 素材导入/导出：**平台内闭环**（iMazing/爱思仅留作人工救急）

## 2. 现状与接入口

仓库现状：iOS 仅有四件套预留（`DevicePlatform` 类型、`DeviceDiscoveryProvider` seam、
前端 `/platform/ios` 占位页、health `planned` 标记），零工具链代码。正式接入口 4 处：
`server.ts` provider 数组、`DeviceDiscoveryCandidate.platform` 字面量收窄、
`task-service` 平台白名单（现 409）、`ProtocolExecutor`/`DeviceRunWorker` 并列 seam。
架构遵循 `docs/项目详细架构分析.md` §22：iOS 实现与 ADB 并列，不继承 Android 细节。

## 3. 技术选型（与 Android 一一对应）

| 环节 | Android 现有 | iOS 方案 |
|---|---|---|
| 设备发现/信息 | adb devices + getprop | `xcrun devicectl`（官方） |
| 安装/启动 | adb install / am start | `xcrun devicectl install/launch` |
| 触发测试 | am broadcast（零 UI） | WDA（app 上监听 8100，宿主 HTTP 驱动，自封 `WdaClient`） |
| 日志流 | logcat | `idevicesyslog` |
| 截图 | screencap | WDA `/screenshot`（统一走 WDA，省一个工具） |
| 沙盒进/出 | adb push / pull | AFC（`pymobiledevice3`），前提 app 开 UIFileSharingEnabled |
| 完整性校验/报告 | 现有代码 | 复用，不改 |
| 崩溃诊断 | logcat-full | `idevicecrashreport` |

不引入 Appium（太重，平台是协议驱动不是通用框架）；不使用 idb（已归档）/ tidevice
（iOS 17+ 失效）。**通道差异（AFC/HTTP）封装在 iOS 执行器内部，前端与任务模型无感。**

UI 自动化不引入 Appium/XCUITest 做主驱动：协议是数据驱动的 TS 声明，WDA 的 HTTP
session API 与 `AdbDeviceClient` 平行封装为 `WdaClient` 即可。

## 4. 三大外部依赖 + 场景 A + 待确认项

| # | 依赖 | 影响 | 解法 |
|---|---|---|---|
| 1 | **WDA 签名**（无自有开发者账号） | 阻塞 M0 UI 段与 M3 | app 团队代签 WDA.ipa（UDID 注册进 profile），或提供 p12+mobileprovision 自签 |
| 2 | **输入通道** | 阻塞 M3 | app 开 UIFileSharingEnabled，AFC 写 Documents（等价 adb push）。装 IPA 后 `pymobiledevice3 apps list` 一测便知 |
| 3 | **输出通道** | 阻塞 M3 | app 产物写 Documents，AFC 拉回。相册路径：读出方向可行，写入方向开源工具做不到——若 app 只认相册需协调改 Documents 或 HTTP 局域网传输 |
| 4 | **场景 A：证书信任** | M2 内部消化 | 设置→通用→VPN与设备管理→信任。WDA 驱动设置 App 自动化（控件文案=定位，按 iOS 版本/语言做 profile）；信任绑证书不绑 app，属一次性动作 |
| 5 | 待确认：app 是否依赖 VPN 配置 | 若依赖，Face ID/密码验证是硬墙 | 若是：实验室设备免密策略实测；iOS 卸载 app 连带删 VPN 配置 → 执行器需「同版本跳过重装」 |

## 5. 协调清单（发给 app 团队，可直接复制）

> 我们正在把 iPhone 真机接入云测试平台做自动化兼容测试，需要和你们确认几件事：
> 1. **WDA 签名**：UI 自动化需要 WebDriverAgent.ipa 装到真机，我们没有开发者账号，
>    请帮忙代签（或提供 p12+描述文件我们自己签）；实验室 iPhone 的 UDID 列表随后提供。
> 2. **文件共享**：测试 IPA 请开启 `UIFileSharingEnabled`，否则测试素材无法写入沙盒。
> 3. **路径约定**：app 读输入视频、写输出 mp4 的目录与文件命名规则（期望都在
>    Documents/ 下，如 `Documents/inputs/*.mp4` → `Documents/outputs/*.mp4`）。
> 4. **VPN 依赖**：app 运行是否需要 VPN 配置？
> 5. **证书信息**：签名证书类型（企业签/开发签/AdHoc）与描述文件到期日。

## 6. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0（本周） | 工具链 spike（`scripts/step0-ios-verify.sh`）+ 初始化 SOP + 协调清单发出 | 脚本全绿或明确 BLOCKED 项；信任流程手动走通并截图存证 |
| M1 设备接入 | `IosDeviceProvider` 实现 seam、装配、DevicesPage 展示 | 页面看到 iPhone，型号/版本/UDID 正确 |
| M2 证据链 | 装 IPA、devicectl 启动、syslog 流、截图、evidence 目录对齐 + 场景 A 自动信任 | 平台完成一次安装→启动→证据落盘 |
| M3 全链路 | `WdaClient` + iOS 协议执行器 + AFC 产物回收 + 报告页放开 iOS | 一台 iPhone 完整跑完视频任务，报告页有 mp4，纯 web 操作 |
| M4 打磨 | Wi-Fi 无线调度（endpoint/自愈/切换）、崩溃诊断增强 | — |

关键路径：**M3 的工期取决于协调清单回复速度**（WDA 包、file sharing），所以清单最优先。

## 7. 安全与工程红线

- **p12 私钥 / 描述文件绝不进 git**（同 `.zcode/` 红线）；证书到期前一个月续签，过期 = 全体 app 启动秒退
- 全部设备命令**强制携带 UDID**（usbmuxd 默认操作第一台，多机必串台；学 `AdbDeviceClient` 强制 `-s` 先例）
- 多设备 iproxy 端口分配 8100/8101/…，映射进台账；设备身份永远 = UDID，IP 仅作端点
- WDA 会被系统杀：心跳探测 + 自动重启（网络 ADB 自愈经验平移）
- 「同版本跳过重装」的代价 = 沙盒残留，执行器跑前清 Documents 约定目录
- 爱思助手 Mac 版的 usbmuxd 守护与系统冲突：宿主机已装过爱思，step0 第 2 段自动检测
- pymobiledevice3 走 venv（`scripts/.venv-ios`，SETUP=1 自动创建）；Xcode 版本锁定不随手升
- 实验室 iPhone 统一系统语言（控件文案 = 自动化定位依据），台账记录

## 8. Wi-Fi 无线连接要点（初始化期配置，M4 调度）

iOS 无「tcpip 5555」式切换命令：USB 配对时勾 Xcode **Connect via network** → 同网段
mDNS 自动发现 → 路由器固定 IP。Wi-Fi 下 WDA 直连 `http://<设备IP>:8100`（无需 iproxy）；
深度操作（lockdown/AFC）依赖宿主机 `sudo pymobiledevice3 remote tunneld` 守护（iOS 17+）。
Wi-Fi 大文件（装 IPA/传视频）明显慢，传输策略 M0 实测后定。M0~M2 日常仍以 USB 为主。
