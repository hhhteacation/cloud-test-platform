#!/usr/bin/env bash
# Step 0 iOS 真机验证：工具链 + 设备能力一键探针（M0 spike）
# 用法: bash scripts/step0-ios-verify.sh
#       SETUP=1 bash scripts/step0-ios-verify.sh     # 自动创建 venv 并安装 pymobiledevice3
# 可选环境变量:
#   IOS_TEST_IPA=/path/to/app.ipa        提供后验证第7段（安装）与第8段（file sharing 探测）
#   IOS_BUNDLE_ID=com.xxx.yyy            配合 IOS_TEST_IPA，用于精确定位被测 app
#   IOS_WDA_IPA=/path/to/wda.ipa         WDA 签名包到位后提供，验证第9段
# 观察点：① 宿主机工具链是否齐 ② 有无第三方 usbmuxd 守护冲突（爱思助手残留）
#         ③ 设备发现/信息/日志/截图是否可用 ④ 被测 app 是否暴露文件共享（输入输出通道分叉）
#         ⑤ WDA 链路（装→启动→iproxy→/status） ⑥ Wi-Fi 网络可见性
# 每项输出 [PASS]/[FAIL]/[SKIP]/[BLOCKED]/[WARN]，结尾汇总；任何 FAIL 不中断后续段。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv-ios"
UDID=""
P3=""

PASS=0; FAIL=0; SKIP=0; BLOCK=0; WARN_N=0
RESULTS=()

mark() { # mark <状态> <说明...>
  local st="$1"; shift
  case "$st" in
    PASS)    PASS=$((PASS+1));;
    FAIL)    FAIL=$((FAIL+1));;
    SKIP)    SKIP=$((SKIP+1));;
    BLOCKED) BLOCK=$((BLOCK+1));;
    WARN)    WARN_N=$((WARN_N+1));;
  esac
  RESULTS+=("[$st] $*")
  printf "    [%s] %s\n" "$st" "$*"
}

section() { printf "\n==> %s\n" "$*"; }

die_summary() {
  echo ""
  echo "======== 汇总 ========"
  printf '%s\n' "${RESULTS[@]}"
  echo "PASS=$PASS FAIL=$FAIL SKIP=$SKIP BLOCKED=$BLOCK WARN=$WARN_N"
  [ "$FAIL" -gt 0 ] && exit 1
  exit 0
}

# ---------------------------------------------------------------- 1. 宿主机工具链
section "[1/10] 宿主机工具链"

echo "    xcode-select 路径: $(xcode-select -p 2>/dev/null || echo 未配置)"
if xcrun devicectl --help >/dev/null 2>&1; then
  mark PASS "devicectl 可用"
else
  mark FAIL "devicectl 不可用（需完整 Xcode：App Store 安装后 xcode-select --install / sudo xcode-select -s /Applications/Xcode.app）"
fi

for tool in iproxy idevice_id idevicesyslog idevicescreenshot; do
  if command -v "$tool" >/dev/null 2>&1; then
    mark PASS "$tool 可用 ($(command -v "$tool"))"
  else
    mark FAIL "$tool 缺失（brew install libimobiledevice）"
  fi
done

if command -v python3 >/dev/null 2>&1; then
  mark PASS "python3 可用 ($(python3 --version 2>&1))"
else
  mark FAIL "python3 缺失"
fi

if [ "${SETUP:-0}" = "1" ]; then
  if [ ! -x "$VENV_DIR/bin/pymobiledevice3" ]; then
    echo "    [setup] 创建 venv 并安装 pymobiledevice3 ..."
    python3 -m venv "$VENV_DIR" || { mark FAIL "venv 创建失败"; }
    "$VENV_DIR/bin/pip" install --quiet pymobiledevice3 || mark FAIL "pymobiledevice3 安装失败"
  fi
fi

if [ -x "$VENV_DIR/bin/pymobiledevice3" ]; then
  P3="$VENV_DIR/bin/pymobiledevice3"
  mark PASS "pymobiledevice3 可用 (venv: $P3)"
elif command -v pymobiledevice3 >/dev/null 2>&1; then
  P3="$(command -v pymobiledevice3)"
  mark WARN "pymobiledevice3 为全局安装，建议 venv 隔离（SETUP=1 重跑本脚本可自动创建）"
else
  mark FAIL "pymobiledevice3 缺失（SETUP=1 bash $0 一次性自动安装）"
