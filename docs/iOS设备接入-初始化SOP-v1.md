# iOS 设备接入 · 初始化 SOP（v1）

> 适用范围：实验室每一台新接入的 iPhone 真机。目标：一次走完后，设备具备被平台
> 自动化调度的全部前提能力（USB 配对、开发者模式、证书信任、Wi-Fi 网络连接），
> 并在设备台账中留有完整记录。对应里程碑 M0。
>
> 每一步的「存证」要求：手机屏幕截图或终端输出粘贴，归档到设备台账目录，
> 后续做自动化 profile（控件定位素材）时直接复用。

## 前置条件

| 项 | 要求 |
|---|---|
| 宿主机 | 实验室固定 Mac，已装完整 Xcode（含 devicectl） |
| 工具链 | `brew install libimobiledevice`；`SETUP=1 bash scripts/step0-ios-verify.sh` 装 pymobiledevice3 |
| 网络 | 实验室 Wi-Fi 与宿主 Mac 同网段，路由器可做 DHCP 地址保留，**未开客户端隔离** |
| 材料 | 被测 IPA（已签名）；证书信息（类型 / 到期日）来自 app 团队 |

## 初始化步骤

### 1. USB 配对
USB 连接 Mac，手机弹「信任此电脑」→ 信任 + 输设备密码。
- 验收：`idevice_id -l` 能列出 UDID
- 注意：设备端「重置位置与隐私」会清掉配对；配对记录绑定在这台 Mac 上，换 Mac 需重做

### 2. 开发者模式（需重启）
设置 → 隐私与安全性 → 开发者模式 → 开启 → **重启** → 解锁后生效。
- 验收：设置里开发者菜单出现
- 存证：截图（菜单路径随 iOS 版本可能不同，截图记录当版路径）

### 3. 显示与锁屏
设置 → 显示与亮度 → 自动锁定 → **永不**。亮度调至固定值。
- 原因：锁屏状态 WDA 失明，自动化中断

### 4. 关闭自动更新
设置 → 通用 → 软件更新 → 自动更新 → 全部关闭。
- 原因：iOS 大版本升级 = 证书信任重置 + 设置页面结构变化 + WDA 兼容性风险

### 5. 清理系统干扰
- 登出 iCloud / Apple ID（若登录过）
- 设置 → 通知：全部关闭（防弹窗盖 UI）
- 关闭屏幕使用时间 / 内容限制（防安装拦截）

### 6. 安装被测 IPA + 证书信任（一次性）
```
xcrun devicectl device install app --device <UDID> <app.ipa>
xcrun devicectl device process launch --device <UDID> <bundle-id>
```
若启动报「未受信任的企业级开发者」→ 手动走信任流程：
设置 → 通用 → **VPN 与设备管理** → 点开发者 App 行 → 信任 → 确认。
- **全程截图存证**（这是后续自动化信任流程的 profile 素材：控件文案 = 定位依据）
- 原因：信任绑定签名证书而非单个 app，重装同证书 app 不需重做；iOS 大版本升级会重置

### 7. 启用 Wi-Fi 连接（USB 保持插着）
Xcode → Window → Devices and Simulators → 勾选设备的 **Connect via network**
（或设备端开发者菜单内的网络连接开关，以实机版本为准）。
- 存证：勾选截图

### 8. 固定 IP
路由器为设备 MAC 做 DHCP 地址保留，记录到台账。
- 原因：Wi-Fi 模式下 WDA 直连 `http://<设备IP>:8100`，IP 必须稳定

### 9. 拔线验证
拔掉 USB，依次确认：
```
xcrun devicectl list devices          # 设备仍在（Wi-Fi 可见）
bash scripts/step0-ios-verify.sh      # 第 10 段应 PASS
```
- 注意：设备重启后会停在锁屏，需人工解锁一次；iOS 17+ 深度操作依赖
  `sudo pymobiledevice3 remote tunneld` 守护在宿主机常驻

### 10. 整体验收
`bash scripts/step0-ios-verify.sh` 除第 9 段（WDA，等签名包）允许 BLOCKED 外，
其余应全 PASS / SKIP 可解释。

## 设备台账模板

| 字段 | 值 |
|---|---|
| UDID | （设备唯一身份，所有命令强制携带） |
| 设备名 / 型号 | |
| iOS 版本 / 系统语言 | （语言影响设置页控件文案 = 自动化定位） |
| 固定 IP | |
| 信任状态 / 信任日期 | |
| 证书类型 / 到期日 | （到期前一个月续签，过期 = app 全体启动秒退） |
| 接入日期 / 操作人 | |
| 备注 | |

## 常见故障

| 症状 | 排查 |
|---|---|
| 工具全部连不上设备 | `launchctl list \| grep -i usbmux` 查第三方守护（爱思助手残留）；卸载其驱动并重启 Mac |
| ideviceinfo 报未配对 | 重插 USB 重新信任；检查设备端是否被「重置位置与隐私」 |
| devicectl 装不了 app | 开发者模式没开 / IPA 签名不含本机 UDID |
| WDA 8100 无响应 | 设备锁屏、bundle id 与签名不一致、iproxy 未起 |
| Wi-Fi 段总 SKIP | Connect via network 没勾（要 USB 插着时勾）、客户端隔离、不在同网段 |
