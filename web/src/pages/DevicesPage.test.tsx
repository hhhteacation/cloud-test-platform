/* @vitest-environment jsdom */
import { act, StrictMode } from "react";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DeviceConnectionStatus,
  DeviceProfile,
  NetworkConnectionOperation,
  TestPlatformClient,
} from "../types";

const {
  client,
  listDevices,
  getOperation,
  startOperation,
  listDecisions,
  discoverNetworkDevices,
  getAdoptionStatus,
  recoverNetworkConnection,
} = vi.hoisted(() => {
  const listDevices = vi.fn();
  const getOperation = vi.fn();
  const startOperation = vi.fn();
  const listDecisions = vi.fn();
  const discoverNetworkDevices = vi.fn();
  const getAdoptionStatus = vi.fn();
  const recoverNetworkConnection = vi.fn();
  const client = {
    mode: "real" as const,
    listDevices,
    getNetworkConnectionOperation: getOperation,
    startNetworkConnectionOperation: startOperation,
    listNetworkObservationDecisions: listDecisions,
    discoverNetworkDevices,
    getManagedObservationAdoptionStatus: getAdoptionStatus,
    recoverNetworkConnection,
  };
  return {
    client,
    listDevices,
    getOperation,
    startOperation,
    listDecisions,
    discoverNetworkDevices,
    getAdoptionStatus,
    recoverNetworkConnection,
  };
});

vi.mock("../platform/client", () => ({
  platformClient: client as unknown as TestPlatformClient,
  isRealPlatform: true,
}));

import { DevicesPage } from "./DevicesPage";

function device(status: DeviceConnectionStatus): DeviceProfile {
  return {
    id: "device-1",
    platform: "android",
    name: "Test Phone",
    manufacturer: "Test",
    model: "T-1",
    osVersion: "Android 16",
    apiLevel: 36,
    architecture: "arm64-v8a",
    executionMode: "adb",
    eligible: true,
    endpoints: {
      network: {
        id: "endpoint-1",
        deviceId: "device-1",
        kind: "network",
        adbSerial: "192.0.2.10:5555",
        host: "192.0.2.10",
        port: 5555,
        status,
      },
    },
    connectionStatus: status,
    overallConnectionStatus: status,
    selectable: status === "online",
    queueStatus: "idle",
  };
}

function operation(
  status: NetworkConnectionOperation["status"],
  itemStatus: NetworkConnectionOperation["items"][number]["status"],
): NetworkConnectionOperation {
  return {
    id: "network-connect-test",
    status,
    totalCount: 1,
    succeeded: itemStatus === "succeeded" ? 1 : 0,
    failed: itemStatus === "failed" ? 1 : 0,
    skipped: itemStatus === "skipped" ? 1 : 0,
    cancelled: itemStatus === "cancelled" ? 1 : 0,
    cancelRequested: false,
    createdAt: "2026-08-14T00:00:00.000Z",
    items: [
      {
        id: "item-1",
        operationId: "network-connect-test",
        deviceId: "device-1",
        endpointId: "endpoint-1",
        host: "192.0.2.10",
        port: 5555,
        status: itemStatus,
      },
    ],
  };
}