fi

# ---------------------------------------------------------------- 2. 守护冲突检查
section "[2/10] usbmuxd 守护冲突检查（爱思助手等第三方残留）"
MUXD_LIST="$(launchctl list 2>/dev/null | grep -i usbmux || true)"
echo "$MUXD_LIST" | sed 's/^/    /'
MUXD_COUNT="$(echo "$MUXD_LIST" | grep -c . || true)"
if [ "$MUXD_COUNT" -le 1 ]; then
  mark PASS "仅系统 usbmuxd，无第三方守护"
elif echo "$MUXD_LIST" | grep -qv "com.apple.usbmuxd"; then
  mark WARN "检测到非 Apple 的 usbmuxd 相关守护——若设备连不上，先卸载爱思助手/其驱动并重启再试"
else
  mark PASS "usbmuxd 守护正常"
fi

# ---------------------------------------------------------------- 3. 设备发现
section "[3/10] 设备发现"
DEVCTL_OUT="$(xcrun devicectl list devices 2>/dev/null || true)"
echo "$DEVCTL_OUT" | sed 's/^/    /'
UDID="$(idevice_id -l 2>/dev/null | head -1 || true)"
if [ -n "$UDID" ]; then
  mark PASS "usbmux 已配对设备: $UDID"
else
  mark SKIP "未发现已配对设备（插 USB → 手机点『信任』→ 输密码，然后重跑）"
fi

# ---------------------------------------------------------------- 4. 设备信息
section "[4/10] 设备信息"
if [ -n "$UDID" ]; then
  INFO="$(ideviceinfo -u "$UDID" 2>/dev/null || true)"
  for key in DeviceName ProductType ProductVersion ModelNumber; do
    val="$(echo "$INFO" | grep "^$key: " | head -1 || true)"
    echo "    ${val:-($key 未读到)}"
  done
  if [ -n "$INFO" ]; then mark PASS "lockdown 信息可读"; else mark FAIL "ideviceinfo 无输出（检查配对/信任状态）"; fi
else
  mark SKIP "无设备，跳过"
fi

# ---------------------------------------------------------------- 5. 日志流采样
section "[5/10] idevicesyslog 采样（3 秒）"
if [ -n "$UDID" ]; then
  SYSLOG_TMP="$(mktemp -t ios-step0-syslog)"
  idevicesyslog -u "$UDID" >"$SYSLOG_TMP" 2>/dev/null &
  SYSPID=$!
  sleep 3
  kill "$SYSPID" 2>/dev/null
  wait "$SYSPID" 2>/dev/null
  SYSLOG_LINES="$(wc -l <"$SYSLOG_TMP" | tr -d ' ')"
  if [ "${SYSLOG_LINES:-0}" -gt 0 ]; then
    mark PASS "syslog 出流（3 秒 ${SYSLOG_LINES} 行），样本: $SYSLOG_TMP"
  else
    mark FAIL "syslog 无输出（设备可能已锁屏或配对异常）"
  fi
else
  mark SKIP "无设备，跳过"
fi

# ---------------------------------------------------------------- 6. 截图
section "[6/10] idevicescreenshot"
if [ -n "$UDID" ]; then
  SHOT="$SCRIPT_DIR/.step0-ios-screenshot.png"
  if idevicescreenshot -u "$UDID" "$SHOT" >/dev/null 2>&1 && [ -s "$SHOT" ]; then
    mark PASS "截图成功: $SHOT"
  else
    mark FAIL "截图失败（设备可能已锁屏）"
  fi
else
  mark SKIP "无设备，跳过"
fi

# ---------------------------------------------------------------- 7. 安装被测 IPA
section "[7/10] 安装被测 IPA"
if [ -n "${IOS_TEST_IPA:-}" ]; then
  if [ ! -f "$IOS_TEST_IPA" ]; then
    mark FAIL "IOS_TEST_IPA 文件不存在: $IOS_TEST_IPA"
  elif [ -z "$UDID" ]; then
    mark SKIP "无设备，跳过"
  elif xcrun devicectl device install app --device "$UDID" "$IOS_TEST_IPA" >/dev/null 2>&1; then
    mark PASS "IPA 安装成功（若为同版本重装，iOS 会覆盖安装）"
  else
    mark FAIL "IPA 安装失败（检查签名是否包含本机 UDID / 开发者模式是否开启）"
  fi
