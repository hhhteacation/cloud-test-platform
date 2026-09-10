import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlatformDatabase } from "../database.js";
import type { DeviceDiscoveryCandidate } from "../types.js";
import type { DeviceDiscoveryProvider } from "./device-provider.js";
import {
  DeviceRegistrationError,
  DeviceRegistryService,
} from "./device-registry.js";

class FakeAndroidProvider implements DeviceDiscoveryProvider {
  readonly platform = "android" as const;
  candidates: DeviceDiscoveryCandidate[] = [];
  networkCandidates: DeviceDiscoveryCandidate[] = [];
  connectResult?: DeviceDiscoveryCandidate;
  disconnected: string[] = [];
  connectCalls: Array<{ host: string; port: number; signal?: AbortSignal }> =
    [];
  probeCalls: Array<{ host: string; port: number }> = [];
  connectImpl?: (
    host: string,
    port: number,
    options?: { signal?: AbortSignal },
  ) => Promise<DeviceDiscoveryCandidate>;
  probeImpl?: (
    host: string,
    port: number,
    options?: { signal?: AbortSignal },
  ) => Promise<boolean>;
  disconnectImpl?: (serial: string) => Promise<void>;

  async discover(_options: { signal?: AbortSignal } = {}) {
    return this.candidates;
  }
  async discoverNetwork() {
    return this.networkCandidates;
  }
  async connectNetwork(
    host: string,
    port: number,
    options?: { signal?: AbortSignal },
  ) {
    this.connectCalls.push({ host, port, signal: options?.signal });
    if (this.connectImpl) return this.connectImpl(host, port, options);
    return (
      this.connectResult ?? {
        serial: `${host}:${port}`,
        host,
        port,
        platform: "android" as const,
        connectionStatus: "offline" as const,
      }
    );
  }
  async probeNetwork(
    host: string,
    port: number,
    options?: { signal?: AbortSignal },
  ) {
    this.probeCalls.push({ host, port });
    return this.probeImpl ? this.probeImpl(host, port, options) : true;
  }
  async disconnect(serial: string) {
    this.disconnected.push(serial);
    await this.disconnectImpl?.(serial);
  }
}