describe("DevicesPage 一键联网连接", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    listDevices
      .mockReset()
      .mockResolvedValueOnce([device("offline")])
      .mockResolvedValueOnce([device("offline")])
      .mockResolvedValue([device("online")]);
    startOperation
      .mockReset()
      .mockResolvedValue({
        operationId: "network-connect-test",
        status: "queued",
        totalCount: 1,
      });
    getOperation
      .mockReset()
      .mockResolvedValue(operation("completed", "succeeded"));
    listDecisions.mockReset().mockResolvedValue([]);
    discoverNetworkDevices.mockReset().mockResolvedValue([]);
    getAdoptionStatus.mockReset().mockResolvedValue({
      enabled: false,
      gateMode: "disabled",
      allowedDeviceIds: [],
      running: false,
      cyclesStarted: 0,
      cyclesCompleted: 0,
      adoptionFailures: 0,
      discoveryFailures: 0,
    });
    recoverNetworkConnection.mockReset().mockResolvedValue({
      ...device("online").endpoints?.network,
      status: "online",
    });
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
  });

  it("StrictMode 下批量完成后应自动刷新设备快照，不需要再点击单台设备", async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <DevicesPage />
        </StrictMode>,
      ),
    );
    expect(container.textContent).toContain("离线");
    const initialListCalls = listDevices.mock.calls.length;

    const networkTab = Array.from(
      container.querySelectorAll("[role=tab]"),
    ).find((item) => item.textContent?.includes("联网连接"));
    expect(networkTab).toBeDefined();
    await act(async () =>
      networkTab?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent?.includes("一键连接全部"),
    );
    expect(button).toBeDefined();
    await act(async () =>
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await act(async () => Promise.resolve());

    expect(getOperation).toHaveBeenCalledWith("network-connect-test");
    expect(listDevices).toHaveBeenCalledTimes(initialListCalls + 1);
    expect(container.textContent).toContain("在线");
  });

  it("批量状态查询临时失败后应继续轮询并刷新设备快照", async () => {
    getOperation
      .mockReset()
      .mockRejectedValueOnce(new Error("temporary proxy failure"))
      .mockResolvedValue(operation("completed", "succeeded"));

    await act(async () =>
      root.render(
        <StrictMode>
          <DevicesPage />
        </StrictMode>,
      ),
    );
    const initialListCalls = listDevices.mock.calls.length;

    const networkTab = Array.from(
      container.querySelectorAll("[role=tab]"),
    ).find((item) => item.textContent?.includes("联网连接"));
    await act(async () =>
      networkTab?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent?.includes("一键连接全部"),
    );
    await act(async () =>
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await act(async () => Promise.resolve());

    expect(getOperation).toHaveBeenCalledTimes(1);
    expect(listDevices).toHaveBeenCalledTimes(initialListCalls);

    await act(async () => vi.advanceTimersByTimeAsync(1000));

    expect(getOperation).toHaveBeenCalledTimes(2);
    expect(listDevices).toHaveBeenCalledTimes(initialListCalls + 1);
    expect(container.textContent).toContain("在线");
  });

  it("联网页只读展示 Shadow Observation 决策，不提供采用按钮", async () => {
    listDecisions.mockResolvedValueOnce([
      {
        observation: {
          id: "observation-1",
          source: "mdns",
          serviceInstance: "adb-SERIAL-1-candidate",
          transportType: "wireless_tls",
          host: "198.51.100.20",
          port: 37123,
          observedAt: "2026-08-25T00:00:00.000Z",
          expiresAt: "2026-08-25T00:01:00.000Z",
          verificationStatus: "unverified",
        },
        deviceId: "device-1",
        deviceName: "Test Phone",
        managementMode: "shadow",
        status: "shadow_only",
        reasonCode: "SHADOW_MODE_NO_ACTION",
      },
    ]);

    await act(async () => root.render(<DevicesPage />));
    await act(async () => Promise.resolve());
    const networkTab = Array.from(
      container.querySelectorAll("[role=tab]"),
    ).find((item) => item.textContent?.includes("联网连接"));
    await act(async () =>
      networkTab?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    expect(listDecisions).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("198.51.100.20:37123");
    expect(container.textContent).toContain("Test Phone");
    expect(container.textContent).toContain("仅观察");
    expect(container.textContent).toContain("影子模式仅观察，不执行连接");
    expect(container.textContent).not.toContain("采用候选");
  });

  it("人工处理锁定应展示准确阻止语义并通过受控恢复接口刷新三类状态", async () => {
    const locked = device("offline");
    locked.networkConnection = {
      deviceId: locked.id,
      managementMode: "managed",
      desiredNetworkState: "connected",
      observedNetworkState: "manual_action",
      consecutiveFailures: 5,
      retryCount: 5,
      reasonCode: "ADB_PORT_UNREACHABLE",
      actionRequired: "CHECK_NETWORK_ADB_ENDPOINT",
    };
    listDevices.mockReset().mockResolvedValue([locked]);
    listDecisions.mockReset().mockResolvedValue([
      {
        observation: {
          id: "observation-manual-action",
          source: "mdns",
          serviceInstance: "adb-SERIAL-1-adb-tls-connect",
          transportType: "wireless_tls",
          host: "198.51.100.30",
          port: 42747,
          observedAt: "2026-09-01T08:00:00.000Z",
          expiresAt: "2026-09-01T08:01:00.000Z",
          verificationStatus: "unverified",
        },
        deviceId: "device-1",
        deviceName: "Test Phone",
        managementMode: "managed",
        status: "blocked",
        reasonCode: "MANUAL_ACTION_REQUIRED",
        blockedBy: "manual_action",
        endpointId: "endpoint-1",
        lastVerificationAt: "2026-09-01T07:59:00.000Z",
      },
    ]);
    getAdoptionStatus.mockReset().mockResolvedValue({
      enabled: true,
      gateMode: "allowlist",
      allowedDeviceIds: ["device-1"],
      configLoadedAt: "2026-09-01T07:00:00.000Z",
      running: false,
      cyclesStarted: 4,
      cyclesCompleted: 4,
      adoptionFailures: 0,
      discoveryFailures: 0,
      lastResult: {
        total: 1,
        adopted: 0,
        skipped: 1,
        failed: 0,
        outsideAllowlist: 0,
        manualActionBlocked: 1,
        identityRejected: 0,
        endpointAlreadyActive: 0,
        deviceBusy: 0,
      },
    });

    await act(async () => root.render(<DevicesPage />));
    await act(async () => Promise.resolve());
    const networkTab = Array.from(
      container.querySelectorAll("[role=tab]"),
    ).find((item) => item.textContent?.includes("联网连接"));
    await act(async () =>
      networkTab?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    expect(container.textContent).toContain("已阻止");
    expect(container.textContent).toContain("阻止者：人工处理锁定");
    expect(container.textContent).toContain("连续联网验证失败达到安全阈值");
    expect(container.textContent).toContain("建议：发起人工恢复验证");
    expect(container.textContent).toContain("adb-SERIAL-1-adb-tls-connect");
    expect(container.textContent).toContain("白名单受控启用");
    expect(container.textContent).toContain("候选失败 0");
    expect(container.textContent).toContain("人工锁定 1");

    const initialListCalls = listDevices.mock.calls.length;
    const initialDecisionCalls = listDecisions.mock.calls.length;
    const initialGateCalls = getAdoptionStatus.mock.calls.length;
    const recoverButton = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent?.includes("人工恢复验证"),
    );
    expect(recoverButton).toBeDefined();
    await act(async () =>
      recoverButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await act(async () => Promise.resolve());

    expect(recoverNetworkConnection).toHaveBeenCalledWith("device-1");
    expect(listDevices.mock.calls.length).toBeGreaterThan(initialListCalls);
    expect(listDecisions.mock.calls.length).toBeGreaterThan(
      initialDecisionCalls,
    );
    expect(getAdoptionStatus.mock.calls.length).toBeGreaterThan(
      initialGateCalls,
    );
  });

  it("mDNS 扫描完成后应刷新 Shadow Observation 决策", async () => {
    listDecisions.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        observation: {
          id: "observation-after-scan",
          source: "mdns",
          serviceInstance: "adb-SERIAL-1-candidate",
          transportType: "wireless_tls",
          host: "203.0.113.25",
          port: 41837,
          observedAt: "2026-08-25T00:00:00.000Z",
          expiresAt: "2026-08-25T00:01:00.000Z",
          verificationStatus: "unverified",
        },
        deviceId: "device-1",
        deviceName: "Test Phone",
        managementMode: "shadow",
        status: "shadow_only",
        reasonCode: "SHADOW_MODE_NO_ACTION",
      },
    ]);
    discoverNetworkDevices.mockResolvedValueOnce([
      {
        serial: "203.0.113.25:41837",
        connectionType: "network",
        state: "discovered",
      },
    ]);

    await act(async () => root.render(<DevicesPage />));
    await act(async () => Promise.resolve());
    const networkTab = Array.from(
      container.querySelectorAll("[role=tab]"),
    ).find((item) => item.textContent?.includes("联网连接"));
    await act(async () =>
      networkTab?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    const discoverButton = Array.from(
      container.querySelectorAll("button"),
    ).find((item) => item.textContent?.includes("mDNS 发现"));
    await act(async () =>
      discoverButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await act(async () => Promise.resolve());

    expect(discoverNetworkDevices).toHaveBeenCalledTimes(1);
    expect(listDecisions).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("203.0.113.25:41837");
  });

  it("联网页只读展示并刷新 Managed Adoption Gate 状态，不触发连接或发现", async () => {
    getAdoptionStatus
      .mockResolvedValueOnce({
        enabled: false,
        gateMode: "disabled",
        allowedDeviceIds: [],
        running: false,
        cyclesStarted: 0,
        cyclesCompleted: 0,
        adoptionFailures: 0,
        discoveryFailures: 0,
      })
      .mockResolvedValueOnce({
        enabled: false,
        gateMode: "disabled",
        allowedDeviceIds: [],
        running: false,
        cyclesStarted: 3,
        cyclesCompleted: 3,
        adoptionFailures: 1,
        discoveryFailures: 2,
        lastResult: {
          total: 4,
          adopted: 1,
          skipped: 1,
          failed: 2,
          outsideAllowlist: 1,
          manualActionBlocked: 0,
          identityRejected: 1,
          endpointAlreadyActive: 0,
          deviceBusy: 0,
        },
      });

    await act(async () => root.render(<DevicesPage />));
    await act(async () => Promise.resolve());
    const networkTab = Array.from(
      container.querySelectorAll("[role=tab]"),
    ).find((item) => item.textContent?.includes("联网连接"));
    await act(async () =>
      networkTab?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    expect(getAdoptionStatus).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Managed 自动采用 Gate");
    expect(container.textContent).toContain("全局关闭");
    expect(container.textContent).not.toContain("启用自动采用");

    const refreshButton = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent?.includes("刷新 Gate 状态"),
    );
    expect(refreshButton).toBeDefined();
    await act(async () =>
      refreshButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await act(async () => Promise.resolve());

    expect(getAdoptionStatus).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("周期：3/3");
    expect(container.textContent).toContain("发现周期异常：2");
    expect(container.textContent).toContain("采用周期异常：1");
    expect(container.textContent).toContain("候选失败 2");
    expect(container.textContent).toContain("白名单外 1");
    expect(container.textContent).toContain("身份拒绝 1");
    expect(discoverNetworkDevices).not.toHaveBeenCalled();
    expect(startOperation).not.toHaveBeenCalled();
  });
});