else
  mark SKIP "未提供 IOS_TEST_IPA，跳过（用法: IOS_TEST_IPA=xxx.ipa bash $0）"
fi

# ---------------------------------------------------------------- 8. 文件共享探测（输入/输出通道分叉）
section "[8/10] 被测 app 文件共享（UIFileSharingEnabled）探测"
if [ -z "$UDID" ] || [ -z "$P3" ]; then
  mark SKIP "无设备或缺 pymobiledevice3，跳过"
elif [ -n "${IOS_BUNDLE_ID:-}" ]; then
  AFC_OUT="$("$P3" apps afc --bundle-id "$IOS_BUNDLE_ID" --udid "$UDID" ls 2>&1 || true)"
  if echo "$AFC_OUT" | grep -qiE "error|not found|No such|Unable"; then
    mark FAIL "AFC 无法进入 $IOS_BUNDLE_ID 沙盒 → app 很可能未开 UIFileSharingEnabled（协调清单第2条）"
    echo "$AFC_OUT" | sed 's/^/    /'
  elif [ -n "$AFC_OUT" ]; then
    mark PASS "AFC 可进入 $IOS_BUNDLE_ID 沙盒 → Documents 通道成立"
    echo "$AFC_OUT" | sed 's/^/    /'
  else
    mark WARN "AFC 输出为空，人工确认: $P3 apps afc --bundle-id $IOS_BUNDLE_ID --udid $UDID"
  fi
else
  APPS_OUT="$("$P3" apps list --udid "$UDID" 2>&1 || true)"
  FS_HITS="$(echo "$APPS_OUT" | grep -c "UIFileSharingEnabled" || true)"
  echo "    apps list 输出中 UIFileSharingEnabled 出现 ${FS_HITS:-0} 次"
  if [ "${FS_HITS:-0}" -gt 0 ]; then
    echo "$APPS_OUT" | grep "UIFileSharingEnabled" | sed 's/^/    /'
    mark PASS "存在开启文件共享的 app（看上方列表；提供 IOS_BUNDLE_ID 可精确探测）"
  else
    mark WARN "未解析到 UIFileSharingEnabled 字段（pymobiledevice3 输出格式可能不同），人工跑: $P3 apps list --udid $UDID"
  fi
fi

# ---------------------------------------------------------------- 9. WDA 链路
section "[9/10] WDA 链路（装→启动→iproxy→/status）"
if [ -z "${IOS_WDA_IPA:-}" ]; then
  mark BLOCKED "未提供 IOS_WDA_IPA —— 等 app 团队代签的 WDA 包（协调清单第1条）"
elif [ -z "$UDID" ]; then
  mark SKIP "无设备，跳过"
else
  if xcrun devicectl device install app --device "$UDID" "$IOS_WDA_IPA" >/dev/null 2>&1; then
    mark PASS "WDA 安装成功"
    WDA_BID="${IOS_WDA_BUNDLE_ID:-com.facebook.WebDriverAgentRunner.xctrunner}"
    if xcrun devicectl device process launch --device "$UDID" "$WDA_BID" >/dev/null 2>&1; then
      mark PASS "WDA 启动成功（bundle: $WDA_BID；若 app 团队改过 bundle id，用 IOS_WDA_BUNDLE_ID 指定）"
      iproxy 8100 8100 >/dev/null 2>&1 &
      PROXY_PID=$!
      sleep 3
      STATUS="$(curl -s --max-time 5 http://localhost:8100/status || true)"
      kill "$PROXY_PID" 2>/dev/null
      if echo "$STATUS" | grep -q "sessionId\|state"; then
        mark PASS "WDA /status 响应正常: $(echo "$STATUS" | head -c 200)"
      else
        mark FAIL "WDA 8100 无响应（确认 app 签名 bundle id 正确、设备已解锁亮屏）"
      fi
    else
      mark FAIL "WDA 启动失败"
    fi
  else
    mark FAIL "WDA 安装失败（检查签名是否含本机 UDID）"
  fi
fi

# ---------------------------------------------------------------- 10. Wi-Fi 可见性
section "[10/10] Wi-Fi 网络可见性"
if echo "$DEVCTL_OUT" | grep -qiE "wireless|wifi"; then
  mark PASS "存在 Wi-Fi 连接的设备"
else
  mark SKIP "当前无 Wi-Fi 设备（初始化 SOP 第7步：Xcode Devices 勾 Connect via network；首次需 USB）"
fi

die_summary