describe("DeviceRegistryService", () => {
  let rootDir: string;
  let database: PlatformDatabase;
  let provider: FakeAndroidProvider;
  let registry: DeviceRegistryService;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "sdk-device-registry-"));
    database = new PlatformDatabase({
      databasePath: path.join(rootDir, "cloud-test.sqlite"),
      seedDevice: false,
      markInterruptedTasks: false,
    });
    provider = new FakeAndroidProvider();
    registry = new DeviceRegistryService(database, [provider]);
  });

  afterEach(async () => {
    database.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  const onlineDevice = (
    serial: string,
    hardwareSerial = serial,
  ): DeviceDiscoveryCandidate => ({
    serial,
    hardwareSerial,
    platform: "android",
    manufacturer: "Example",
    name: "Example Phone",
    model: "EX-1",
    androidVersion: "15",
    apiLevel: 35,
    architecture: "arm64-v8a",
    buildVersion: "EXAMPLE.1",
    securityPatch: "2026-06-01",
    connectionStatus: "online",
  });

  async function register(serial = "SERIAL-1") {
    provider.candidates = [onlineDevice(serial)];
    return registry.register(serial);
  }

  function forceManualAction(deviceId: string, operationId: string) {
    const operation = database.beginDeviceConnectionOperation({
      deviceId,
      operationId,
      deadlineAt: "2099-01-01T00:00:00.000Z",
    });
    database.recordDeviceConnectionHealthFailure({
      deviceId,
      operationId: operation.operationId!,
      generation: operation.connectionGeneration,
      reasonCode: "RECOVERY_BUDGET_EXHAUSTED",
      terminal: true,
      manualAction: true,
    });
  }

  it("重复录入同一 Serial 保持幂等，更新属性并只维护一个 USB Endpoint", async () => {
    const first = await register();
    provider.candidates = [
      { ...onlineDevice("SERIAL-1"), name: "Renamed Phone", model: "EX-2" },
    ];
    const second = await registry.register("SERIAL-1");

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Renamed Phone");
    expect(second.model).toBe("EX-2");
    expect(database.listDevices()).toHaveLength(1);
    expect(database.listDeviceEndpoints(first.id)).toEqual([
      expect.objectContaining({
        deviceId: first.id,
        kind: "usb",
        adbSerial: "SERIAL-1",
        status: "online",
      }),
    ]);
  });

  it("已存在的 Magic V3 Serial 保留历史设备 ID", async () => {
    database.upsertAdbDevice({
      id: "honor-magic-v3",
      serial: "HONOR-SERIAL",
      name: "荣耀 Magic V3",
      manufacturer: "HONOR",
      model: "FCP-AN10",
      osVersion: "Android 16",
      apiLevel: 36,
      architecture: "arm64-v8a",
    });
    provider.candidates = [
      { ...onlineDevice("HONOR-SERIAL"), name: "HONOR Magic V3" },
    ];

    await expect(registry.register("HONOR-SERIAL")).resolves.toMatchObject({
      id: "honor-magic-v3",
    });
  });

  it.each([
    ["unauthorized", "DEVICE_UNAUTHORIZED"],
    ["offline", "DEVICE_OFFLINE"],
  ] as const)("拒绝录入 %s 设备", async (connectionStatus, code) => {
    provider.candidates = [{ ...onlineDevice("SERIAL-X"), connectionStatus }];
    await expect(
      registry.register("SERIAL-X"),
    ).rejects.toMatchObject<DeviceRegistrationError>({ code, statusCode: 409 });
    expect(database.listDevices()).toHaveLength(0);
  });

  it("USB 发现会标记已录入设备，并排除 adb devices 中的联网 serial", async () => {
    const registered = await register();
    database.upsertDeviceEndpoint({
      deviceId: registered.id,
      kind: "network",
      adbSerial: "192.168.1.20:5555",
      host: "192.168.1.20",
      port: 5555,
      status: "online",
    });
    provider.candidates.push({
      ...onlineDevice("192.168.1.20:5555", "SERIAL-1"),
      host: "192.168.1.20",
      port: 5555,
    });

    await expect(registry.discover()).resolves.toEqual([
      expect.objectContaining({
        serial: "SERIAL-1",
        registeredDeviceId: registered.id,
        kind: "usb",
      }),
    ]);
  });

  it("设备快照只读取已登记状态，不调用 Provider 或修改数据库", async () => {
    const device = await register();
    const beforeDevice = database.getDevice(device.id);
    const beforeEndpoints = database.listDeviceEndpoints(device.id);
    const discover = vi.spyOn(provider, "discover");
    discover.mockClear();

    const [snapshot] = await registry.listRegisteredSnapshot("android");

    expect(discover).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      id: device.id,
      overallConnectionStatus: "online",
      endpoints: {
        usb: expect.objectContaining({
          adbSerial: "SERIAL-1",
          status: "online",
        }),
      },
    });
    expect(database.getDevice(device.id)).toEqual(beforeDevice);
    expect(database.listDeviceEndpoints(device.id)).toEqual(beforeEndpoints);
  });

  it("真实刷新调用 Provider、更新 Endpoint 状态并返回最新快照", async () => {
    const device = await register();
    provider.candidates = [];
    const discover = vi.spyOn(provider, "discover");
    discover.mockClear();

    const [refreshed] = await registry.refreshRegistered("android");

    expect(discover).toHaveBeenCalledTimes(1);
    expect(refreshed).toMatchObject({
      id: device.id,
      overallConnectionStatus: "offline",
      selectable: false,
      endpoints: { usb: expect.objectContaining({ status: "offline" }) },
    });
    expect(database.getDeviceEndpointByKind(device.id, "usb")).toMatchObject({
      status: "offline",
    });
  });

  it("并发全量刷新共享一次扫描，失败后允许重新尝试", async () => {
    await register();
    let release: ((candidates: DeviceDiscoveryCandidate[]) => void) | undefined;
    const pending = new Promise<DeviceDiscoveryCandidate[]>((resolve) => {
      release = resolve;
    });
    const discover = vi
      .spyOn(provider, "discover")
      .mockImplementationOnce(() => pending);

    const first = registry.refreshRegistered("android");
    const second = registry.refreshRegistered("android");
    expect(discover).toHaveBeenCalledTimes(1);
    release?.([onlineDevice("SERIAL-1")]);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(discover).toHaveBeenCalledTimes(1);

    discover.mockRejectedValueOnce(new Error("adb daemon unavailable"));
    await expect(registry.refreshRegistered("android")).rejects.toThrow(
      "adb daemon unavailable",
    );
    discover.mockResolvedValueOnce([onlineDevice("SERIAL-1")]);
    await expect(registry.refreshRegistered("android")).resolves.toHaveLength(
      1,
    );
    expect(discover).toHaveBeenCalledTimes(3);
  });

  it("取消单个等待者不会误杀其他任务共享的 ADB 扫描", async () => {
    await register();
    let release: ((candidates: DeviceDiscoveryCandidate[]) => void) | undefined;
    let scanSignal: AbortSignal | undefined;
    const pending = new Promise<DeviceDiscoveryCandidate[]>((resolve) => {
      release = resolve;
    });
    vi.spyOn(provider, "discover").mockImplementationOnce(
      async (options = {}) => {
        scanSignal = options.signal;
        return pending;
      },
    );
    const cancelledCaller = new AbortController();

    const first = registry.refreshRegistered("android", {
      signal: cancelledCaller.signal,
    });
    const second = registry.refreshRegistered("android");
    cancelledCaller.abort(new Error("caller deadline exceeded"));

    await expect(first).rejects.toThrow("caller deadline exceeded");
    expect(scanSignal?.aborted).toBe(false);
    release?.([onlineDevice("SERIAL-1")]);
    await expect(second).resolves.toHaveLength(1);
  });

  it("最后一个 Endpoint 解析等待者取消时终止底层 ADB 扫描且不写入迟到状态", async () => {
    const device = await register();
    let scanSignal: AbortSignal | undefined;
    vi.spyOn(provider, "discover").mockImplementationOnce(
      async (options = {}) => {
        scanSignal = options.signal;
        return new Promise<DeviceDiscoveryCandidate[]>((resolve, reject) => {
          const timer = setTimeout(() => resolve([]), 100);
          options.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(options.signal?.reason);
            },
            { once: true },
          );
        });
      },
    );
    const controller = new AbortController();

    const resolution = registry.resolveExecutionEndpoint(device.id, "auto", {
      signal: controller.signal,
    });
    controller.abort(new Error("recovery deadline exceeded"));

    await expect(resolution).rejects.toThrow("recovery deadline exceeded");
    expect(scanSignal?.aborted).toBe(true);
    expect(database.getDeviceEndpointByKind(device.id, "usb")).toMatchObject({
      status: "online",
    });
  });

  it("并发任务解析共享全量扫描，但分别选择各自设备的 Endpoint", async () => {
    const firstDevice = await register("SERIAL-1");
    provider.candidates = [onlineDevice("SERIAL-2")];
    const secondDevice = await registry.register("SERIAL-2");
    provider.candidates = [onlineDevice("SERIAL-1"), onlineDevice("SERIAL-2")];
    const discover = vi.spyOn(provider, "discover");
    discover.mockClear();

    const [firstEndpoint, secondEndpoint] = await Promise.all([
      registry.resolveExecutionEndpoint(firstDevice.id, "auto"),
      registry.resolveExecutionEndpoint(secondDevice.id, "auto"),
    ]);

    expect(discover).toHaveBeenCalledTimes(1);
    expect(firstEndpoint).toMatchObject({
      deviceId: firstDevice.id,
      adbSerial: "SERIAL-1",
    });
    expect(secondEndpoint).toMatchObject({
      deviceId: secondDevice.id,
      adbSerial: "SERIAL-2",
    });
  });

  it("任务解析 Endpoint 前执行真实刷新，扫描失败时不使用数据库中的过期在线状态", async () => {
    const device = await register();
    const discover = vi
      .spyOn(provider, "discover")
      .mockRejectedValueOnce(new Error("adb scan failed"));

    await expect(
      registry.resolveExecutionEndpoint(device.id, "auto"),
    ).rejects.toThrow("adb scan failed");
    expect(discover).toHaveBeenCalledTimes(1);
    expect(database.getDeviceEndpointByKind(device.id, "usb")).toMatchObject({
      status: "online",
    });
  });

  it("同一物理设备聚合 USB 与联网 Endpoint，且 auto 优先 USB", async () => {
    const device = await register();
    const tls = database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      adbSerial: "192.168.1.20:5555",
      host: "192.168.1.20",
      port: 5555,
      status: "online",
    });
    provider.candidates = [
      onlineDevice("SERIAL-1"),
      {
        ...onlineDevice("192.168.1.20:5555", "SERIAL-1"),
        host: "192.168.1.20",
        port: 5555,
      },
    ];

    const overview = await registry.refreshRegistered();
    expect(overview).toHaveLength(1);
    expect(overview[0]).toMatchObject({
      id: device.id,
      selectable: true,
      overallConnectionStatus: "online",
      queueStatus: "idle",
      endpoints: {
        usb: { kind: "usb", adbSerial: "SERIAL-1", status: "online" },
        network: {
          kind: "network",
          adbSerial: "192.168.1.20:5555",
          status: "online",
        },
      },
    });
    await expect(
      registry.resolveExecutionEndpoint(device.id, "auto"),
    ).resolves.toMatchObject({ kind: "usb" });
    await expect(
      registry.resolveExecutionEndpoint(device.id, "network"),
    ).resolves.toMatchObject({ kind: "network" });
  });

  it("auto 在 USB 不可用时回退联网，显式 usb 模式不会回退", async () => {
    const device = await register();
    database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      adbSerial: "192.168.1.20:5555",
      host: "192.168.1.20",
      port: 5555,
      status: "online",
    });
    provider.candidates = [
      {
        ...onlineDevice("192.168.1.20:5555", "SERIAL-1"),
        host: "192.168.1.20",
        port: 5555,
      },
    ];

    await expect(
      registry.resolveExecutionEndpoint(device.id, "auto"),
    ).resolves.toMatchObject({ kind: "network" });
    await expect(
      registry.resolveExecutionEndpoint(device.id, "usb"),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "DEVICE_NOT_ONLINE",
    });
  });

  it("批量联网操作期间仍可解析 USB，且不覆盖 Network Endpoint 状态", async () => {
    const device = await register();
    const networkEndpoint = database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      adbSerial: "192.168.100.89:5555",
      host: "192.168.100.89",
      port: 5555,
      status: "online",
    });
    database.networkConnectionOperations.create({
      items: [
        {
          deviceId: device.id,
          endpointId: networkEndpoint.id,
          host: "192.168.100.89",
          port: 5555,
        },
      ],
    });
    provider.candidates = [onlineDevice("SERIAL-1")];

    await expect(
      registry.resolveExecutionEndpoint(device.id, "usb"),
    ).resolves.toMatchObject({
      kind: "usb",
      adbSerial: "SERIAL-1",
    });
    await expect(
      registry.resolveExecutionEndpoint(device.id, "auto"),
    ).resolves.toMatchObject({
      kind: "usb",
      adbSerial: "SERIAL-1",
    });
    expect(database.getDeviceEndpoint(networkEndpoint.id)).toMatchObject({
      status: "online",
    });
    await expect(
      registry.resolveExecutionEndpoint(device.id, "network"),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "NETWORK_CONNECT_OPERATION_CONFLICT",
    });
  });

  it("联网连接成功后校验身份并绑定到已有物理设备", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.168.1.20:5555", "SERIAL-1"),
      host: "192.168.1.20",
      port: 5555,
    };

    await expect(
      registry.connectNetwork(device.id, "192.168.1.20", 5555),
    ).resolves.toMatchObject({
      deviceId: device.id,
      kind: "network",
      host: "192.168.1.20",
      port: 5555,
      status: "online",
    });
    expect(database.listDevices()).toHaveLength(1);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "online",
      connectionGeneration: 1,
      activeEndpointId: expect.any(String),
      operationId: expect.any(String),
    });
    const events = database.listConnectionEvents(device.id);
    expect(
      events.map((event) => ({
        operationId: event.operationId,
        generation: event.generation,
        eventType: event.eventType,
        result: event.result,
      })),
    ).toEqual([
      {
        operationId: expect.any(String),
        generation: 1,
        eventType: "operation_started",
        result: "started",
      },
      {
        operationId: expect.any(String),
        generation: 1,
        eventType: "endpoint_activated",
        result: "succeeded",
      },
    ]);
    expect(events[1]?.endpointSummary).toEqual({
      host: "192.168.1.20",
      port: 5555,
      transportType: "tcp_legacy",
    });
  });

  it("重复提交同一设备和地址时合并为一个底层连接操作", async () => {
    const device = await register();
    let release: ((candidate: DeviceDiscoveryCandidate) => void) | undefined;
    provider.connectImpl = async () =>
      new Promise<DeviceDiscoveryCandidate>((resolve) => {
        release = resolve;
      });

    const first = registry.connectNetwork(device.id, "192.168.1.20", 5555);
    const second = registry.connectNetwork(device.id, "192.168.1.20", 5555);
    await vi.waitFor(() => expect(provider.connectCalls).toHaveLength(1));
    release?.({
      ...onlineDevice("192.168.1.20:5555", "SERIAL-1"),
      host: "192.168.1.20",
      port: 5555,
    });

    const [firstEndpoint, secondEndpoint] = await Promise.all([first, second]);
    expect(firstEndpoint.id).toBe(secondEndpoint.id);
    expect(provider.connectCalls).toHaveLength(1);
  });

  it("连接超过 deadline 时结束操作并拒绝迟到成功写入 Endpoint", async () => {
    const device = await register();
    const deadlineRegistry = new DeviceRegistryService(database, [provider], {
      connectionOperationDeadlineMs: 5,
    });
    provider.connectImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ...onlineDevice("192.168.1.21:5555", "SERIAL-1"),
        host: "192.168.1.21",
        port: 5555,
      };
    };

    await expect(
      deadlineRegistry.connectNetwork(device.id, "192.168.1.21", 5555),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "NETWORK_RECOVERY_DEADLINE_EXCEEDED",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(
      database.getDeviceEndpointByKind(device.id, "network"),
    ).toBeUndefined();
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "offline",
      reasonCode: "NETWORK_RECOVERY_DEADLINE_EXCEEDED",
    });
  });

  it("未验证的新地址连接失败时不创建正式 Endpoint", async () => {
    const device = await register();
    await expect(
      registry.connectNetwork(device.id, "192.168.1.30", 5555),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "NETWORK_DEVICE_OFFLINE",
    });
    expect(
      database.getDeviceEndpointByKind(device.id, "network"),
    ).toBeUndefined();
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "offline",
      connectionGeneration: 1,
      reasonCode: "NETWORK_DEVICE_OFFLINE",
    });
  });

  it("新候选地址连接失败时保留原有已验证 Endpoint", async () => {
    const device = await register();
    const verified = database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      adbSerial: "192.168.1.20:5555",
      host: "192.168.1.20",
      port: 5555,
      status: "online",
    });

    await expect(
      registry.connectNetwork(device.id, "192.168.1.30", 5555),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "NETWORK_DEVICE_OFFLINE",
    });
    expect(
      database.getDeviceEndpointByKind(device.id, "network"),
    ).toMatchObject({
      id: verified.id,
      adbSerial: "192.168.1.20:5555",
      status: "online",
    });
  });

  it("已验证 Endpoint 重连失败时更新其离线状态和错误", async () => {
    const device = await register();
    const endpoint = database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      adbSerial: "192.168.1.20:5555",
      host: "192.168.1.20",
      port: 5555,
      status: "online",
    });

    await expect(
      registry.refreshNetwork(device.id, endpoint.id),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "NETWORK_DEVICE_OFFLINE",
    });
    expect(database.getDeviceEndpoint(endpoint.id)).toMatchObject({
      status: "offline",
      lastError: "adb connect 未能建立可用连接",
    });
  });

  it("身份不匹配或地址已绑定其他设备时不自动合并", async () => {
    const first = await register("SERIAL-1");
    provider.candidates = [onlineDevice("SERIAL-2")];
    const second = await registry.register("SERIAL-2");

    provider.connectResult = {
      ...onlineDevice("192.168.1.40:5555", "SERIAL-1"),
      host: "192.168.1.40",
      port: 5555,
      model: "OTHER",
    };
    await expect(
      registry.connectNetwork(first.id, "192.168.1.40", 5555),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "DEVICE_IDENTITY_MISMATCH",
    });
    expect(
      database.getDeviceEndpointByKind(first.id, "network"),
    ).toBeUndefined();

    provider.connectResult = {
      ...onlineDevice("192.168.1.40:5555", "SERIAL-1"),
      host: "192.168.1.40",
      port: 5555,
    };
    await registry.connectNetwork(first.id, "192.168.1.40", 5555);
    await expect(
      registry.connectNetwork(second.id, "192.168.1.40", 5555),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "NETWORK_ENDPOINT_ALREADY_BOUND",
    });
  });

  it("联网设备型号相同但硬件 Serial 属于另一台物理设备时拒绝绑定且不覆盖档案", async () => {
    const magicV3 = await register("MAGIC-V3-SERIAL");
    provider.candidates = [
      {
        ...onlineDevice("X50-SERIAL"),
        name: "荣耀X50",
        manufacturer: "HONOR",
        model: "ALI-AN00",
      },
    ];
    const x50 = await registry.register("X50-SERIAL");
    const before = database.getDevice(magicV3.id);

    provider.connectResult = {
      ...onlineDevice("192.168.1.128:5555", "X50-SERIAL"),
      host: "192.168.1.128",
      port: 5555,
      name: before?.name,
      manufacturer: before?.manufacturer,
      model: before?.model,
    };

    await expect(
      registry.connectNetwork(magicV3.id, "192.168.1.128", 5555),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "DEVICE_IDENTITY_MISMATCH",
    });
    expect(database.getDevice(magicV3.id)).toEqual(before);
    expect(
      database.getDeviceEndpointByKind(magicV3.id, "network"),
    ).toBeUndefined();
    expect(database.getDeviceConnectionState(magicV3.id)).toMatchObject({
      observedNetworkState: "manual_action",
      reasonCode: "DEVICE_IDENTITY_MISMATCH",
    });
    expect(database.getDevice(x50.id)?.serial).toBe("X50-SERIAL");
  });

  it("无法读取联网设备硬件 Serial 时不使用型号猜测绑定", async () => {
    const device = await register("SERIAL-1");
    provider.connectResult = {
      ...onlineDevice("192.168.1.129:5555"),
      hardwareSerial: undefined,
      host: "192.168.1.129",
      port: 5555,
    };

    await expect(
      registry.connectNetwork(device.id, "192.168.1.129", 5555),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "DEVICE_IDENTITY_UNVERIFIED",
    });
    expect(
      database.getDeviceEndpointByKind(device.id, "network"),
    ).toBeUndefined();
  });

  it("总览刷新不会用硬件 Serial 不匹配的联网 Endpoint 覆盖物理设备档案", async () => {
    const magicV3 = await register("MAGIC-V3-SERIAL");
    database.upsertDeviceEndpoint({
      deviceId: magicV3.id,
      kind: "network",
      adbSerial: "192.168.1.128:5555",
      host: "192.168.1.128",
      port: 5555,
      status: "online",
    });
    const before = database.getDevice(magicV3.id);
    provider.candidates = [
      {
        ...onlineDevice("192.168.1.128:5555", "X50-SERIAL"),
        name: "荣耀X50",
        manufacturer: "HONOR",
        model: "ALI-AN00",
        host: "192.168.1.128",
        port: 5555,
      },
    ];

    const [overview] = await registry.refreshRegistered();

    expect(overview).toMatchObject({
      id: magicV3.id,
      name: before?.name,
      model: before?.model,
      endpoints: {
        network: {
          status: "unknown",
          lastError: expect.stringContaining("硬件身份"),
        },
      },
    });
    expect(database.getDevice(magicV3.id)).toEqual(before);
  });

  async function registerNetworkDevices(count: number) {
    const devices = [];
    for (let index = 0; index < count; index += 1) {
      const device = await register(`SERIAL-${index + 1}`);
      database.upsertDeviceEndpoint({
        deviceId: device.id,
        kind: "network",
        adbSerial: `192.0.2.${index + 1}:5555`,
        host: `192.0.2.${index + 1}`,
        port: 5555,
        status: "offline",
      });
      devices.push(device);
    }
    return devices;
  }

  async function waitForNetworkOperation(operationId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const operation = registry.getNetworkConnectionOperation(operationId);
      if (operation.status !== "queued" && operation.status !== "running")
        return operation;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(`批量联网操作未在测试时间内完成：${operationId}`);
  }

  it("批量连接最多并发 3 台，单台失败不阻塞其他设备，并保留 ADB Evidence", async () => {
    const devices = await registerNetworkDevices(6);
    let active = 0;
    let maxActive = 0;
    provider.connectImpl = async (host, port) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) =>
        setTimeout(resolve, host.endsWith(".2") ? 5 : 1),
      );
      active -= 1;
      if (host.endsWith(".2")) {
        return {
          serial: `${host}:${port}`,
          host,
          port,
          platform: "android",
          connectionStatus: "offline",
          failureCode: "ADB_PORT_REFUSED",
          failureMessage: "connection refused",
          adbExitCode: 1,
          adbStdout: "adb stdout diagnostic",
          adbStderr: "connection refused",
          adbStdoutTruncated: false,
          adbStderrTruncated: true,
        };
      }
      return {
        ...onlineDevice(
          `${host}:${port}`,
          `SERIAL-${Number(host.split(".").at(-1))}`,
        ),
        host,
        port,
      };
    };

    const started = registry.startNetworkConnectionOperation();
    const result = await waitForNetworkOperation(started.operationId);

    expect(maxActive).toBe(3);
    expect(provider.connectCalls).toHaveLength(6);
    expect(result).toMatchObject({
      status: "completed",
      totalCount: 6,
      succeeded: 5,
      failed: 1,
      skipped: 0,
      cancelled: 0,
    });
    expect(
      result.items.find((item) => item.deviceId === devices[1].id),
    ).toMatchObject({
      status: "failed",
      failureCode: "ADB_PORT_REFUSED",
      failureMessage: expect.stringContaining("connection refused"),
      adbExitCode: 1,
      adbStdout: "adb stdout diagnostic",
      adbStderr: "connection refused",
      adbStderrTruncated: true,
    });
  });

  it("取消正在确认的已在线 Endpoint 不会把原在线状态伪装成 offline", async () => {
    const [device] = await registerNetworkDevices(1);
    const endpointBefore = database.getDeviceEndpointByKind(
      device.id,
      "network",
    )!;
    await database.updateDeviceEndpointStatus(endpointBefore.id, "online");

    let release: (() => void) | undefined;
    provider.connectImpl = async (host, port) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        serial: `${host}:${port}`,
        host,
        port,
        platform: "android",
        connectionStatus: "offline",
        failureCode: "NETWORK_CONNECTION_CANCELLED",
        failureMessage: "命令执行已取消",
        adbExitCode: -1,
        adbStdout: "partial stdout",
        adbStderr: "partial stderr",
      };
    };

    const started = registry.startNetworkConnectionOperation();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = registry.getNetworkConnectionOperation(
        started.operationId,
      );
      if (current.items.some((item) => item.status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    registry.cancelNetworkConnectionOperation(started.operationId);
    release?.();
    const result = await waitForNetworkOperation(started.operationId);

    expect(result).toMatchObject({ status: "cancelled", cancelled: 1 });
    expect(result.items[0]).toMatchObject({
      status: "cancelled",
      failureCode: "NETWORK_CONNECTION_CANCELLED",
      adbExitCode: -1,
      adbStdout: "partial stdout",
      adbStderr: "partial stderr",
    });
    expect(
      database.getDeviceEndpointByKind(device.id, "network"),
    ).toMatchObject({
      id: endpointBefore.id,
      status: "online",
      lastError: undefined,
    });
  });

  it("批量连接会跳过 queued/running 设备且不修改其 Endpoint 状态", async () => {
    const [busy, idle] = await registerNetworkDevices(2);
    const apk = database.insertArtifact({
      kind: "apk",
      originalName: "test.apk",
      mimeType: "application/vnd.android.package-archive",
      storagePath: "/tmp/test.apk",
      sizeBytes: 1,
      sha256: "apk",
    });
    const video = database.insertArtifact({
      kind: "video",
      originalName: "test.mp4",
      mimeType: "video/mp4",
      storagePath: "/tmp/test.mp4",
      sizeBytes: 1,
      sha256: "video",
    });
    const task = database.createTask({
      name: "busy",
      apkArtifactId: apk.id,
      videoArtifactId: video.id,
      deviceIds: [busy.id],
      timeoutSeconds: 30,
    });
    const before = database.getDeviceEndpointByKind(busy.id, "network");
    provider.connectImpl = async (host, port) => ({
      ...onlineDevice(`${host}:${port}`, "SERIAL-2"),
      host,
      port,
    });

    const started = registry.startNetworkConnectionOperation();
    const result = await waitForNetworkOperation(started.operationId);

    expect(database.getDeviceQueueStatus(busy.id)).toBe("queued");
    expect(database.getDeviceEndpointByKind(busy.id, "network")).toEqual(
      before,
    );
    expect(
      result.items.find((item) => item.deviceId === busy.id),
    ).toMatchObject({
      status: "skipped",
      skipReason: "DEVICE_BUSY",
      failureCode: "DEVICE_BUSY",
    });
    expect(
      result.items.find((item) => item.deviceId === idle.id),
    ).toMatchObject({ status: "succeeded" });
    expect(provider.connectCalls.map((call) => call.host)).toEqual([
      "192.0.2.2",
    ]);
    expect(task.status).toBe("queued");
  });

  it("取消批量连接后不再启动 pending 项，当前项标记 cancelled 且已完成项不回滚", async () => {
    await registerNetworkDevices(5);
    let releaseCurrent: (() => void) | undefined;
    let currentStarted: Promise<void> | undefined;
    provider.connectImpl = async (host, port, options) => {
      if (host.endsWith(".1")) {
        currentStarted = new Promise<void>((resolve) => {
          releaseCurrent = resolve;
        });
        await currentStarted;
        if (options?.signal?.aborted) throw new Error("cancelled");
      }
      return {
        ...onlineDevice(
          `${host}:${port}`,
          `SERIAL-${Number(host.split(".").at(-1))}`,
        ),
        host,
        port,
      };
    };

    const started = registry.startNetworkConnectionOperation();
    for (let attempt = 0; attempt < 20 && !currentStarted; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(currentStarted).toBeDefined();
    const beforeCancel = registry.getNetworkConnectionOperation(
      started.operationId,
    );
    expect(
      beforeCancel.items.filter((item) => item.status === "running"),
    ).toHaveLength(3);

    registry.cancelNetworkConnectionOperation(started.operationId);
    releaseCurrent?.();
    const result = await waitForNetworkOperation(started.operationId);

    expect(result.status).toBe("cancelled");
    expect(
      result.items.filter((item) => item.status === "succeeded"),
    ).toHaveLength(2);
    expect(
      result.items.filter((item) => item.status === "cancelled"),
    ).toHaveLength(3);
    expect(provider.connectCalls).toHaveLength(3);
    expect(
      result.items
        .filter((item) => item.status === "cancelled")
        .every((item) => item.failureCode === "NETWORK_CONNECTION_CANCELLED"),
    ).toBe(true);
  });

  it("批量操作拒绝重复启动，服务重启状态由 Store 保持为可解释的 cancelled", async () => {
    await registerNetworkDevices(1);
    provider.connectImpl = async () =>
      await new Promise<DeviceDiscoveryCandidate>(() => undefined);
    const started = registry.startNetworkConnectionOperation();
    expect(() => registry.startNetworkConnectionOperation()).toThrowError(
      expect.objectContaining({
        code: "NETWORK_CONNECT_OPERATION_ALREADY_RUNNING",
        statusCode: 409,
      }),
    );
    expect(
      registry.getNetworkConnectionOperation(started.operationId),
    ).toMatchObject({ status: "running" });
    database.networkConnectionOperations.markInterrupted();
    expect(
      registry.getNetworkConnectionOperation(started.operationId),
    ).toMatchObject({
      status: "cancelled",
      cancelReason: "SERVICE_RESTARTED",
      items: [{ status: "cancelled", cancelReason: "SERVICE_RESTARTED" }],
    });
  });

  it("断开和移除联网 Endpoint 不影响 USB Endpoint 或物理设备", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.168.1.50:5555", "SERIAL-1"),
      host: "192.168.1.50",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.168.1.50",
      5555,
    );

    await expect(
      registry.disconnectNetwork(device.id, endpoint.id),
    ).resolves.toMatchObject({ status: "offline" });
    expect(provider.disconnected).toEqual(["192.168.1.50:5555"]);
    await expect(
      registry.removeNetworkEndpoint(device.id, endpoint.id),
    ).resolves.toBe(true);
    expect(provider.disconnected).toEqual([
      "192.168.1.50:5555",
      "192.168.1.50:5555",
    ]);
    expect(database.getDevice(device.id)).toBeDefined();
    expect(database.getDeviceEndpointByKind(device.id, "usb")).toBeDefined();
  });

  it("设备排队或执行时拒绝换联网地址、断开或删除，且不调用底层 ADB", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.168.1.50:5555", "SERIAL-1"),
      host: "192.168.1.50",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.168.1.50",
      5555,
    );
    const apk = database.insertArtifact({
      kind: "apk",
      originalName: "test.apk",
      mimeType: "application/vnd.android.package-archive",
      storagePath: "/tmp/test.apk",
      sizeBytes: 1,
      sha256: "apk-busy-network-change",
    });
    const video = database.insertArtifact({
      kind: "video",
      originalName: "test.mp4",
      mimeType: "video/mp4",
      storagePath: "/tmp/test.mp4",
      sizeBytes: 1,
      sha256: "video-busy-network-change",
    });
    database.createTask({
      name: "busy-network-change",
      apkArtifactId: apk.id,
      videoArtifactId: video.id,
      deviceIds: [device.id],
      timeoutSeconds: 30,
    });
    provider.connectCalls = [];
    provider.disconnected = [];

    await expect(
      registry.connectNetwork(device.id, "192.168.1.51", 5555),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "DEVICE_BUSY",
      statusCode: 409,
    });
    await expect(
      registry.disconnectNetwork(device.id, endpoint.id),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "DEVICE_BUSY",
      statusCode: 409,
    });
    await expect(
      registry.removeNetworkEndpoint(device.id, endpoint.id),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "DEVICE_BUSY",
      statusCode: 409,
    });

    expect(provider.connectCalls).toEqual([]);
    expect(provider.disconnected).toEqual([]);
    expect(
      database.getDeviceEndpointByKind(device.id, "network"),
    ).toMatchObject({
      id: endpoint.id,
      adbSerial: "192.168.1.50:5555",
      status: "online",
    });
    await expect(registry.listRegisteredSnapshot("android")).resolves.toEqual([
      expect.objectContaining({
        id: device.id,
        networkConnection: expect.objectContaining({
          observedNetworkState: "online",
        }),
      }),
    ]);
  });

  it("同一设备的重复断开请求合并为一次 ADB 操作，并以 fenced 状态和事件结束", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.168.1.50:5555", "SERIAL-1"),
      host: "192.168.1.50",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.168.1.50",
      5555,
    );
    let releaseDisconnect: (() => void) | undefined;
    provider.disconnectImpl = async () =>
      await new Promise<void>((resolve) => {
        releaseDisconnect = resolve;
      });

    const first = registry.disconnectNetwork(device.id, endpoint.id);
    const second = registry.disconnectNetwork(device.id, endpoint.id);
    await vi.waitFor(() =>
      expect(provider.disconnected).toEqual(["192.168.1.50:5555"]),
    );
    releaseDisconnect?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "offline" }),
      expect.objectContaining({ status: "offline" }),
    ]);
    expect(provider.disconnected).toEqual(["192.168.1.50:5555"]);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      desiredNetworkState: "disconnected",
      observedNetworkState: "offline",
      activeEndpointId: undefined,
    });
    expect(database.listConnectionEvents(device.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "endpoint_disconnected",
          result: "succeeded",
        }),
      ]),
    );
  });

  it("删除联网 Endpoint 与同设备连接操作串行，删除后迟到连接结果不能重建 Endpoint", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.168.1.50:5555", "SERIAL-1"),
      host: "192.168.1.50",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.168.1.50",
      5555,
    );
    let releaseRefresh: (() => void) | undefined;
    provider.connectImpl = async (host, port) => {
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      return { ...onlineDevice(`${host}:${port}`, "SERIAL-1"), host, port };
    };

    const refresh = registry.refreshNetwork(device.id, endpoint.id);
    await vi.waitFor(() => expect(provider.connectCalls).toHaveLength(2));
    const removal = registry.removeNetworkEndpoint(device.id, endpoint.id);
    expect(provider.disconnected).toEqual([]);
    releaseRefresh?.();

    await expect(refresh).resolves.toMatchObject({
      id: endpoint.id,
      status: "online",
    });
    await expect(removal).resolves.toBe(true);
    expect(provider.disconnected).toEqual(["192.168.1.50:5555"]);
    expect(
      database.getDeviceEndpointByKind(device.id, "network"),
    ).toBeUndefined();
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      desiredNetworkState: "disconnected",
      observedNetworkState: "offline",
      activeEndpointId: undefined,
    });
    expect(database.listConnectionEvents(device.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "endpoint_removed",
          result: "succeeded",
        }),
      ]),
    );
  });

  it("5555 单次失败进入 degraded，连续三次失败才 offline，并按退避阻止连接风暴", async () => {
    let nowMs = 1_800_000_000_000;
    registry = new DeviceRegistryService(database, [provider], {
      now: () => nowMs,
      random: () => 0.5,
    });
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.50:5555", "SERIAL-1"),
      host: "192.0.2.50",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.0.2.50",
      5555,
    );
    provider.probeImpl = async () => false;

    await expect(
      registry.reconcileNetworkEndpoint(device.id, endpoint.id),
    ).resolves.toMatchObject({
      status: "degraded",
      failureCode: "ADB_PORT_UNREACHABLE",
      retryAfterMs: 1_000,
    });
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "degraded",
      consecutiveFailures: 1,
      retryCount: 1,
      nextRetryAt: new Date(nowMs + 1_000).toISOString(),
    });
    expect(database.getDeviceEndpoint(endpoint.id)).toMatchObject({
      status: "online",
      consecutiveFailures: 1,
      lastFailureCode: "ADB_PORT_UNREACHABLE",
      nextRetryAt: new Date(nowMs + 1_000).toISOString(),
      lastHealthAt: new Date(nowMs).toISOString(),
    });

    await expect(
      registry.reconcileNetworkEndpoint(device.id, endpoint.id),
    ).resolves.toMatchObject({
      status: "backoff",
      retryAfterMs: 1_000,
    });
    expect(provider.probeCalls).toHaveLength(1);

    nowMs += 1_000;
    await expect(
      registry.reconcileNetworkEndpoint(device.id, endpoint.id),
    ).resolves.toMatchObject({
      status: "degraded",
      retryAfterMs: 2_000,
    });
    nowMs += 2_000;
    await expect(
      registry.reconcileNetworkEndpoint(device.id, endpoint.id),
    ).resolves.toMatchObject({
      status: "offline",
      retryAfterMs: 5_000,
    });
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "offline",
      consecutiveFailures: 3,
      retryCount: 3,
    });
    expect(database.getDeviceEndpoint(endpoint.id)).toMatchObject({
      status: "offline",
      consecutiveFailures: 3,
      lastFailureCode: "ADB_PORT_UNREACHABLE",
      nextRetryAt: new Date(nowMs + 5_000).toISOString(),
      lastHealthAt: new Date(nowMs).toISOString(),
    });
    expect(provider.connectCalls).toHaveLength(1);
  });

  it("5555 恢复成功清零失败计数，设备 Busy 时不主动探测或重连", async () => {
    let nowMs = 1_800_000_000_000;
    registry = new DeviceRegistryService(database, [provider], {
      now: () => nowMs,
      random: () => 0.5,
    });
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.51:5555", "SERIAL-1"),
      host: "192.0.2.51",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.0.2.51",
      5555,
    );
    provider.probeImpl = async () => false;
    await registry.reconcileNetworkEndpoint(device.id, endpoint.id);
    nowMs += 1_000;
    provider.probeImpl = async () => true;

    await expect(
      registry.reconcileNetworkEndpoint(device.id, endpoint.id),
    ).resolves.toMatchObject({ status: "online" });
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "online",
      consecutiveFailures: 0,
      retryCount: 0,
      nextRetryAt: undefined,
    });
    expect(database.getDeviceEndpoint(endpoint.id)).toMatchObject({
      status: "online",
      consecutiveFailures: 0,
      lastFailureCode: undefined,
      nextRetryAt: undefined,
      lastHealthAt: expect.any(String),
    });

    vi.spyOn(database, "getDeviceQueueStatus").mockReturnValue("running");
    await expect(
      registry.reconcileNetworkEndpoint(device.id, endpoint.id),
    ).resolves.toMatchObject({
      status: "busy",
      failureCode: "DEVICE_BUSY",
    });
    expect(provider.probeCalls).toHaveLength(2);
  });

  it("Managed 自动自愈在 TLS 可回退失败后验证历史 TCP 5555，任一可信路径成功即恢复设备", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.53:5555", "SERIAL-1"),
      host: "192.0.2.53",
      port: 5555,
    };
    const tcp = await registry.connectNetwork(device.id, "192.0.2.53", 5555);
    const tls = database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "wireless_tls",
      adbSerial: "192.0.2.53:42747",
      host: "192.0.2.53",
      port: 42747,
      serviceInstance: "adb-SERIAL-1-managed-tls",
      pairingState: "observed_working",
      lastVerifiedAt: "2026-09-01T10:00:00.000Z",
      status: "online",
    });
    registry.setNetworkManagementMode(device.id, "managed");
    provider.probeCalls = [];
    provider.connectCalls = [];
    provider.probeImpl = async (_host, port) => port === 5555;
    provider.connectImpl = async (host, port) => ({
      ...onlineDevice(`${host}:${port}`, "SERIAL-1"),
      host,
      port,
    });

    await expect(registry.reconcileManagedNetworkEndpoints()).resolves.toEqual([
      expect.objectContaining({
        deviceId: device.id,
        endpointId: tls.id,
        result: expect.objectContaining({
          status: "online",
          endpoint: expect.objectContaining({ id: tcp.id, port: 5555 }),
        }),
      }),
    ]);
    expect(provider.probeCalls).toEqual([
      { host: "192.0.2.53", port: 42747 },
      { host: "192.0.2.53", port: 5555 },
    ]);
    expect(
      provider.connectCalls.map(({ host, port }) => ({ host, port })),
    ).toEqual([{ host: "192.0.2.53", port: 5555 }]);
    expect(database.getDeviceEndpoint(tls.id)).toMatchObject({
      consecutiveFailures: 1,
      lastFailureCode: "WIRELESS_TLS_UNREACHABLE",
    });
    expect(database.getDeviceEndpoint(tcp.id)).toMatchObject({
      status: "online",
      consecutiveFailures: 0,
      lastFailureCode: undefined,
    });
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "online",
      activeEndpointId: tcp.id,
      consecutiveFailures: 0,
      reasonCode: undefined,
    });
  });

  it("Managed 自动自愈遇到 TLS 身份冲突时禁止 TCP fallback 并立即进入人工锁定", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.54:5555", "SERIAL-1"),
      host: "192.0.2.54",
      port: 5555,
    };
    await registry.connectNetwork(device.id, "192.0.2.54", 5555);
    const tls = database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "wireless_tls",
      adbSerial: "192.0.2.54:43434",
      host: "192.0.2.54",
      port: 43434,
      serviceInstance: "adb-SERIAL-1-managed-mismatch",
      pairingState: "observed_working",
      lastVerifiedAt: "2026-09-01T10:00:00.000Z",
      status: "online",
    });
    registry.setNetworkManagementMode(device.id, "managed");
    provider.probeCalls = [];
    provider.connectCalls = [];
    provider.probeImpl = async () => true;
    provider.connectImpl = async (host, port) => ({
      ...onlineDevice(`${host}:${port}`, "WRONG-SERIAL"),
      host,
      port,
    });

    await expect(registry.reconcileManagedNetworkEndpoints()).resolves.toEqual([
      expect.objectContaining({
        endpointId: tls.id,
        result: expect.objectContaining({
          status: "manual_action",
          failureCode: "DEVICE_IDENTITY_MISMATCH",
        }),
      }),
    ]);
    expect(provider.probeCalls).toEqual([
      { host: "192.0.2.54", port: 43434 },
    ]);
    expect(
      provider.connectCalls.map(({ host, port }) => ({ host, port })),
    ).toEqual([{ host: "192.0.2.54", port: 43434 }]);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "manual_action",
      reasonCode: "DEVICE_IDENTITY_MISMATCH",
      actionRequired: "CHECK_NETWORK_ADB_ENDPOINT",
    });
    expect(database.getDeviceEndpoint(tls.id)).toMatchObject({
      status: "offline",
      consecutiveFailures: 1,
      lastFailureCode: "DEVICE_IDENTITY_MISMATCH",
      nextRetryAt: undefined,
    });
  });

  it("ADB Worker 被动健康证据通过连接控制器写入并拒绝旧 generation", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.52:5555", "SERIAL-1"),
      host: "192.0.2.52",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.0.2.52",
      5555,
    );
    const generation = database.getDeviceConnectionState(
      device.id,
    )!.connectionGeneration;

    expect(
      registry.recordAdbCommandHealthEvidence({
        deviceId: device.id,
        endpointId: endpoint.id,
        generation,
        evidence: {
          kind: "transport_failed",
          failureCode: "ADB_DEVICE_OFFLINE",
        },
      }),
    ).toBe(true);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "degraded",
      reasonCode: "ADB_DEVICE_OFFLINE",
    });
    expect(database.getDeviceEndpoint(endpoint.id)).toMatchObject({
      consecutiveFailures: 1,
      lastFailureCode: "ADB_DEVICE_OFFLINE",
      lastHealthAt: expect.any(String),
    });
    expect(database.listConnectionEvents(device.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "adb_command_transport_failed",
          source: "adb_worker",
          generation,
          failureCode: "ADB_DEVICE_OFFLINE",
        }),
      ]),
    );

    expect(
      registry.recordAdbCommandHealthEvidence({
        deviceId: device.id,
        endpointId: endpoint.id,
        generation: generation - 1,
        evidence: { kind: "healthy" },
      }),
    ).toBe(false);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "degraded",
      reasonCode: "ADB_DEVICE_OFFLINE",
    });

    expect(
      registry.recordAdbCommandHealthEvidence({
        deviceId: device.id,
        endpointId: endpoint.id,
        generation,
        evidence: { kind: "healthy" },
      }),
    ).toBe(true);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "online",
      reasonCode: undefined,
      consecutiveFailures: 0,
    });
    expect(database.getDeviceEndpoint(endpoint.id)).toMatchObject({
      status: "online",
      consecutiveFailures: 0,
      lastFailureCode: undefined,
      nextRetryAt: undefined,
      lastHealthAt: expect.any(String),
    });
  });

  it("Managed 5555 自动对账最多同时恢复三台，Manual 设备不被自动操作", async () => {
    const managed = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const device = await register(`SERIAL-${index + 1}`);
        provider.connectResult = {
          ...onlineDevice(`192.0.2.${index + 1}:5555`, `SERIAL-${index + 1}`),
          host: `192.0.2.${index + 1}`,
          port: 5555,
        };
        const endpoint = await registry.connectNetwork(
          device.id,
          `192.0.2.${index + 1}`,
          5555,
        );
        database.setDeviceConnectionManagementMode(device.id, "managed");
        return { device, endpoint };
      }),
    );
    const manual = await register("SERIAL-99");
    provider.connectResult = {
      ...onlineDevice("192.0.2.99:5555", "SERIAL-99"),
      host: "192.0.2.99",
      port: 5555,
    };
    await registry.connectNetwork(manual.id, "192.0.2.99", 5555);

    provider.probeCalls = [];
    let releaseProbe: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    provider.probeImpl = async () => {
      await blocked;
      return false;
    };
    const reconciliation = registry.reconcileManagedNetworkEndpoints();
    await vi.waitFor(() => expect(provider.probeCalls).toHaveLength(3));
    expect(new Set(provider.probeCalls.map((call) => call.host)).size).toBe(3);
    releaseProbe?.();
    await reconciliation;

    expect(provider.probeCalls).toHaveLength(5);
    expect(provider.probeCalls.some((call) => call.host === "192.0.2.99")).toBe(
      false,
    );
    expect(
      managed.every(
        ({ device }) =>
          database.getDeviceConnectionState(device.id)?.consecutiveFailures ===
          1,
      ),
    ).toBe(true);
  });

  it("管理模式切换要求已验证 Endpoint、重复提交幂等，并记录审计事件", async () => {
    const device = await register();
    expect(() =>
      registry.setNetworkManagementMode(device.id, "managed"),
    ).toThrowError(
      expect.objectContaining({
        code: "VERIFIED_NETWORK_ENDPOINT_REQUIRED",
        statusCode: 409,
      }),
    );
    provider.connectResult = {
      ...onlineDevice("192.0.2.60:5555", "SERIAL-1"),
      host: "192.0.2.60",
      port: 5555,
    };
    await registry.connectNetwork(device.id, "192.0.2.60", 5555);

    expect(
      registry.setNetworkManagementMode(device.id, "managed"),
    ).toMatchObject({ managementMode: "managed" });
    expect(
      registry.setNetworkManagementMode(device.id, "managed"),
    ).toMatchObject({ managementMode: "managed" });
    expect(
      registry.setNetworkManagementMode(device.id, "manual"),
    ).toMatchObject({ managementMode: "manual" });
    expect(
      database
        .listConnectionEvents(device.id)
        .filter((event) => event.eventType === "management_mode_changed"),
    ).toEqual([
      expect.objectContaining({ result: "managed" }),
      expect.objectContaining({ result: "manual" }),
    ]);
    expect(() =>
      registry.setNetworkManagementMode("missing-device", "managed"),
    ).toThrowError(
      expect.objectContaining({ code: "DEVICE_NOT_FOUND", statusCode: 404 }),
    );
  });

  it("Wireless TLS Endpoint 切换管理模式时保留真实传输类型", async () => {
    const device = await register();
    const endpoint = database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "wireless_tls",
      adbSerial: "192.0.2.61:42747",
      host: "192.0.2.61",
      port: 42747,
      serviceInstance: "adb-SERIAL-1-tls",
      pairingState: "observed_working",
      lastVerifiedAt: "2026-09-01T10:00:00.000Z",
      status: "online",
    });
    const operation = database.beginDeviceConnectionOperation({
      deviceId: device.id,
      operationId: "prepare-tls-management-mode",
      deadlineAt: "2099-01-01T00:00:00.000Z",
    });
    database.commitDeviceConnectionOperation({
      deviceId: device.id,
      operationId: operation.operationId!,
      generation: operation.connectionGeneration,
      observedState: "online",
      desiredState: "connected",
      activeEndpointId: endpoint.id,
    });

    registry.setNetworkManagementMode(device.id, "shadow");

    expect(
      database
        .listConnectionEvents(device.id)
        .filter((event) => event.eventType === "management_mode_changed"),
    ).toEqual([
      expect.objectContaining({
        result: "shadow",
        transportType: "wireless_tls",
        endpointSummary: expect.objectContaining({
          host: "192.0.2.61",
          port: 42747,
          transportType: "wireless_tls",
        }),
      }),
    ]);
  });

  it("Wireless TLS Endpoint 断开、删除和 Busy 跳过事件保留真实传输类型", async () => {
    const device = await register();
    const endpoint = database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "wireless_tls",
      adbSerial: "192.0.2.62:42747",
      host: "192.0.2.62",
      port: 42747,
      serviceInstance: "adb-SERIAL-1-tls-events",
      pairingState: "observed_working",
      lastVerifiedAt: "2026-09-01T10:00:00.000Z",
      status: "online",
    });
    const operation = database.beginDeviceConnectionOperation({
      deviceId: device.id,
      operationId: "prepare-tls-events",
      deadlineAt: "2099-01-01T00:00:00.000Z",
    });
    database.commitDeviceConnectionOperation({
      deviceId: device.id,
      operationId: operation.operationId!,
      generation: operation.connectionGeneration,
      observedState: "online",
      desiredState: "connected",
      activeEndpointId: endpoint.id,
    });

    vi.spyOn(database, "getDeviceQueueStatus").mockReturnValueOnce("running");
    await expect(
      registry.reconcileNetworkEndpoint(device.id, endpoint.id),
    ).resolves.toMatchObject({ status: "busy", failureCode: "DEVICE_BUSY" });

    await registry.disconnectNetwork(device.id, endpoint.id);
    await registry.removeNetworkEndpoint(device.id, endpoint.id);

    for (const eventType of [
      "recovery_skipped_device_busy",
      "endpoint_disconnected",
      "endpoint_removed",
    ]) {
      expect(
        database
          .listConnectionEvents(device.id)
          .find((event) => event.eventType === eventType),
      ).toMatchObject({
        transportType: "wireless_tls",
        endpointSummary: expect.objectContaining({
          host: "192.0.2.62",
          port: 42747,
          transportType: "wireless_tls",
        }),
      });
    }
  });

  it("Shadow mDNS 只维护 Observation 和摘要事件，不连接或修改正式 Endpoint", async () => {
    let nowMs = 1_800_000_000_000;
    registry = new DeviceRegistryService(database, [provider], {
      now: () => nowMs,
      random: () => 0.5,
    });
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.80:37123", "SERIAL-1"),
      host: "192.0.2.80",
      port: 37123,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.0.2.80",
      37123,
    );
    registry.setNetworkManagementMode(device.id, "shadow");
    const connectionBefore = database.getDeviceConnectionState(device.id);
    provider.networkCandidates = [
      {
        serial: "192.0.2.80:37123",
        platform: "android",
        host: "192.0.2.80",
        port: 37123,
        serviceInstance: "adb-SERIAL-1",
        networkTransport: "wireless_tls",
        connectionStatus: "unknown",
      },
    ];
    const connectCallsBefore = provider.connectCalls.length;

    await expect(registry.refreshShadowNetworkObservations()).resolves.toEqual([
      expect.objectContaining({
        source: "mdns",
        serviceInstance: "adb-serial-1",
        transportType: "wireless_tls",
        host: "192.0.2.80",
        port: 37123,
        verificationStatus: "unverified",
      }),
    ]);
    await registry.refreshShadowNetworkObservations();

    expect(provider.connectCalls).toHaveLength(connectCallsBefore);
    expect(database.getDeviceEndpoint(endpoint.id)).toEqual(endpoint);
    expect(database.getDeviceConnectionState(device.id)).toEqual(
      connectionBefore,
    );
    expect(
      database
        .listConnectionEvents(device.id)
        .filter(
          (event) => event.eventType === "endpoint_observation_discovered",
        ),
    ).toEqual([
      expect.objectContaining({
        source: "shadow_mdns",
        transportType: "wireless_tls",
        result: "observed",
        endpointSummary: expect.objectContaining({
          host: "192.0.2.80",
          port: 37123,
          serviceInstance: "adb-serial-1",
        }),
      }),
    ]);

    nowMs += 60_001;
    provider.networkCandidates = [];
    await expect(registry.refreshShadowNetworkObservations()).resolves.toEqual(
      [],
    );
    expect(database.listConnectionEvents(device.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "endpoint_observation_expired",
          source: "shadow_mdns",
          result: "expired",
        }),
      ]),
    );
    expect(database.getDeviceEndpoint(endpoint.id)).toEqual(endpoint);
  });

  it("未绑定的 Shadow Observation 也必须保留可关联的发现证据", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.79:33427", "SERIAL-1"),
      host: "192.0.2.79",
      port: 33427,
    };
    await registry.connectNetwork(device.id, "192.0.2.79", 33427);
    registry.setNetworkManagementMode(device.id, "shadow");

    expect(
      registry.observeTrackedNetworkTransport({
        serviceInstance: "adb-SERIAL-1-new-port",
        transportType: "wireless_tls",
        host: "192.0.2.80",
        port: 42747,
      }),
    ).toBe(true);

    const [event] = database
      .listConnectionEvents(device.id)
      .filter((item) => item.eventType === "endpoint_observation_discovered");
    expect(event).toMatchObject({
      source: "shadow_adb_track",
      generation: 1,
      result: "observed",
      endpointSummary: {
        host: "192.0.2.80",
        port: 42747,
        transportType: "wireless_tls",
        serviceInstance: "adb-serial-1-new-port",
      },
    });
  });

  it("Manual 模式不启动 Shadow mDNS，发现失败也不能污染已有 Observation", async () => {
    const device = await register();
    provider.networkCandidates = [
      {
        serial: "192.0.2.81:37123",
        platform: "android",
        host: "192.0.2.81",
        port: 37123,
        serviceInstance: "adb-SERIAL-1",
        networkTransport: "wireless_tls",
        connectionStatus: "unknown",
      },
    ];
    await expect(registry.refreshShadowNetworkObservations()).resolves.toEqual(
      [],
    );
    expect(registry.listNetworkObservations()).toEqual([]);

    provider.connectResult = {
      ...onlineDevice("192.0.2.81:37123", "SERIAL-1"),
      host: "192.0.2.81",
      port: 37123,
    };
    await registry.connectNetwork(device.id, "192.0.2.81", 37123);
    registry.setNetworkManagementMode(device.id, "shadow");
    provider.networkCandidates = [];
    provider.discoverNetwork = async () => {
      throw new Error("adb mdns unavailable");
    };

    await expect(
      registry.refreshShadowNetworkObservations(),
    ).rejects.toMatchObject({
      code: "ADB_MDNS_DISCOVERY_FAILED",
      statusCode: 503,
      message: expect.stringContaining("adb mdns unavailable"),
    });
    expect(registry.listNetworkObservations()).toEqual([]);
    expect(
      database.getDeviceEndpointByKind(device.id, "network"),
    ).toMatchObject({
      adbSerial: "192.0.2.81:37123",
      status: "online",
    });
  });

  it("mDNS 成功返回空时保留已验证 Endpoint，但任务不得使用未重新观察的旧 Endpoint", async () => {
    let nowMs = 1_800_000_000_000;
    registry = new DeviceRegistryService(database, [provider], {
      now: () => nowMs,
      random: () => 0.5,
    });
    const device = await register();
    const host = "192.0.2.84";
    const port = 37123;
    provider.connectResult = {
      ...onlineDevice(`${host}:${port}`, "SERIAL-1"),
      host,
      port,
    };
    await registry.connectNetwork(device.id, host, port);
    database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "wireless_tls",
      adbSerial: `${host}:${port}`,
      host,
      port,
      serviceInstance: "adb-SERIAL-1-tls",
      lastVerifiedAt: new Date(nowMs - 1_000).toISOString(),
      status: "online",
    });
    registry.setNetworkManagementMode(device.id, "shadow");
    provider.candidates = [
      {
        ...onlineDevice(`${host}:${port}`, "SERIAL-1"),
        host,
        port,
      },
    ];
    provider.networkCandidates = [
      {
        serial: `${host}:${port}`,
        platform: "android",
        host,
        port,
        serviceInstance: "adb-SERIAL-1-tls",
        networkTransport: "wireless_tls",
        connectionStatus: "unknown",
      },
    ];

    await registry.refreshShadowNetworkObservations();
    await expect(
      registry.resolveExecutionEndpoint(device.id, "network"),
    ).resolves.toMatchObject({
      transportType: "wireless_tls",
      host,
      port,
    });

    nowMs += 60_001;
    provider.networkCandidates = [];
    await expect(registry.refreshShadowNetworkObservations()).resolves.toEqual([]);

    await expect(
      registry.resolveExecutionEndpoint(device.id, "network"),
    ).rejects.toMatchObject<DeviceRegistrationError>({
      code: "DEVICE_NOT_ONLINE",
    });
    expect(database.getDeviceEndpointByKind(device.id, "network")).toMatchObject({
      transportType: "wireless_tls",
      host,
      port,
      status: "online",
    });
  });

  it("mDNS 查询失败时保留最近 Observation，成功查询后才过期", async () => {
    let nowMs = 1_800_000_000_000;
    registry = new DeviceRegistryService(database, [provider], {
      now: () => nowMs,
      random: () => 0.5,
    });
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.83:37123", "SERIAL-1"),
      host: "192.0.2.83",
      port: 37123,
    };
    await registry.connectNetwork(device.id, "192.0.2.83", 37123);
    registry.setNetworkManagementMode(device.id, "shadow");
    provider.networkCandidates = [
      {
        serial: "192.0.2.83:37123",
        platform: "android",
        host: "192.0.2.83",
        port: 37123,
        serviceInstance: "adb-SERIAL-1",
        networkTransport: "wireless_tls",
        connectionStatus: "unknown",
      },
    ];
    await registry.refreshShadowNetworkObservations();
    nowMs += 60_001;
    provider.discoverNetwork = async () => {
      throw new Error("adb mdns unavailable");
    };

    await expect(registry.refreshShadowNetworkObservations()).rejects.toMatchObject({
      code: "ADB_MDNS_DISCOVERY_FAILED",
    });
    expect(
      database
        .listConnectionEvents(device.id)
        .filter((event) => event.eventType === "endpoint_observation_expired"),
    ).toHaveLength(0);

    provider.discoverNetwork = async () => [];
    await expect(registry.refreshShadowNetworkObservations()).resolves.toEqual([]);
    expect(
      database
        .listConnectionEvents(device.id)
        .filter((event) => event.eventType === "endpoint_observation_expired"),
    ).toHaveLength(1);
  });

  it("adb track-devices 事件沿用 Observation 去重且不改写 USB、Endpoint 或连接状态", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.82:5555", "SERIAL-1"),
      host: "192.0.2.82",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.0.2.82",
      5555,
    );
    registry.setNetworkManagementMode(device.id, "shadow");
    const usbBefore = database.getDeviceEndpointByKind(device.id, "usb");
    const networkBefore = database.getDeviceEndpoint(endpoint.id);
    const stateBefore = database.getDeviceConnectionState(device.id);

    expect(
      registry.observeTrackedNetworkTransport({
        serviceInstance: "192.0.2.82:5555",
        transportType: "tcp_legacy",
        host: "192.0.2.82",
        port: 5555,
      }),
    ).toBe(true);
    expect(
      registry.observeTrackedNetworkTransport({
        serviceInstance: "192.0.2.82:5555",
        transportType: "tcp_legacy",
        host: "192.0.2.82",
        port: 5555,
      }),
    ).toBe(false);

    expect(database.getDeviceEndpointByKind(device.id, "usb")).toEqual(
      usbBefore,
    );
    expect(database.getDeviceEndpoint(endpoint.id)).toMatchObject({
      ...networkBefore,
      lastObservationAt: expect.any(String),
      observationExpiresAt: expect.any(String),
      observationSource: "adb_track",
    });
    expect(database.getDeviceConnectionState(device.id)).toEqual(stateBefore);
    expect(
      database
        .listConnectionEvents(device.id)
        .filter(
          (event) =>
            event.eventType === "endpoint_observation_discovered" &&
            event.source === "shadow_adb_track",
        ),
    ).toHaveLength(1);
  });

  it("5555 连续五次恢复失败后进入 manual_action 并停止自动调度", async () => {
    let nowMs = 1_800_000_000_000;
    registry = new DeviceRegistryService(database, [provider], {
      now: () => nowMs,
      random: () => 0.5,
    });
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.61:5555", "SERIAL-1"),
      host: "192.0.2.61",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.0.2.61",
      5555,
    );
    registry.setNetworkManagementMode(device.id, "managed");
    provider.probeImpl = async () => false;

    for (const waitMs of [0, 1_000, 2_000, 5_000, 10_000]) {
      nowMs += waitMs;
      await registry.reconcileNetworkEndpoint(device.id, endpoint.id);
    }
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "manual_action",
      consecutiveFailures: 5,
      nextRetryAt: undefined,
      actionRequired: "CHECK_NETWORK_ADB_ENDPOINT",
    });
    const probesBefore = provider.probeCalls.length;
    await registry.reconcileManagedNetworkEndpoints();
    expect(provider.probeCalls).toHaveLength(probesBefore);
  });

  it("Managed 设备只在候选端口可达且强身份匹配后原子激活新 Endpoint", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.80:5555", "SERIAL-1"),
      host: "192.0.2.80",
      port: 5555,
    };
    const previous = await registry.connectNetwork(
      device.id,
      "192.0.2.80",
      5555,
    );
    registry.setNetworkManagementMode(device.id, "managed");
    const usbBefore = database.getDeviceEndpointByKind(device.id, "usb");

    expect(
      registry.observeTrackedNetworkTransport({
        serviceInstance: "192.0.2.81:5555",
        transportType: "tcp_legacy",
        host: "192.0.2.81",
        port: 5555,
      }),
    ).toBe(true);
    const observation = registry
      .listNetworkObservations()
      .find((item) => item.host === "192.0.2.81")!;
    provider.connectResult = {
      ...onlineDevice("192.0.2.81:5555", "SERIAL-1"),
      host: "192.0.2.81",
      port: 5555,
    };

    const adopted = await registry.adoptManagedNetworkObservation(
      device.id,
      observation.id,
    );
    expect(adopted).toMatchObject({
      deviceId: device.id,
      kind: "network",
      adbSerial: "192.0.2.81:5555",
      host: "192.0.2.81",
      port: 5555,
      status: "online",
    });
    expect(database.getDeviceEndpoint(previous.id)).toMatchObject({
      id: previous.id,
      host: "192.0.2.81",
      port: 5555,
      status: "online",
    });
    expect(database.getDeviceEndpointByKind(device.id, "usb")).toEqual(
      usbBefore,
    );
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      managementMode: "managed",
      desiredNetworkState: "connected",
      observedNetworkState: "online",
      activeEndpointId: adopted.id,
    });
    expect(database.listConnectionEvents(device.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "endpoint_activated",
          source: "managed_discovery",
          endpointSummary: expect.objectContaining({
            host: "192.0.2.81",
            port: 5555,
          }),
        }),
      ]),
    );
  });

  it("Managed 候选身份证据不足时保留原在线 Endpoint 且不遗留 connecting", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.83:5555", "SERIAL-1"),
      host: "192.0.2.83",
      port: 5555,
    };
    const previous = await registry.connectNetwork(
      device.id,
      "192.0.2.83",
      5555,
    );
    registry.setNetworkManagementMode(device.id, "managed");
    registry.observeTrackedNetworkTransport({
      serviceInstance: "192.0.2.84:5555",
      transportType: "tcp_legacy",
      host: "192.0.2.84",
      port: 5555,
    });
    const observation = registry
      .listNetworkObservations()
      .find((item) => item.host === "192.0.2.84")!;
    provider.connectResult = {
      ...onlineDevice("192.0.2.84:5555", ""),
      hardwareSerial: undefined,
      host: "192.0.2.84",
      port: 5555,
    };

    await expect(
      registry.adoptManagedNetworkObservation(device.id, observation.id),
    ).rejects.toMatchObject({
      code: "DEVICE_IDENTITY_UNVERIFIED",
    });
    expect(database.getDeviceEndpoint(previous.id)).toMatchObject({
      id: previous.id,
      host: "192.0.2.83",
      port: 5555,
      status: "online",
    });
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      managementMode: "managed",
      observedNetworkState: "online",
      activeEndpointId: previous.id,
    });
    expect(database.listConnectionEvents(device.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "endpoint_verification_failed",
          source: "managed_discovery",
          failureCode: "DEVICE_IDENTITY_UNVERIFIED",
          result: "failed",
        }),
      ]),
    );
  });

  it("Managed 候选验证超时保留原在线 Endpoint 并拒绝迟到成功", async () => {
    registry = new DeviceRegistryService(database, [provider], {
      connectionOperationDeadlineMs: 20,
    });
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.85:5555", "SERIAL-1"),
      host: "192.0.2.85",
      port: 5555,
    };
    const previous = await registry.connectNetwork(
      device.id,
      "192.0.2.85",
      5555,
    );
    registry.setNetworkManagementMode(device.id, "managed");
    registry.observeTrackedNetworkTransport({
      serviceInstance: "192.0.2.86:5555",
      transportType: "tcp_legacy",
      host: "192.0.2.86",
      port: 5555,
    });
    const observation = registry
      .listNetworkObservations()
      .find((item) => item.host === "192.0.2.86")!;
    let release: (() => void) | undefined;
    provider.connectImpl = async (host, port) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...onlineDevice(`${host}:${port}`, "SERIAL-1"), host, port };
    };

    await expect(
      registry.adoptManagedNetworkObservation(device.id, observation.id),
    ).rejects.toMatchObject({
      code: "NETWORK_RECOVERY_DEADLINE_EXCEEDED",
    });
    expect(database.getDeviceEndpoint(previous.id)).toMatchObject({
      id: previous.id,
      host: "192.0.2.85",
      port: 5555,
      status: "online",
    });
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "online",
      activeEndpointId: previous.id,
    });

    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(database.getDeviceEndpoint(previous.id)).toMatchObject({
      id: previous.id,
      host: "192.0.2.85",
      port: 5555,
      status: "online",
    });
  });

  it("Managed 设备进入 manual_action 后不再自动验证候选 Endpoint", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.87:5555", "SERIAL-1"),
      host: "192.0.2.87",
      port: 5555,
    };
    await registry.connectNetwork(device.id, "192.0.2.87", 5555);
    registry.setNetworkManagementMode(device.id, "managed");
    const operation = database.beginDeviceConnectionOperation({
      deviceId: device.id,
      operationId: "force-manual-action",
      deadlineAt: "2099-01-01T00:00:00.000Z",
    });
    database.recordDeviceConnectionHealthFailure({
      deviceId: device.id,
      operationId: operation.operationId!,
      generation: operation.connectionGeneration,
      reasonCode: "RECOVERY_BUDGET_EXHAUSTED",
      terminal: true,
      manualAction: true,
    });
    registry.observeTrackedNetworkTransport({
      serviceInstance: "192.0.2.88:5555",
      transportType: "tcp_legacy",
      host: "192.0.2.88",
      port: 5555,
    });
    const observation = registry
      .listNetworkObservations()
      .find((item) => item.host === "192.0.2.88")!;
    const callsBefore = provider.connectCalls.length;

    await expect(
      registry.adoptManagedNetworkObservation(device.id, observation.id),
    ).rejects.toMatchObject({
      code: "MANUAL_ACTION_REQUIRED",
    });
    expect(provider.probeCalls).toHaveLength(0);
    expect(provider.connectCalls).toHaveLength(callsBefore);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "manual_action",
      reasonCode: "RECOVERY_BUDGET_EXHAUSTED",
    });
  });

  it("人工恢复优先使用当前有效的 mDNS TLS Observation，而不是历史旧端口", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.150:39355", "SERIAL-1"),
      host: "192.0.2.150",
      port: 39355,
    };
    await registry.connectNetwork(device.id, "192.0.2.150", 39355);
    database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "wireless_tls",
      adbSerial: "192.0.2.150:39355",
      host: "192.0.2.150",
      port: 39355,
      serviceInstance: "adb-SERIAL-1-tls",
      status: "offline",
    });
    registry.setNetworkManagementMode(device.id, "managed");
    forceManualAction(device.id, "force-mdns-port-change-recovery");
    provider.networkCandidates = [{
      serial: "192.0.2.150:42747",
      platform: "android",
      host: "192.0.2.150",
      port: 42747,
      serviceInstance: "adb-SERIAL-1-new-port",
      networkTransport: "wireless_tls",
      connectionStatus: "unknown",
    }];
    await registry.refreshShadowNetworkObservations();
    provider.probeCalls = [];
    provider.connectCalls = [];
    provider.probeImpl = async () => true;
    provider.connectImpl = async (host, port) => ({
      ...onlineDevice(`${host}:${port}`, "SERIAL-1"),
      host,
      port,
    });
    expect(registry.listNetworkObservations()).toEqual([
      expect.objectContaining({ host: "192.0.2.150", port: 42747, transportType: "wireless_tls" }),
    ]);

    await expect(
      registry.recoverNetworkConnection(device.id),
    ).resolves.toMatchObject({
      transportType: "wireless_tls",
      host: "192.0.2.150",
      port: 42747,
      status: "online",
    });
    expect(provider.probeCalls).toEqual([
      { host: "192.0.2.150", port: 42747 },
    ]);
    expect(provider.connectCalls.map(({ host, port }) => ({ host, port }))).toEqual([
      { host: "192.0.2.150", port: 42747 },
    ]);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "online",
      consecutiveFailures: 0,
      reasonCode: undefined,
    });
  });

  it("人工恢复优先验证 Wireless TLS，成功后由 controller 清除 manual_action 状态", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.150:5555", "SERIAL-1"),
      host: "192.0.2.150",
      port: 5555,
    };
    const tcp = await registry.connectNetwork(device.id, "192.0.2.150", 5555);
    const tls = database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "wireless_tls",
      adbSerial: "192.0.2.150:33427",
      host: "192.0.2.150",
      port: 33427,
      serviceInstance: "adb-SERIAL-1-tls",
      status: "offline",
    });
    registry.setNetworkManagementMode(device.id, "managed");
    const operation = database.beginDeviceConnectionOperation({
      deviceId: device.id,
      operationId: "force-manual-recovery-success",
      deadlineAt: "2099-01-01T00:00:00.000Z",
    });
    database.recordDeviceConnectionHealthFailure({
      deviceId: device.id,
      operationId: operation.operationId!,
      generation: operation.connectionGeneration,
      reasonCode: "RECOVERY_BUDGET_EXHAUSTED",
      terminal: true,
      manualAction: true,
    });
    registry = new DeviceRegistryService(database, [provider], {
      managedObservationAdoptionEnabled: true,
      managedObservationAdoptionDeviceIds: [device.id],
    });
    provider.probeCalls = [];
    provider.connectCalls = [];
    provider.probeImpl = async () => true;
    provider.connectImpl = async (host, port) => ({
      ...onlineDevice(`${host}:${port}`, "SERIAL-1"),
      host,
      port,
    });

    await expect(
      registry.recoverNetworkConnection(device.id),
    ).resolves.toMatchObject({
      id: tls.id,
      transportType: "wireless_tls",
      host: "192.0.2.150",
      port: 33427,
      status: "online",
    });
    expect(provider.probeCalls).toEqual([{ host: "192.0.2.150", port: 33427 }]);
    expect(
      provider.connectCalls.map(({ host, port }) => ({ host, port })),
    ).toEqual([{ host: "192.0.2.150", port: 33427 }]);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "online",
      activeEndpointId: tls.id,
      consecutiveFailures: 0,
      retryCount: 0,
      nextRetryAt: undefined,
      reasonCode: undefined,
      actionRequired: undefined,
    });
    expect(database.getDeviceEndpoint(tcp.id)).toMatchObject({
      transportType: "tcp_legacy",
    });
  });

  it("人工恢复的旧 generation 迟到结果不得污染新状态或 Endpoint 健康", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.156:5555", "SERIAL-1"),
      host: "192.0.2.156",
      port: 5555,
    };
    const tcp = await registry.connectNetwork(device.id, "192.0.2.156", 5555);
    const tls = database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "wireless_tls",
      adbSerial: "192.0.2.156:42747",
      host: "192.0.2.156",
      port: 42747,
      serviceInstance: "adb-SERIAL-1-tls",
      status: "offline",
    });
    registry.setNetworkManagementMode(device.id, "managed");
    forceManualAction(device.id, "force-stale-manual-recovery");
    registry = new DeviceRegistryService(database, [provider], {
      managedObservationAdoptionEnabled: true,
      managedObservationAdoptionDeviceIds: [device.id],
      connectionOperationDeadlineMs: 5_000,
    });

    let releaseOldConnect: (() => void) | undefined;
    let connectStarted: (() => void) | undefined;
    const oldConnectStarted = new Promise<void>((resolve) => {
      connectStarted = resolve;
    });
    provider.probeImpl = async () => true;
    provider.connectImpl = async (host, port) => {
      if (port === 42747) {
        connectStarted?.();
        await new Promise<void>((resolve) => {
          releaseOldConnect = resolve;
        });
      }
      return { ...onlineDevice(`${host}:${port}`, "SERIAL-1"), host, port };
    };

    const recovery = registry.recoverNetworkConnection(device.id);
    await oldConnectStarted;

    const newer = database.beginDeviceConnectionOperation({
      deviceId: device.id,
      operationId: "newer-network-operation",
      deadlineAt: "2099-01-01T00:00:00.000Z",
      observedState: "connecting",
    });
    expect(
      database.commitDeviceConnectionOperation({
        deviceId: device.id,
        operationId: newer.operationId!,
        generation: newer.connectionGeneration,
        observedState: "online",
        activeEndpointId: tcp.id,
      }),
    ).toBe(true);

    releaseOldConnect?.();
    await expect(recovery).rejects.toMatchObject({
      code: "NETWORK_CONNECTION_STALE_RESULT",
    });
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "online",
      activeEndpointId: tcp.id,
      connectionGeneration: newer.connectionGeneration,
      consecutiveFailures: 0,
      retryCount: 0,
      reasonCode: undefined,
      actionRequired: undefined,
    });
    expect(database.getDeviceEndpoint(tls.id)).toMatchObject({
      status: "offline",
      consecutiveFailures: 0,
      lastFailureCode: undefined,
    });
    expect(database.listConnectionEvents(device.id)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "manual_recovery_attempt_failed",
          operationId: expect.stringContaining("device-connection-"),
        }),
      ]),
    );
  });

  it("人工恢复仅在 TLS 可回退失败码下验证历史 TCP 5555，失败锁定不能被直接清除", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.151:5555", "SERIAL-1"),
      host: "192.0.2.151",
      port: 5555,
    };
    const tcp = await registry.connectNetwork(device.id, "192.0.2.151", 5555);
    const tls = database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "wireless_tls",
      adbSerial: "192.0.2.151:42747",
      host: "192.0.2.151",
      port: 42747,
      serviceInstance: "adb-SERIAL-1-tls",
      status: "offline",
    });
    registry.setNetworkManagementMode(device.id, "managed");
    const operation = database.beginDeviceConnectionOperation({
      deviceId: device.id,
      operationId: "force-manual-recovery-fallback",
      deadlineAt: "2099-01-01T00:00:00.000Z",
    });
    database.recordDeviceConnectionHealthFailure({
      deviceId: device.id,
      operationId: operation.operationId!,
      generation: operation.connectionGeneration,
      reasonCode: "RECOVERY_BUDGET_EXHAUSTED",
      terminal: true,
      manualAction: true,
    });
    registry = new DeviceRegistryService(database, [provider], {
      managedObservationAdoptionEnabled: true,
      managedObservationAdoptionDeviceIds: [device.id],
    });
    provider.probeCalls = [];
    provider.connectCalls = [];
    provider.probeImpl = async (_host, port) => port === 5555;
    provider.connectImpl = async (host, port) => ({
      ...onlineDevice(`${host}:${port}`, "SERIAL-1"),
      host,
      port,
    });

    await expect(
      registry.recoverNetworkConnection(device.id),
    ).resolves.toMatchObject({
      id: tcp.id,
      transportType: "tcp_legacy",
      port: 5555,
      status: "online",
    });
    expect(provider.probeCalls).toEqual([
      { host: "192.0.2.151", port: 42747 },
      { host: "192.0.2.151", port: 5555 },
    ]);
    expect(
      provider.connectCalls.map(({ host, port }) => ({ host, port })),
    ).toEqual([{ host: "192.0.2.151", port: 5555 }]);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "online",
      activeEndpointId: tcp.id,
      consecutiveFailures: 0,
      reasonCode: undefined,
      actionRequired: undefined,
    });
    expect(database.getDeviceEndpoint(tls.id)).toMatchObject({
      transportType: "wireless_tls",
      consecutiveFailures: 1,
      lastFailureCode: "WIRELESS_TLS_UNREACHABLE",
      lastHealthAt: expect.any(String),
    });
    expect(database.getDeviceEndpoint(tcp.id)).toMatchObject({
      transportType: "tcp_legacy",
      status: "online",
      consecutiveFailures: 0,
      lastFailureCode: undefined,
    });
  });

  it.each([
    {
      name: "Gate 关闭",
      options: {
        managedObservationAdoptionEnabled: false,
        managedObservationAdoptionDeviceIds: ["DEVICE_ID"],
      },
      code: "MANAGED_OBSERVATION_ADOPTION_DISABLED",
    },
    {
      name: "Gate 空白名单",
      options: {
        managedObservationAdoptionEnabled: true,
        managedObservationAdoptionDeviceIds: [],
      },
      code: "NOT_IN_MANAGED_GATE_ALLOWLIST",
    },
    {
      name: "设备不在 Gate 白名单",
      options: {
        managedObservationAdoptionEnabled: true,
        managedObservationAdoptionDeviceIds: ["another-device"],
      },
      code: "NOT_IN_MANAGED_GATE_ALLOWLIST",
    },
  ])(
    "人工恢复在 $name 时 fail-closed 且不触发 ADB",
    async ({ options, code }) => {
      const device = await register();
      provider.connectResult = {
        ...onlineDevice("192.0.2.152:5555", "SERIAL-1"),
        host: "192.0.2.152",
        port: 5555,
      };
      await registry.connectNetwork(device.id, "192.0.2.152", 5555);
      registry.setNetworkManagementMode(device.id, "managed");
      forceManualAction(device.id, `force-${code}`);
      registry = new DeviceRegistryService(database, [provider], {
        ...options,
        managedObservationAdoptionDeviceIds:
          options.managedObservationAdoptionDeviceIds.map((id) =>
            id === "DEVICE_ID" ? device.id : id,
          ),
      });
      provider.probeCalls = [];
      provider.connectCalls = [];

      await expect(
        registry.recoverNetworkConnection(device.id),
      ).rejects.toMatchObject({ code });
      expect(provider.probeCalls).toEqual([]);
      expect(provider.connectCalls).toEqual([]);
      expect(database.getDeviceConnectionState(device.id)).toMatchObject({
        observedNetworkState: "manual_action",
        reasonCode: "RECOVERY_BUDGET_EXHAUSTED",
      });
    },
  );

  it("人工恢复拒绝非 manual_action 和设备忙状态，不启动验证", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.153:5555", "SERIAL-1"),
      host: "192.0.2.153",
      port: 5555,
    };
    await registry.connectNetwork(device.id, "192.0.2.153", 5555);
    registry.setNetworkManagementMode(device.id, "managed");
    registry = new DeviceRegistryService(database, [provider], {
      managedObservationAdoptionEnabled: true,
      managedObservationAdoptionDeviceIds: [device.id],
    });

    await expect(
      registry.recoverNetworkConnection(device.id),
    ).rejects.toMatchObject({ code: "MANUAL_ACTION_NOT_REQUIRED" });

    forceManualAction(device.id, "force-busy-manual-recovery");
    const apk = database.insertArtifact({
      kind: "apk",
      originalName: "busy.apk",
      mimeType: "application/vnd.android.package-archive",
      storagePath: "/tmp/busy.apk",
      sizeBytes: 1,
      sha256: "manual-recovery-busy-apk",
    });
    const video = database.insertArtifact({
      kind: "video",
      originalName: "busy.mp4",
      mimeType: "video/mp4",
      storagePath: "/tmp/busy.mp4",
      sizeBytes: 1,
      sha256: "manual-recovery-busy-video",
    });
    database.createTask({
      name: "manual-recovery-busy",
      apkArtifactId: apk.id,
      videoArtifactId: video.id,
      deviceIds: [device.id],
      timeoutSeconds: 30,
    });
    provider.probeCalls = [];
    provider.connectCalls = [];

    await expect(
      registry.recoverNetworkConnection(device.id),
    ).rejects.toMatchObject({ code: "DEVICE_BUSY" });
    expect(provider.probeCalls).toEqual([]);
    expect(provider.connectCalls).toEqual([]);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "manual_action",
    });
  });

  it("TLS 身份不匹配不得回退 TCP，失败后保持 manual_action 和失败计数", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.154:5555", "SERIAL-1"),
      host: "192.0.2.154",
      port: 5555,
    };
    await registry.connectNetwork(device.id, "192.0.2.154", 5555);
    database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "wireless_tls",
      adbSerial: "192.0.2.154:43434",
      host: "192.0.2.154",
      port: 43434,
      serviceInstance: "adb-SERIAL-1-tls",
      status: "offline",
    });
    registry.setNetworkManagementMode(device.id, "managed");
    forceManualAction(device.id, "force-identity-mismatch");
    const failuresBefore = database.getDeviceConnectionState(
      device.id,
    )!.consecutiveFailures;
    registry = new DeviceRegistryService(database, [provider], {
      managedObservationAdoptionEnabled: true,
      managedObservationAdoptionDeviceIds: [device.id],
    });
    provider.probeCalls = [];
    provider.connectCalls = [];
    provider.probeImpl = async () => true;
    provider.connectImpl = async (host, port) => ({
      ...onlineDevice(`${host}:${port}`, "WRONG-SERIAL"),
      host,
      port,
    });

    await expect(
      registry.recoverNetworkConnection(device.id),
    ).rejects.toMatchObject({ code: "DEVICE_IDENTITY_MISMATCH" });
    expect(provider.probeCalls).toEqual([{ host: "192.0.2.154", port: 43434 }]);
    expect(
      provider.connectCalls.map(({ host, port }) => ({ host, port })),
    ).toEqual([{ host: "192.0.2.154", port: 43434 }]);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "manual_action",
      reasonCode: "DEVICE_IDENTITY_MISMATCH",
      consecutiveFailures: failuresBefore + 1,
    });
  });

  it("未经历史验证的 TCP 5555 不参与人工恢复 fallback", async () => {
    const device = await register();
    database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "tcp_legacy",
      adbSerial: "192.0.2.155:5555",
      host: "192.0.2.155",
      port: 5555,
      status: "offline",
    });
    const tls = database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "wireless_tls",
      adbSerial: "192.0.2.155:44444",
      host: "192.0.2.155",
      port: 44444,
      serviceInstance: "adb-SERIAL-1-tls",
      status: "offline",
    });
    const initial = database.beginDeviceConnectionOperation({
      deviceId: device.id,
      operationId: "initialize-unverified-tcp-recovery",
      deadlineAt: "2099-01-01T00:00:00.000Z",
    });
    database.commitDeviceConnectionOperation({
      deviceId: device.id,
      operationId: initial.operationId!,
      generation: initial.connectionGeneration,
      desiredState: "connected",
      observedState: "online",
      activeEndpointId: tls.id,
    });
    forceManualAction(device.id, "force-unverified-tcp");
    registry.setNetworkManagementMode(device.id, "managed");
    registry = new DeviceRegistryService(database, [provider], {
      managedObservationAdoptionEnabled: true,
      managedObservationAdoptionDeviceIds: [device.id],
    });
    provider.probeCalls = [];
    provider.connectCalls = [];
    provider.probeImpl = async () => false;

    await expect(
      registry.recoverNetworkConnection(device.id),
    ).rejects.toMatchObject({ code: "WIRELESS_TLS_UNREACHABLE" });
    expect(provider.probeCalls).toEqual([{ host: "192.0.2.155", port: 44444 }]);
    expect(provider.connectCalls).toEqual([]);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "manual_action",
      reasonCode: "WIRELESS_TLS_UNREACHABLE",
    });
  });

  it("仅有一个 Managed 设备但 Observation 身份不明确时不猜测绑定", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.87:5555", "SERIAL-1"),
      host: "192.0.2.87",
      port: 5555,
    };
    await registry.connectNetwork(device.id, "192.0.2.87", 5555);
    registry.setNetworkManagementMode(device.id, "managed");
    registry = new DeviceRegistryService(database, [provider], {
      managedObservationAdoptionEnabled: true,
      managedObservationAdoptionDeviceIds: [device.id],
    });
    registry.observeTrackedNetworkTransport({
      serviceInstance: "adb-unknown-candidate-tls",
      transportType: "wireless_tls",
      host: "192.0.2.88",
      port: 33427,
    });
    const observation = registry.listNetworkObservations()[0]!;
    const failuresBefore =
      database.getDeviceConnectionState(device.id)?.consecutiveFailures ?? 0;
    provider.probeCalls = [];
    provider.connectCalls = [];

    await expect(registry.reconcileManagedNetworkObservations()).resolves.toEqual([
      {
        observationId: observation.id,
        status: "skipped",
        reasonCode: "OBSERVATION_IDENTITY_AMBIGUOUS",
      },
    ]);
    expect(provider.probeCalls).toEqual([]);
    expect(provider.connectCalls).toEqual([]);
    expect(
      database
        .listDeviceEndpoints(device.id)
        .filter(({ kind }) => kind === "network"),
    ).toHaveLength(1);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      consecutiveFailures: failuresBefore,
    });
  });

  it("单一 Managed 设备只采用同一 Observation 一次，重复对账不再发起 ADB", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.89:5555", "SERIAL-1"),
      host: "192.0.2.89",
      port: 5555,
    };
    await registry.connectNetwork(device.id, "192.0.2.89", 5555);
    registry.setNetworkManagementMode(device.id, "managed");
    registry.observeTrackedNetworkTransport({
      serviceInstance: "adb-SERIAL-1-candidate",
      transportType: "tcp_legacy",
      host: "192.0.2.90",
      port: 5555,
    });
    provider.connectResult = {
      ...onlineDevice("192.0.2.90:5555", "SERIAL-1"),
      host: "192.0.2.90",
      port: 5555,
    };
    const callsBefore = provider.connectCalls.length;

    await expect(
      registry.reconcileManagedNetworkObservations(),
    ).resolves.toEqual([
      expect.objectContaining({ deviceId: device.id, status: "adopted" }),
    ]);
    await expect(
      registry.reconcileManagedNetworkObservations(),
    ).resolves.toEqual([
      expect.objectContaining({
        deviceId: device.id,
        status: "skipped",
        reasonCode: "ENDPOINT_ALREADY_ACTIVE",
      }),
    ]);
    expect(provider.connectCalls).toHaveLength(callsBefore + 1);
    expect(
      database.getDeviceEndpointByKind(device.id, "network"),
    ).toMatchObject({
      host: "192.0.2.90",
      port: 5555,
      status: "online",
    });
  });

  it("Wireless TLS 动态端口变化更新同一逻辑 Endpoint 并保留 TCP 5555", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.129:5555", "SERIAL-1"),
      host: "192.0.2.129",
      port: 5555,
    };
    const tcp = await registry.connectNetwork(device.id, "192.0.2.129", 5555);
    registry.setNetworkManagementMode(device.id, "managed");
    provider.networkCandidates = [
      {
        serial: "192.0.2.129:33427",
        platform: "android",
        host: "192.0.2.129",
        port: 33427,
        serviceInstance: "adb-SERIAL-1-tls",
        networkTransport: "wireless_tls",
        connectionStatus: "unknown",
      },
    ];
    await registry.refreshShadowNetworkObservations();
    const oldObservation = registry
      .listNetworkObservations()
      .find(({ port }) => port === 33427)!;
    provider.connectResult = {
      ...onlineDevice("192.0.2.129:33427", "SERIAL-1"),
      host: "192.0.2.129",
      port: 33427,
    };
    const oldTls = await registry.adoptManagedNetworkObservation(
      device.id,
      oldObservation.id,
    );

    provider.networkCandidates = [
      {
        serial: "192.0.2.129:42747",
        platform: "android",
        host: "192.0.2.129",
        port: 42747,
        serviceInstance: "adb-SERIAL-1-tls",
        networkTransport: "wireless_tls",
        connectionStatus: "unknown",
      },
    ];
    await registry.refreshShadowNetworkObservations();
    const newObservation = registry
      .listNetworkObservations()
      .find(({ port }) => port === 42747)!;
    provider.connectResult = {
      ...onlineDevice("192.0.2.129:42747", "SERIAL-1"),
      host: "192.0.2.129",
      port: 42747,
    };
    const newTls = await registry.adoptManagedNetworkObservation(
      device.id,
      newObservation.id,
    );

    expect(newTls).toMatchObject({
      id: oldTls.id,
      transportType: "wireless_tls",
      adbSerial: "192.0.2.129:42747",
      host: "192.0.2.129",
      port: 42747,
      serviceInstance: "adb-serial-1-tls",
      status: "online",
    });
    expect(
      database
        .listDeviceEndpoints(device.id)
        .filter(({ kind }) => kind === "network"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: tcp.id,
          transportType: "tcp_legacy",
          port: 5555,
        }),
        expect.objectContaining({
          id: oldTls.id,
          transportType: "wireless_tls",
          port: 42747,
        }),
      ]),
    );
    expect(
      database
        .listDeviceEndpoints(device.id)
        .filter(({ transportType }) => transportType === "wireless_tls"),
    ).toHaveLength(1);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "online",
      activeEndpointId: oldTls.id,
    });
  });

  it("TLS 旧端口迟到成功不得覆盖新端口 generation 和 active Endpoint", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.131:5555", "SERIAL-1"),
      host: "192.0.2.131",
      port: 5555,
    };
    await registry.connectNetwork(device.id, "192.0.2.131", 5555);
    registry.setNetworkManagementMode(device.id, "managed");
    registry = new DeviceRegistryService(database, [provider], {
      connectionOperationDeadlineMs: 20,
    });
    registry.observeTrackedNetworkTransport({
      serviceInstance: "adb-SERIAL-1-tls",
      transportType: "wireless_tls",
      host: "192.0.2.131",
      port: 33427,
    });
    const oldObservation = registry
      .listNetworkObservations()
      .find(({ port }) => port === 33427)!;
    let releaseOldConnection: (() => void) | undefined;
    provider.connectImpl = async (host, port) => {
      if (port === 33427) {
        await new Promise<void>((resolve) => {
          releaseOldConnection = resolve;
        });
      }
      return { ...onlineDevice(`${host}:${port}`, "SERIAL-1"), host, port };
    };

    await expect(
      registry.adoptManagedNetworkObservation(device.id, oldObservation.id),
    ).rejects.toMatchObject({ code: "NETWORK_RECOVERY_DEADLINE_EXCEEDED" });

    registry.observeTrackedNetworkTransport({
      serviceInstance: "adb-SERIAL-1-tls",
      transportType: "wireless_tls",
      host: "192.0.2.131",
      port: 42747,
    });
    const newObservation = registry
      .listNetworkObservations()
      .find(({ port }) => port === 42747)!;
    const newTls = await registry.adoptManagedNetworkObservation(
      device.id,
      newObservation.id,
    );
    const newGeneration = database.getDeviceConnectionState(
      device.id,
    )!.connectionGeneration;

    releaseOldConnection?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(database.getDeviceEndpoint(newTls.id)).toMatchObject({
      id: newTls.id,
      transportType: "wireless_tls",
      adbSerial: "192.0.2.131:42747",
      host: "192.0.2.131",
      port: 42747,
      status: "online",
    });
    expect(
      database
        .listDeviceEndpoints(device.id)
        .filter(({ transportType }) => transportType === "wireless_tls"),
    ).toHaveLength(1);
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "online",
      activeEndpointId: newTls.id,
      connectionGeneration: newGeneration,
    });
  });

  it("已在线 TLS Endpoint 的重复 mDNS Observation 不会递增 generation", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.130:5555", "SERIAL-1"),
      host: "192.0.2.130",
      port: 5555,
    };
    await registry.connectNetwork(device.id, "192.0.2.130", 5555);
    const tcpEndpoint = database.getDeviceEndpointByKind(device.id, "network")!;
    database.upsertDeviceEndpoint({
      deviceId: device.id,
      kind: "network",
      transportType: "wireless_tls",
      adbSerial: "192.0.2.130:42747",
      host: "192.0.2.130",
      port: 42747,
      serviceInstance: "adb-SERIAL-1-tls",
      pairingState: "observed_working",
      priority: 100,
      status: "online",
    });
    registry.setNetworkManagementMode(device.id, "managed");
    const before = database.getDeviceConnectionState(
      device.id,
    )?.connectionGeneration;
    registry.observeTrackedNetworkTransport({
      serviceInstance: "adb-SERIAL-1-tls",
      transportType: "unknown",
      host: "192.0.2.130",
      port: 42747,
    });
    registry.observeTrackedNetworkTransport({
      serviceInstance: "adb-SERIAL-1-tls",
      transportType: "wireless_tls",
      host: "192.0.2.130",
      port: 42747,
    });
    const result = await registry.reconcileManagedNetworkObservations();
    expect(result).toEqual([
      expect.objectContaining({
        status: "skipped",
        reasonCode: "ENDPOINT_ALREADY_ACTIVE",
      }),
    ]);
    expect(
      database.getDeviceConnectionState(device.id)?.connectionGeneration,
    ).toBe(before);
    expect(database.getDeviceEndpoint(tcpEndpoint.id)).toBeDefined();
  });

  it("Managed Observation 突发验证全局最多并发 3 台", async () => {
    const devices = await registerNetworkDevices(5);
    let measure = false;
    let active = 0;
    let maxActive = 0;
    provider.connectImpl = async (host, port) => {
      const index = Number(host.split(".").at(-1));
      if (measure) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }
      return {
        ...onlineDevice(`${host}:${port}`, `SERIAL-${index}`),
        host,
        port,
      };
    };
    for (let index = 0; index < devices.length; index += 1) {
      const endpoint = database.getDeviceEndpointByKind(
        devices[index].id,
        "network",
      )!;
      await registry.connectNetwork(
        devices[index].id,
        endpoint.host!,
        endpoint.port!,
      );
      registry.setNetworkManagementMode(devices[index].id, "managed");
      registry.observeTrackedNetworkTransport({
        serviceInstance: `adb-SERIAL-${index + 1}-candidate`,
        transportType: "tcp_legacy",
        host: `198.51.100.${index + 1}`,
        port: 5555,
      });
    }
    measure = true;

    const results = await registry.reconcileManagedNetworkObservations();

    expect(
      results.filter((result) => result.status === "adopted"),
    ).toHaveLength(5);
    expect(maxActive).toBe(3);
  });

  it("mDNS 服务名按 Serial 边界归属，SERIAL-1 不会拦截 SERIAL-10", async () => {
    const serials = ["SERIAL-1", "SERIAL-10"];
    const devices = [];
    for (let index = 0; index < serials.length; index += 1) {
      const device = await register(serials[index]);
      provider.connectResult = {
        ...onlineDevice(`192.0.2.${100 + index}:5555`, serials[index]),
        host: `192.0.2.${100 + index}`,
        port: 5555,
      };
      await registry.connectNetwork(device.id, `192.0.2.${100 + index}`, 5555);
      registry.setNetworkManagementMode(device.id, "managed");
      devices.push(device);
    }
    registry.observeTrackedNetworkTransport({
      serviceInstance: "adb-SERIAL-10-candidate",
      transportType: "tcp_legacy",
      host: "198.51.100.10",
      port: 5555,
    });
    provider.connectResult = {
      ...onlineDevice("198.51.100.10:5555", "SERIAL-10"),
      host: "198.51.100.10",
      port: 5555,
    };

    await expect(
      registry.reconcileManagedNetworkObservations(),
    ).resolves.toEqual([
      expect.objectContaining({ deviceId: devices[1].id, status: "adopted" }),
    ]);
    expect(
      database.getDeviceEndpointByKind(devices[0].id, "network"),
    ).toMatchObject({ host: "192.0.2.100" });
    expect(
      database.getDeviceEndpointByKind(devices[1].id, "network"),
    ).toMatchObject({ host: "198.51.100.10" });
  });

  it("Shadow Observation 决策只读展示归属与原因，不调用 ADB 或修改状态", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.120:5555", "SERIAL-1"),
      host: "192.0.2.120",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.0.2.120",
      5555,
    );
    registry.setNetworkManagementMode(device.id, "shadow");
    registry.observeTrackedNetworkTransport({
      serviceInstance: "adb-SERIAL-1-candidate",
      transportType: "tcp_legacy",
      host: "192.0.2.120",
      port: 5555,
    });
    const callsBefore = provider.connectCalls.length;
    const endpointBefore = database.getDeviceEndpoint(endpoint.id);
    const stateBefore = database.getDeviceConnectionState(device.id);

    expect(registry.listNetworkObservationDecisions()).toEqual([
      expect.objectContaining({
        deviceId: device.id,
        status: "shadow_only",
        reasonCode: "SHADOW_MODE_NO_ACTION",
        observation: expect.objectContaining({
          host: "192.0.2.120",
          port: 5555,
        }),
      }),
    ]);
    expect(provider.connectCalls).toHaveLength(callsBefore);
    expect(database.getDeviceEndpoint(endpoint.id)).toEqual(endpointBefore);
    expect(database.getDeviceConnectionState(device.id)).toEqual(stateBefore);
  });

  it("Managed 设备被用户主动断开后，Observation 决策必须阻塞且不能重新连接", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.121:5555", "SERIAL-1"),
      host: "192.0.2.121",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.0.2.121",
      5555,
    );
    registry.setNetworkManagementMode(device.id, "managed");
    await registry.disconnectNetwork(device.id, endpoint.id);
    registry.observeTrackedNetworkTransport({
      serviceInstance: "adb-SERIAL-1-candidate",
      transportType: "tcp_legacy",
      host: "192.0.2.121",
      port: 5555,
    });
    const callsBefore = provider.connectCalls.length;

    expect(registry.listNetworkObservationDecisions()).toEqual([
      expect.objectContaining({
        deviceId: device.id,
        status: "blocked",
        reasonCode: "DESIRED_NETWORK_DISCONNECTED",
      }),
    ]);
    await expect(
      registry.reconcileManagedNetworkObservations(),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "skipped",
        reasonCode: "DESIRED_NETWORK_DISCONNECTED",
      }),
    ]);
    expect(provider.connectCalls).toHaveLength(callsBefore);
  });

  it("显式 Gate 配置必须同时约束直接采用和旧 Endpoint 自愈，空白名单 fail-closed", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.140:5555", "SERIAL-1"),
      host: "192.0.2.140",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.0.2.140",
      5555,
    );
    registry.setNetworkManagementMode(device.id, "managed");
    registry = new DeviceRegistryService(database, [provider], {
      managedObservationAdoptionEnabled: true,
      managedObservationAdoptionDeviceIds: [],
    });
    registry.observeTrackedNetworkTransport({
      serviceInstance: "adb-SERIAL-1-candidate",
      transportType: "tcp_legacy",
      host: "198.51.100.140",
      port: 5555,
    });
    const observation = registry.listNetworkObservations()[0]!;
    provider.probeCalls = [];
    provider.connectCalls = [];

    await expect(
      registry.adoptManagedNetworkObservation(device.id, observation.id),
    ).rejects.toMatchObject({
      code: "NOT_IN_MANAGED_GATE_ALLOWLIST",
    });
    await expect(
      registry.reconcileManagedNetworkObservations(3, []),
    ).resolves.toEqual([
      expect.objectContaining({
        observationId: observation.id,
        status: "skipped",
        reasonCode: "NOT_IN_MANAGED_GATE_ALLOWLIST",
      }),
    ]);
    await expect(
      registry.reconcileManagedNetworkEndpoints(3, []),
    ).resolves.toEqual([]);
    expect(provider.probeCalls).toEqual([]);
    expect(provider.connectCalls).toEqual([]);
    expect(database.getDeviceEndpoint(endpoint.id)).toMatchObject({
      host: "192.0.2.140",
      port: 5555,
    });
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      consecutiveFailures: 0,
    });
  });

  it("关闭 Gate 后 direct-call 采用也必须拒绝且不触发 ADB", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.141:5555", "SERIAL-1"),
      host: "192.0.2.141",
      port: 5555,
    };
    await registry.connectNetwork(device.id, "192.0.2.141", 5555);
    registry.setNetworkManagementMode(device.id, "managed");
    registry = new DeviceRegistryService(database, [provider], {
      managedObservationAdoptionEnabled: false,
      managedObservationAdoptionDeviceIds: [device.id],
    });
    registry.observeTrackedNetworkTransport({
      serviceInstance: "adb-SERIAL-1-candidate",
      transportType: "tcp_legacy",
      host: "198.51.100.141",
      port: 5555,
    });
    const observation = registry.listNetworkObservations()[0]!;
    provider.probeCalls = [];
    provider.connectCalls = [];

    expect(registry.listNetworkObservationDecisions()).toEqual([
      expect.objectContaining({
        deviceId: device.id,
        status: "blocked",
        blockedBy: "gate",
        reasonCode: "MANAGED_OBSERVATION_ADOPTION_DISABLED",
      }),
    ]);
    await expect(
      registry.adoptManagedNetworkObservation(device.id, observation.id),
    ).rejects.toMatchObject({
      code: "MANAGED_OBSERVATION_ADOPTION_DISABLED",
    });
    await expect(
      registry.reconcileManagedNetworkObservations(),
    ).resolves.toEqual([
      expect.objectContaining({
        status: "skipped",
        reasonCode: "MANAGED_OBSERVATION_ADOPTION_DISABLED",
      }),
    ]);
    await expect(registry.reconcileManagedNetworkEndpoints()).resolves.toEqual(
      [],
    );
    expect(provider.probeCalls).toEqual([]);
    expect(provider.connectCalls).toEqual([]);
  });

  it("服务关闭会主动取消恢复、拒绝迟到写入，并停止接受新的连接意图", async () => {
    const device = await register();
    provider.connectResult = {
      ...onlineDevice("192.0.2.70:5555", "SERIAL-1"),
      host: "192.0.2.70",
      port: 5555,
    };
    const endpoint = await registry.connectNetwork(
      device.id,
      "192.0.2.70",
      5555,
    );
    let releaseProbe: (() => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    provider.probeImpl = async (_host, _port, options) => {
      observedSignal = options?.signal;
      await new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      return true;
    };

    const recovery = registry.reconcileNetworkEndpoint(device.id, endpoint.id);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    const shutdown = registry.shutdownConnections();
    await expect(shutdown).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    await expect(recovery).resolves.toMatchObject({
      status: "cancelled",
      failureCode: "SERVICE_SHUTDOWN",
    });
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "offline",
      reasonCode: "SERVICE_SHUTDOWN",
    });

    releaseProbe?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(database.getDeviceConnectionState(device.id)).toMatchObject({
      observedNetworkState: "offline",
      reasonCode: "SERVICE_SHUTDOWN",
    });
    await expect(
      registry.refreshNetwork(device.id, endpoint.id),
    ).rejects.toMatchObject({
      code: "DEVICE_CONNECTION_CONTROLLER_SHUTDOWN",
    });
  });
});
