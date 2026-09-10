import { createHash } from "node:crypto";

import type { PlatformDatabase } from "../database.js";
import type {
  DeviceConnectionKind,
  DeviceConnectionStatus,
  DeviceDiscoveryCandidate,
  DeviceEndpoint,
  DevicePlatform,
  DeviceProfile,
  TaskConnectionMode,
  NetworkConnectionOperationStart,
} from "../types.js";
import type { DeviceDiscoveryProvider } from "./device-provider.js";
import {
  DeviceConnectionController,
  DeviceConnectionControllerShutdownError,
  DeviceConnectionDeadlineExceededError,
} from "./device-connection-controller.js";
import type { DeviceConnectionOperationContext } from "./device-connection-controller.js";
import type { AdbCommandHealthEvidence } from "../execution/adb-client.js";
import type { DeviceConnectionManagementMode } from "../database/stores/device-connection-state-store.js";
import {
  EndpointObservationStore,
  type EndpointObservation,
} from "./endpoint-observation-store.js";
import type { TrackedNetworkTransport } from "./adb-track-devices-watcher.js";
import { resolveDeviceIdentity } from "./identity-resolver.js";
import {
  RestrictedNetworkVerificationError,
  verifyRestrictedNetworkCandidate,
} from "./restricted-network-verifier.js";
import {
  canFallbackToTcp,
  selectNetworkTransport,
} from "./network-transport-resolver.js";

export class DeviceRegistrationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
    readonly evidence?: {
      adbExitCode?: number;
      adbStdout?: string;
      adbStderr?: string;
      adbStdoutTruncated?: boolean;
      adbStderrTruncated?: boolean;
    },
  ) {
    super(message);
    this.name = "DeviceRegistrationError";
  }
}

interface RegisteredRefreshOperation {
  controller: AbortController;
  consumers: Set<symbol>;
  promise: Promise<DeviceProfile[]>;
  settled: boolean;
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("ADB 扫描已取消");
}

function stableDeviceId(serial: string) {
  return `adb-${createHash("sha256").update(serial).digest("hex").slice(0, 16)}`;
}

function endpointMap(endpoints: DeviceEndpoint[]) {
  const selected = new Map<DeviceConnectionKind, DeviceEndpoint>();
  for (const endpoint of endpoints) {
    const current = selected.get(endpoint.kind);
    if (!current) {
      selected.set(endpoint.kind, endpoint);
      continue;
    }
    const rank = (value: DeviceEndpoint) =>
      [
        value.status === "online" ? 0 : 1,
        value.transportType === "wireless_tls" ? 0 : 1,
        -(value.priority ?? 0),
      ] as const;
    const nextRank = rank(endpoint);
    const currentRank = rank(current);
    if (
      nextRank.some(
        (value, index) =>
          value < currentRank[index]! &&
          nextRank.slice(0, index).every((item, i) => item === currentRank[i]),
      )
    ) {
      selected.set(endpoint.kind, endpoint);
    }
  }
  return Object.fromEntries(selected) as Partial<
    Record<DeviceConnectionKind, DeviceEndpoint>
  >;
}

function overallStatus(endpoints: DeviceEndpoint[]): DeviceConnectionStatus {
  if (endpoints.some((endpoint) => endpoint.status === "online"))
    return "online";
  if (endpoints.some((endpoint) => endpoint.status === "unauthorized"))
    return "unauthorized";
  if (endpoints.some((endpoint) => endpoint.status === "offline"))
    return "offline";
  return "unknown";
}

function likelyNetworkSerial(serial: string) {
  return /:\d+$/.test(serial) || /^\[[^\]]+\]:\d+$/.test(serial);
}

function networkSerial(host: string, port: number) {
  const normalizedHost = host.replace(/^\[|\]$/g, "");
  return normalizedHost.includes(":")
    ? `[${normalizedHost}]:${port}`
    : `${normalizedHost}:${port}`;
}

function serviceInstanceContainsSerial(
  serviceInstance: string,
  serial?: string,
) {
  const normalized = serial?.trim().toLowerCase();
  if (!normalized) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(
    serviceInstance,
  );
}

function resolverFailureCodeForTransport(
  transportType: "tcp_legacy" | "wireless_tls",
  failureCode: string,
) {
  if (transportType !== "wireless_tls") return failureCode;
  if (
    [
      "ADB_PORT_UNREACHABLE",
      "ADB_PORT_REFUSED",
      "ADB_NETWORK_UNREACHABLE",
      "TCP_PORT_CLOSED",
      "TCP_PROBE_FAILED",
    ].includes(failureCode)
  ) {
    return "WIRELESS_TLS_UNREACHABLE";
  }
  if (failureCode === "ADB_CONNECT_TIMEOUT") {
    return "WIRELESS_TLS_CONNECT_TIMEOUT";
  }
  if (failureCode === "ADB_UNAUTHORIZED") {
    return "WIRELESS_PAIRING_REQUIRED";
  }
  return failureCode;
}

function unavailableReason(device: DeviceProfile, endpoints: DeviceEndpoint[]) {
  if (device.platform !== "android" || device.executionMode !== "adb")
    return "设备不是 Android ADB 真机";
  if (!device.eligible) return "设备当前不可调度";
  if (endpoints.some((endpoint) => endpoint.status === "online"))
    return undefined;
  if (
    endpoints.some(
      (endpoint) =>
        endpoint.kind === "usb" && endpoint.status === "unauthorized",
    )
  )
    return "USB 调试未授权，且没有可用的联网连接";
  if (endpoints.length === 0) return "USB 和联网 Endpoint 均未配置";
  return "USB 和联网连接均不可用";
}

/**
 * Device Registry is the deep device-domain module. Routes and task creation use
 * this small interface instead of understanding ADB commands, endpoint identity,
 * persistence, or connection selection rules.
 */
export class DeviceRegistryService {
  private readonly providers = new Map<
    DevicePlatform,
    DeviceDiscoveryProvider
  >();
  private readonly registeredRefreshes = new Map<
    DevicePlatform,
    RegisteredRefreshOperation
  >();
  private readonly networkOperationControllers = new Map<
    string,
    AbortController
  >();
  private readonly networkEndpointLocks = new Set<string>();
  private readonly connectionController: DeviceConnectionController;
  private readonly endpointObservations: EndpointObservationStore;
  private readonly attemptedManagedObservationIds = new Set<string>();
  private shadowObservationRefresh?: Promise<EndpointObservation[]>;
  private shadowObservationController?: AbortController;
  private readonly nowMs: () => number;
  private readonly random: () => number;
  private readonly managedObservationAdoptionEnabled?: boolean;
  private readonly managedObservationAdoptionDeviceIds?: ReadonlySet<string>;

  constructor(
    private readonly database: PlatformDatabase,
    providers: DeviceDiscoveryProvider[],
    options: {
      connectionOperationDeadlineMs?: number;
      now?: () => number;
      random?: () => number;
      managedObservationAdoptionEnabled?: boolean;
      managedObservationAdoptionDeviceIds?: string[];
    } = {},
  ) {
    for (const provider of providers)
      this.providers.set(provider.platform, provider);
    this.connectionController = new DeviceConnectionController(
      database,
      options.connectionOperationDeadlineMs,
    );
    this.nowMs = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.managedObservationAdoptionEnabled =
      options.managedObservationAdoptionEnabled;
    this.managedObservationAdoptionDeviceIds =
      options.managedObservationAdoptionDeviceIds === undefined
        ? undefined
        : new Set(options.managedObservationAdoptionDeviceIds);
    this.endpointObservations = new EndpointObservationStore({
      now: this.nowMs,
    });
  }

  private getManagedObservationGateReason(
    deviceId: string,
    allowedDeviceIds?: ReadonlySet<string>,
  ):
    | "MANAGED_OBSERVATION_ADOPTION_DISABLED"
    | "NOT_IN_MANAGED_GATE_ALLOWLIST"
    | undefined {
    // `undefined` keeps direct-call/unit-test compatibility. Once the runtime
    // supplies an explicit Gate config, an empty allowlist is intentionally
    // fail-closed rather than meaning "all devices".
    if (this.managedObservationAdoptionEnabled === false) {
      return "MANAGED_OBSERVATION_ADOPTION_DISABLED";
    }
    if (
      this.managedObservationAdoptionEnabled === true &&
      !this.managedObservationAdoptionDeviceIds?.has(deviceId)
    ) {
      return "NOT_IN_MANAGED_GATE_ALLOWLIST";
    }
    if (allowedDeviceIds !== undefined && !allowedDeviceIds.has(deviceId)) {
      return "NOT_IN_MANAGED_GATE_ALLOWLIST";
    }
    return undefined;
  }

  private provider(platform: DevicePlatform) {
    const provider = this.providers.get(platform);
    if (!provider)
      throw new DeviceRegistrationError(
        `${platform} 设备发现尚未实现`,
        "PLATFORM_NOT_AVAILABLE",
        409,
      );
    return provider;
  }

  /** USB discovery intentionally excludes already connected network ADB serials. */
  async discover(platform: DevicePlatform = "android") {
    const candidates = await this.provider(platform).discover();
    return candidates.flatMap((candidate) => {
      const endpoint = this.database.getDeviceEndpointBySerial(
        candidate.serial,
      );
      const kind =
        endpoint?.kind ??
        candidate.kind ??
        (likelyNetworkSerial(candidate.serial) ? "network" : "usb");
      if (kind !== "usb") return [];
      return [
        {
          ...candidate,
          kind: "usb" as const,
          registeredDeviceId:
            endpoint?.deviceId ??
            this.database.getDeviceBySerial(candidate.serial)?.id,
        },
      ];
    });
  }

  async discoverNetwork(platform: DevicePlatform = "android") {
    const provider = this.provider(platform);
    if (!provider.discoverNetwork) return [];
    const candidates = await this.discoverNetworkCandidates(provider);
    const devices = this.database.listDevices();
    return candidates.map((candidate) => {
      const registeredDeviceId =
        candidate.host && candidate.port
          ? devices.find((device) =>
              this.database
                .listDeviceEndpoints(device.id)
                .some(
                  (endpoint) =>
                    endpoint.kind === "network" &&
                    endpoint.host === candidate.host &&
                    endpoint.port === candidate.port,
                ),
            )?.id
          : this.database.getDeviceEndpointBySerial(candidate.serial)?.deviceId;
      return { ...candidate, kind: "network" as const, registeredDeviceId };
    });
  }

  listNetworkObservations() {
    return this.endpointObservations.listActive();
  }

  /** Pure read model for UI/audit. It never probes, connects, or persists. */
  listNetworkObservationDecisions() {
    const candidates = this.database
      .listDeviceConnectionStates()
      .flatMap((state) => {
        if (
          state.managementMode !== "shadow" &&
          state.managementMode !== "managed"
        )
          return [];
        const device = this.database.getDevice(state.deviceId);
        return device ? [{ device, state }] : [];
      });
    return this.endpointObservations.listActive().map((observation) => {
      const exactEndpoint = this.findNetworkEndpoint(
        observation.host,
        observation.port,
        networkSerial(observation.host, observation.port),
      );
      const exactTarget = exactEndpoint
        ? candidates.find(({ device }) => device.id === exactEndpoint.deviceId)
        : undefined;
      const serviceTargets = candidates.filter(({ device }) =>
        serviceInstanceContainsSerial(
          observation.serviceInstance,
          device.serial,
        ),
      );
      // A lone registered device is not identity evidence. Keep the Shadow
      // read model aligned with the execution path: only an existing endpoint
      // owner or an unambiguous service-instance match may identify a device.
      const target =
        exactTarget ??
        (serviceTargets.length === 1 ? serviceTargets[0] : undefined);
      if (!target) {
        return {
          observation,
          status: "ambiguous" as const,
          reasonCode: "OBSERVATION_IDENTITY_AMBIGUOUS",
        };
      }
      const endpoint = this.database.getDeviceEndpointByKind(
        target.device.id,
        "network",
      );
      const base = {
        observation,
        deviceId: target.device.id,
        deviceName: target.device.name,
        managementMode: target.state.managementMode,
        ...(endpoint?.id ? { endpointId: endpoint.id } : {}),
        ...(endpoint?.lastVerifiedAt
          ? { lastVerificationAt: endpoint.lastVerifiedAt }
          : {}),
      };
      if (target.state.managementMode === "shadow") {
        return {
          ...base,
          status: "shadow_only" as const,
          reasonCode: "SHADOW_MODE_NO_ACTION",
        };
      }
      if (target.state.desiredNetworkState !== "connected") {
        return {
          ...base,
          status: "blocked" as const,
          reasonCode: "DESIRED_NETWORK_DISCONNECTED",
          blockedBy: "device" as const,
        };
      }
      const gateReason = this.getManagedObservationGateReason(target.device.id);
      if (gateReason) {
        return {
          ...base,
          status:
            gateReason === "NOT_IN_MANAGED_GATE_ALLOWLIST"
              ? ("not_in_gate" as const)
              : ("blocked" as const),
          reasonCode: gateReason,
          blockedBy: "gate" as const,
        };
      }
      if (target.state.observedNetworkState === "manual_action") {
        return {
          ...base,
          status: "blocked" as const,
          reasonCode: "MANUAL_ACTION_REQUIRED",
          blockedBy: "manual_action" as const,
        };
      }
      if (this.database.getDeviceQueueStatus(target.device.id) !== "idle") {
        return {
          ...base,
          status: "blocked" as const,
          reasonCode: "DEVICE_BUSY",
          blockedBy: "device" as const,
        };
      }
      if (this.attemptedManagedObservationIds.has(observation.id)) {
        return {
          ...base,
          status: "already_attempted" as const,
          reasonCode: "OBSERVATION_ALREADY_ATTEMPTED",
        };
      }
      return { ...base, status: "ready" as const };
    });
  }

  /**
   * Managed-mode two-phase adoption seam. Discovery only supplies an ephemeral
   * Observation; the formal Endpoint is replaced only after restricted ADB
   * verification and the final fenced/idle checks all still hold.
   */
  async adoptManagedNetworkObservation(
    deviceId: string,
    observationId: string,
  ) {
    const device = this.database.getDevice(deviceId);
    if (!device)
      throw new DeviceRegistrationError(
        "物理设备不存在",
        "DEVICE_NOT_FOUND",
        404,
      );
    const state = this.database.getDeviceConnectionState(deviceId);
    if (
      state?.managementMode !== "managed" ||
      state.desiredNetworkState !== "connected"
    ) {
      throw new DeviceRegistrationError(
        "只有期望联网的 Managed 设备可以自动采用候选 Endpoint",
        "MANAGED_NETWORK_ADOPTION_NOT_ALLOWED",
        409,
      );
    }
    const gateReason = this.getManagedObservationGateReason(deviceId);
    if (gateReason) {
      throw new DeviceRegistrationError(
        gateReason === "MANAGED_OBSERVATION_ADOPTION_DISABLED"
          ? "Managed 自动化 Gate 当前已关闭"
          : "设备不在当前 Managed Gate 白名单内",
        gateReason,
        409,
      );
    }
    if (state.observedNetworkState === "manual_action") {
      throw new DeviceRegistrationError(
        "设备需要人工处理，已停止自动验证候选 Endpoint",
        "MANUAL_ACTION_REQUIRED",
        409,
      );
    }
    if (this.database.getDeviceQueueStatus(deviceId) !== "idle") {
      throw new DeviceRegistrationError(
        "设备正在执行或排队，不能替换联网 Endpoint",
        "DEVICE_BUSY",
        409,
      );
    }
    const observation = this.endpointObservations
      .listActive()
      .find((item) => item.id === observationId);
    if (!observation) {
      throw new DeviceRegistrationError(
        "候选 Endpoint Observation 不存在或已过期",
        "NETWORK_ENDPOINT_EXPIRED",
        409,
      );
    }
    const serial = networkSerial(observation.host, observation.port);
    const owner = this.findNetworkEndpoint(
      observation.host,
      observation.port,
      serial,
    );
    if (owner && owner.deviceId !== deviceId) {
      throw new DeviceRegistrationError(
        "候选联网 Endpoint 已属于另一台物理设备",
        "NETWORK_ENDPOINT_ALREADY_BOUND",
        409,
      );
    }
    const provider = this.provider("android");
    if (!provider.probeNetwork || !provider.connectNetwork) {
      throw new DeviceRegistrationError(
        "当前 Android Provider 不支持受限联网验证",
        "NETWORK_ADB_NOT_AVAILABLE",
        409,
      );
    }

    try {
      return await this.connectionController.run(
        deviceId,
        `adopt-observation:${observation.id}`,
        async (context) => {
          try {
            const verified = await verifyRestrictedNetworkCandidate({
              device,
              observation,
              provider: {
                probeNetwork: provider.probeNetwork!.bind(provider),
                connectNetwork: provider.connectNetwork!.bind(provider),
              },
              isObservationActive: () =>
                this.endpointObservations.isActive(observation.id),
              findOwner: (hardwareSerial) =>
                this.database.getDeviceBySerial(hardwareSerial),
              signal: context.signal,
            });

            // No await is allowed between these final checks and the synchronous
            // SQLite transaction, so task creation cannot interleave in this process.
            const currentState =
              this.database.getDeviceConnectionState(deviceId);
            if (
              currentState?.managementMode !== "managed" ||
              currentState.desiredNetworkState !== "connected" ||
              this.database.getDeviceQueueStatus(deviceId) !== "idle"
            ) {
              throw new DeviceRegistrationError(
                "验证期间设备状态已变化，拒绝激活候选 Endpoint",
                currentState?.managementMode === "managed"
                  ? "DEVICE_BUSY"
                  : "MANAGED_NETWORK_ADOPTION_NOT_ALLOWED",
                409,
              );
            }
            if (
              !context.isCurrent() ||
              !this.endpointObservations.isActive(observation.id)
            ) {
              throw new DeviceRegistrationError(
                "候选 Endpoint 验证结果已过期",
                "NETWORK_CONNECTION_STALE_RESULT",
                409,
              );
            }
            const currentOwner = this.findNetworkEndpoint(
              observation.host,
              observation.port,
              verified.candidate.serial,
            );
            if (currentOwner && currentOwner.deviceId !== deviceId) {
              throw new DeviceRegistrationError(
                "候选联网 Endpoint 在验证期间已属于另一台设备",
                "NETWORK_ENDPOINT_ALREADY_BOUND",
                409,
              );
            }

            const endpoint = this.database.activateVerifiedNetworkEndpoint({
              deviceId,
              operationId: context.operationId,
              generation: context.generation,
              endpoint: {
                deviceId,
                kind: "network",
                transportType: observation.transportType,
                adbSerial: verified.candidate.serial,
                host: observation.host,
                port: observation.port,
                serviceInstance: observation.serviceInstance,
                pairingState:
                  observation.transportType === "wireless_tls"
                    ? "observed_working"
                    : "unknown",
                priority:
                  observation.transportType === "wireless_tls" ? 100 : 50,
                lastVerifiedAt: new Date().toISOString(),
                lastObservationAt: observation.observedAt,
                observationExpiresAt: observation.expiresAt,
                observationSource: observation.source,
                status: "online",
              },
              profile: {
                name: verified.candidate.name,
                manufacturer: verified.candidate.manufacturer,
                model: verified.candidate.model,
                osVersion: verified.candidate.androidVersion
                  ? `Android ${verified.candidate.androidVersion}`
                  : undefined,
                apiLevel: verified.candidate.apiLevel,
                architecture: verified.candidate.architecture,
                buildVersion: verified.candidate.buildVersion,
                securityPatch: verified.candidate.securityPatch,
              },
              event: {
                eventType: "endpoint_activated",
                source: "managed_discovery",
                transportType: observation.transportType,
                endpointSummary: {
                  host: observation.host,
                  port: observation.port,
                  transportType: observation.transportType,
                  serviceInstance: observation.serviceInstance,
                },
                result: "succeeded",
              },
            });
            if (!endpoint) {
              throw new DeviceRegistrationError(
                "候选 Endpoint 验证结果已过期，原子激活被拒绝",
                "NETWORK_CONNECTION_STALE_RESULT",
                409,
              );
            }
            return endpoint;
          } catch (error) {
            const failureCode =
              error instanceof RestrictedNetworkVerificationError ||
              error instanceof DeviceRegistrationError
                ? error.code
                : "NETWORK_ENDPOINT_VERIFICATION_FAILED";
            if (context.isCurrent()) {
              const restored = context.commit({
                observedState: state.observedNetworkState,
                activeEndpointId: state.activeEndpointId,
                reasonCode: state.reasonCode,
              });
              if (restored) {
                context.record({
                  eventType: "endpoint_verification_failed",
                  transportType: observation.transportType,
                  endpointSummary: {
                    host: observation.host,
                    port: observation.port,
                    transportType: observation.transportType,
                    serviceInstance: observation.serviceInstance,
                  },
                  result: "failed",
                  failureCode,
                });
              }
            }
            throw error;
          }
        },
        {
          source: "managed_discovery",
          restoreStateOnAbort: {
            observedState: state.observedNetworkState,
            desiredState: state.desiredNetworkState,
            activeEndpointId: state.activeEndpointId,
            reasonCode: state.reasonCode,
          },
        },
      );
    } catch (error) {
      if (error instanceof RestrictedNetworkVerificationError) {
        throw new DeviceRegistrationError(
          error.message,
          error.code,
          409,
          error.evidence,
        );
      }
      if (error instanceof DeviceConnectionDeadlineExceededError) {
        throw new DeviceRegistrationError(error.message, error.code, 409);
      }
      if (error instanceof DeviceConnectionControllerShutdownError) {
        throw new DeviceRegistrationError(error.message, error.code, 503);
      }
      throw error;
    }
  }

  /**
   * Reconciles active discoveries without guessing across multiple Physical
   * Devices. This remains an explicit seam until the managed scheduler Gate is
   * complete; merely observing an Endpoint never calls this method.
   */
  async reconcileManagedNetworkObservations(
    maxParallel = 3,
    allowedDeviceIds?: string[],
  ) {
    // `undefined` is the legacy/direct-call mode; an explicitly supplied empty
    // allowlist is fail-closed and must not be treated as unrestricted.
    const allowed =
      allowedDeviceIds === undefined ? undefined : new Set(allowedDeviceIds);
    const observations = this.endpointObservations.listActive();
    const activeIds = new Set(
      observations.map((observation) => observation.id),
    );
    for (const attemptedId of this.attemptedManagedObservationIds) {
      if (!activeIds.has(attemptedId))
        this.attemptedManagedObservationIds.delete(attemptedId);
    }
    if (this.managedObservationAdoptionEnabled === false) {
      return observations.map((observation) => ({
        observationId: observation.id,
        status: "skipped" as const,
        reasonCode: "MANAGED_OBSERVATION_ADOPTION_DISABLED",
      }));
    }
    if (
      allowed?.size === 0 ||
      (this.managedObservationAdoptionEnabled === true &&
        this.managedObservationAdoptionDeviceIds?.size === 0)
    ) {
      return observations.map((observation) => ({
        observationId: observation.id,
        status: "skipped" as const,
        reasonCode: "NOT_IN_MANAGED_GATE_ALLOWLIST",
      }));
    }
    const allManagedDevices = this.database
      .listDeviceConnectionStates()
      .flatMap((state) => {
        if (state.managementMode !== "managed") return [];
        const device = this.database.getDevice(state.deviceId);
        return device ? [{ device, state }] : [];
      });
    const managedDevices = allManagedDevices.filter(
      ({ device }) => !this.getManagedObservationGateReason(device.id, allowed),
    );

    type ReconciliationResult = {
      observationId: string;
      deviceId?: string;
      status: "adopted" | "skipped" | "failed";
      reasonCode?: string;
    };
    const reconcileOne = async (
      observation: EndpointObservation,
    ): Promise<ReconciliationResult> => {
      const exactEndpoint = this.findNetworkEndpoint(
        observation.host,
        observation.port,
        networkSerial(observation.host, observation.port),
      );
      const exactTarget = exactEndpoint
        ? managedDevices.find(
            ({ device }) => device.id === exactEndpoint.deviceId,
          )
        : undefined;
      const serviceName = observation.serviceInstance.toLowerCase();
      const serviceTargets = managedDevices.filter(({ device }) =>
        serviceInstanceContainsSerial(serviceName, device.serial),
      );
      // A single managed device is not identity evidence. Only an existing
      // endpoint owner or an unambiguous service-instance match may authorize
      // probe/connect and endpoint adoption.
      const target =
        exactTarget ??
        (serviceTargets.length === 1 ? serviceTargets[0] : undefined);
      const outsideAllowlistTarget =
        allowed === undefined
          ? undefined
          : (() => {
              const exactOutside = exactEndpoint
                ? allManagedDevices.find(
                    ({ device }) => device.id === exactEndpoint.deviceId,
                  )
                : undefined;
              const serviceOutside = allManagedDevices.filter(({ device }) =>
                serviceInstanceContainsSerial(serviceName, device.serial),
              );
              return (
                exactOutside ??
                (serviceOutside.length === 1 ? serviceOutside[0] : undefined)
              );
            })();

      if (!target && outsideAllowlistTarget) {
        return {
          observationId: observation.id,
          deviceId: outsideAllowlistTarget.device.id,
          status: "skipped",
          reasonCode: "NOT_IN_MANAGED_GATE_ALLOWLIST",
        };
      }
      if (!target) {
        return {
          observationId: observation.id,
          status: "skipped",
          reasonCode: "OBSERVATION_IDENTITY_AMBIGUOUS",
        };
      }
      if (target.state.desiredNetworkState !== "connected") {
        return {
          observationId: observation.id,
          deviceId: target.device.id,
          status: "skipped",
          reasonCode: "DESIRED_NETWORK_DISCONNECTED",
        };
      }
      if (target.state.observedNetworkState === "manual_action") {
        return {
          observationId: observation.id,
          deviceId: target.device.id,
          status: "skipped",
          reasonCode: "MANUAL_ACTION_REQUIRED",
        };
      }
      if (this.database.getDeviceQueueStatus(target.device.id) !== "idle") {
        return {
          observationId: observation.id,
          deviceId: target.device.id,
          status: "skipped",
          reasonCode: "DEVICE_BUSY",
        };
      }
      const activeEndpoint = this.database.getDeviceEndpointByKind(
        target.device.id,
        "network",
      );
      const activeTransportRank =
        activeEndpoint?.transportType === "wireless_tls"
          ? 2
          : activeEndpoint?.transportType === "tcp_legacy"
            ? 1
            : 0;
      const observationTransportRank =
        observation.transportType === "wireless_tls" ? 2 : 1;
      // The scheduler refreshes mDNS frequently. Re-observing the already
      // active endpoint must be a no-op; otherwise every refresh fences the
      // running task's generation and produces STALE_DEVICE_LEASE.
      if (
        activeEndpoint?.status === "online" &&
        activeTransportRank >= observationTransportRank &&
        (observation.transportType === "wireless_tls"
          ? activeEndpoint.transportType === "wireless_tls" &&
            activeEndpoint.host === observation.host &&
            activeEndpoint.port === observation.port
          : activeEndpoint.transportType === "wireless_tls" ||
            (activeEndpoint.host === observation.host &&
              activeEndpoint.port === observation.port))
      ) {
        return {
          observationId: observation.id,
          deviceId: target.device.id,
          status: "skipped",
          reasonCode: "ENDPOINT_ALREADY_ACTIVE",
        };
      }
      if (this.attemptedManagedObservationIds.has(observation.id)) {
        return {
          observationId: observation.id,
          deviceId: target.device.id,
          status: "skipped",
          reasonCode: "OBSERVATION_ALREADY_ATTEMPTED",
        };
      }

      this.attemptedManagedObservationIds.add(observation.id);
      try {
        await this.adoptManagedNetworkObservation(
          target.device.id,
          observation.id,
        );
        return {
          observationId: observation.id,
          deviceId: target.device.id,
          status: "adopted",
        };
      } catch (error) {
        return {
          observationId: observation.id,
          deviceId: target.device.id,
          status: "failed",
          reasonCode:
            error instanceof DeviceRegistrationError
              ? error.code
              : "NETWORK_ENDPOINT_VERIFICATION_FAILED",
        };
      }
    };
    const results: ReconciliationResult[] = new Array(observations.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < observations.length) {
        const index = cursor++;
        const observation = observations[index];
        if (!observation) return;
        results[index] = await reconcileOne(observation);
      }
    };
    const workerCount = Math.min(
      Math.max(1, maxParallel),
      3,
      observations.length,
    );
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  isShadowDiscoveryEnabled() {
    return this.database
      .listDeviceConnectionStates()
      .some(
        (state) =>
          state.managementMode === "shadow" ||
          state.managementMode === "managed",
      );
  }

  observeTrackedNetworkTransport(transport: TrackedNetworkTransport) {
    if (!this.isShadowDiscoveryEnabled()) return false;
    // adb track-devices reports host:port but not the mDNS service type. A
    // non-5555 port is therefore not sufficient evidence of Wireless TLS.
    // mDNS discovery is the authoritative source for TLS transport identity.
    const transportType = transport.transportType;
    if (transportType === "unknown") return false;
    const observed = this.endpointObservations.observe({
      source: "adb_track",
      serviceInstance: transport.serviceInstance,
      transportType,
      host: transport.host,
      port: transport.port,
    });
    this.syncObservedEndpoint(observed.observation);
    if (observed.created) {
      this.recordObservationEvent(
        observed.observation,
        "endpoint_observation_discovered",
        "observed",
      );
    }
    return observed.created;
  }

  refreshShadowNetworkObservations(): Promise<EndpointObservation[]> {
    if (!this.isShadowDiscoveryEnabled())
      return Promise.resolve(this.listNetworkObservations());
    if (this.shadowObservationRefresh) return this.shadowObservationRefresh;
    const refresh = this.performShadowNetworkObservationRefresh();
    this.shadowObservationRefresh = refresh;
    const clear = () => {
      if (this.shadowObservationRefresh === refresh)
        this.shadowObservationRefresh = undefined;
    };
    void refresh.then(clear, clear);
    return refresh;
  }

  private async performShadowNetworkObservationRefresh() {
    const provider = this.provider("android");
    if (!provider.discoverNetwork) return this.listNetworkObservations();
    const controller = new AbortController();
    this.shadowObservationController = controller;
    let candidates: DeviceDiscoveryCandidate[];
    try {
      candidates = await this.discoverNetworkCandidates(
        provider,
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) return this.listNetworkObservations();
      throw error;
    } finally {
      if (this.shadowObservationController === controller)
        this.shadowObservationController = undefined;
    }

    // Only expire the previous discovery buffer after a successful query. An
    // mDNS command failure is not evidence that the phone stopped publishing
    // its service, so keep the latest Observation for the next refresh/retry.
    for (const observation of this.endpointObservations.expire()) {
      this.recordObservationEvent(
        observation,
        "endpoint_observation_expired",
        "expired",
      );
    }

    for (const candidate of candidates) {
      if (!candidate.host || !candidate.port) continue;
      const result = this.endpointObservations.observe({
        source: "mdns",
        serviceInstance: candidate.serviceInstance ?? candidate.serial,
        transportType: candidate.networkTransport ?? "wireless_tls",
        host: candidate.host,
        port: candidate.port,
      });
      this.syncObservedEndpoint(result.observation);
      if (result.created) {
        this.recordObservationEvent(
          result.observation,
          "endpoint_observation_discovered",
          "observed",
        );
      }
    }
    return this.listNetworkObservations();
  }

  private async discoverNetworkCandidates(
    provider: DeviceDiscoveryProvider,
    signal?: AbortSignal,
  ) {
    if (!provider.discoverNetwork) return [];
    try {
      return await provider.discoverNetwork({ signal });
    } catch (error) {
      throw new DeviceRegistrationError(
        `联网 ADB mDNS 发现失败：${error instanceof Error ? error.message : String(error)}`,
        "ADB_MDNS_DISCOVERY_FAILED",
        503,
      );
    }
  }

  private syncObservedEndpoint(observation: EndpointObservation) {
    // Refresh only an existing formal Endpoint with the same transport and
    // address. Observation data never creates or rebinds a Physical Device.
    for (const device of this.database.listDevices()) {
      const endpoint = this.database
        .listDeviceEndpoints(device.id)
        .find(
          (candidate) =>
            candidate.kind === "network" &&
            (candidate.transportType ?? "tcp_legacy") ===
              observation.transportType &&
            candidate.host === observation.host &&
            candidate.port === observation.port,
        );
      if (endpoint) {
        this.database.updateDeviceEndpointObservation(endpoint.id, {
          observedAt: observation.observedAt,
          expiresAt: observation.expiresAt,
          source: observation.source,
        });
        return endpoint;
      }
    }
    return undefined;
  }

  private recordObservationEvent(
    observation: EndpointObservation,
    eventType:
      "endpoint_observation_discovered" | "endpoint_observation_expired",
    result: "observed" | "expired",
  ) {
    // An Observation is intentionally allowed to exist before it is bound to a
    // formal Endpoint.  Do not drop the discovery evidence in that case: the
    // event is the only durable record of a candidate that was rejected,
    // ambiguous, or still awaiting verification.  Use the exact endpoint
    // owner when one exists; otherwise resolve an unambiguous Physical Device
    // from the service instance or an existing endpoint identity.
    const exactEndpoint = this.findNetworkEndpoint(
      observation.host,
      observation.port,
      networkSerial(observation.host, observation.port),
    );
    const managedDevices = this.database
      .listDeviceConnectionStates()
      .filter(
        (state) =>
          state.managementMode === "shadow" ||
          state.managementMode === "managed",
      )
      .map((state) => ({
        state,
        device: this.database.getDevice(state.deviceId),
      }))
      .filter(
        (item): item is {
          state: NonNullable<typeof item.state>;
          device: DeviceProfile;
        } => Boolean(item.device),
      );
    const serviceTargets = managedDevices.filter(({ device }) =>
      serviceInstanceContainsSerial(observation.serviceInstance, device.serial),
    );
    const target =
      exactEndpoint
        ? managedDevices.find(({ device }) => device.id === exactEndpoint.deviceId)
        : serviceTargets.length === 1
          ? serviceTargets[0]
          : undefined;
    if (!target) return;
    this.database.appendConnectionEvent({
      deviceId: target.device.id,
      generation: target.state.connectionGeneration,
      eventType,
      source:
        observation.source === "mdns" ? "shadow_mdns" : "shadow_adb_track",
      transportType: observation.transportType,
      endpointSummary: {
        host: observation.host,
        port: observation.port,
        transportType: observation.transportType,
        serviceInstance: observation.serviceInstance,
      },
      result,
    });
  }

  /** Read the persisted device/Endpoint/queue snapshot without performing discovery or writes. */
  async listRegisteredSnapshot(
    platform: DevicePlatform = "android",
  ): Promise<DeviceProfile[]> {
    return this.buildRegisteredSnapshot(platform);
  }

  /**
   * Refresh registered devices from the platform provider. Concurrent full refreshes
   * for the same platform share one scan instead of queueing duplicate ADB work.
   */
  refreshRegistered(
    platform: DevicePlatform = "android",
    options: { signal?: AbortSignal } = {},
  ): Promise<DeviceProfile[]> {
    if (options.signal?.aborted)
      return Promise.reject(abortReason(options.signal));

    let operation = this.registeredRefreshes.get(platform);
    if (!operation) {
      const controller = new AbortController();
      operation = {
        controller,
        consumers: new Set(),
        promise: Promise.resolve([]),
        settled: false,
      };
      operation.promise = this.performRegisteredRefresh(
        platform,
        controller.signal,
      );
      this.registeredRefreshes.set(platform, operation);
      const activeOperation = operation;
      const clear = () => {
        activeOperation.settled = true;
        if (this.registeredRefreshes.get(platform) === activeOperation) {
          this.registeredRefreshes.delete(platform);
        }
      };
      void operation.promise.then(clear, clear);
    }

    return this.waitForRegisteredRefresh(operation, options.signal);
  }

  private waitForRegisteredRefresh(
    operation: RegisteredRefreshOperation,
    signal?: AbortSignal,
  ): Promise<DeviceProfile[]> {
    const consumer = Symbol("registered-refresh-consumer");
    operation.consumers.add(consumer);

    return new Promise<DeviceProfile[]>((resolve, reject) => {
      let completed = false;
      const release = (reason?: unknown) => {
        if (completed) return;
        completed = true;
        signal?.removeEventListener("abort", onAbort);
        operation.consumers.delete(consumer);
        if (!operation.settled && operation.consumers.size === 0) {
          operation.controller.abort(reason);
        }
      };
      const onAbort = () => {
        const reason = signal
          ? abortReason(signal)
          : new Error("ADB 扫描已取消");
        release(reason);
        reject(reason);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      void operation.promise.then(
        (profiles) => {
          if (completed) return;
          release();
          resolve(profiles);
        },
        (error) => {
          if (completed) return;
          release(error);
          reject(error);
        },
      );
    });
  }

  private buildRegisteredSnapshot(platform: DevicePlatform): DeviceProfile[] {
    return this.database
      .listDevices()
      .filter((device) => device.platform === platform)
      .map((device) => {
        const endpoints = this.database.listDeviceEndpoints(device.id);
        const status = overallStatus(endpoints);
        const reason = unavailableReason(device, endpoints);
        const connectionState = this.database.getDeviceConnectionState(
          device.id,
        );
        return {
          ...device,
          endpoints: endpointMap(endpoints),
          connectionStatus: status,
          overallConnectionStatus: status,
          selectable: !reason,
          unavailableReason: reason,
          queueStatus: this.database.getDeviceQueueStatus(device.id),
          networkConnection: connectionState
            ? {
                managementMode: connectionState.managementMode,
                desiredNetworkState: connectionState.desiredNetworkState,
                observedNetworkState: connectionState.observedNetworkState,
                consecutiveFailures: connectionState.consecutiveFailures,
                retryCount: connectionState.retryCount,
                nextRetryAt: connectionState.nextRetryAt,
                reasonCode: connectionState.reasonCode,
                actionRequired: connectionState.actionRequired,
              }
            : undefined,
        };
      });
  }

  private async performRegisteredRefresh(
    platform: DevicePlatform,
    signal: AbortSignal,
  ): Promise<DeviceProfile[]> {
    const devices = this.database
      .listDevices()
      .filter((device) => device.platform === platform);
    const discovered = await this.provider(platform).discover({ signal });
    if (signal.aborted) throw abortReason(signal);
    const liveBySerial = new Map(
      discovered.map((candidate) => [candidate.serial, candidate]),
    );
    const preserveNetworkEndpoints =
      this.database.hasActiveNetworkConnectionOperation();

    for (const device of devices) {
      const storedEndpoints = this.database.listDeviceEndpoints(device.id);
      const verifiedLiveByEndpointId = new Map<
        string,
        DeviceDiscoveryCandidate
      >();
      const endpoints = storedEndpoints.map((endpoint) => {
        // A batch network operation is the current writer of network state. USB
        // refresh must remain available without overwriting an in-flight network Endpoint.
        if (preserveNetworkEndpoints && endpoint.kind === "network")
          return endpoint;

        const live = liveBySerial.get(endpoint.adbSerial);
        if (
          live?.connectionStatus === "online" &&
          endpoint.kind === "network"
        ) {
          const identityError = this.networkIdentityError(device, live);
          if (identityError) {
            return (
              this.database.updateDeviceEndpointStatus(
                endpoint.id,
                "unknown",
                identityError,
              ) ?? endpoint
            );
          }
        }
        if (live) verifiedLiveByEndpointId.set(endpoint.id, live);
        const nextStatus = live?.connectionStatus ?? "offline";
        return (
          this.database.updateDeviceEndpointStatus(endpoint.id, nextStatus) ??
          endpoint
        );
      });

      const liveCandidates = endpoints
        .map((endpoint) => ({
          endpoint,
          candidate: verifiedLiveByEndpointId.get(endpoint.id),
        }))
        .filter(
          (
            entry,
          ): entry is {
            endpoint: DeviceEndpoint;
            candidate: DeviceDiscoveryCandidate;
          } => Boolean(entry.candidate),
        );
      const preferred =
        liveCandidates.find(
          (entry) =>
            entry.endpoint.kind === "usb" &&
            entry.candidate.connectionStatus === "online",
        ) ??
        liveCandidates.find(
          (entry) => entry.candidate.connectionStatus === "online",
        ) ??
        liveCandidates.find((entry) => entry.endpoint.kind === "usb") ??
        liveCandidates[0];
      const live = preferred?.candidate;

      if (endpoints.some((endpoint) => endpoint.status === "online"))
        this.database.markDeviceSeen(device.id);
      if (live?.connectionStatus === "online")
        this.updateDeviceFromCandidate(device.id, live);
    }

    return this.listRegisteredSnapshot(platform);
  }

  async register(serial: string, platform: DevicePlatform = "android") {
    if (!serial.trim())
      throw new DeviceRegistrationError(
        "ADB Serial 不能为空",
        "INVALID_DEVICE_SERIAL",
      );
    const candidate = (await this.discover(platform)).find(
      (item) => item.serial === serial,
    );
    if (!candidate)
      throw new DeviceRegistrationError(
        "设备当前未连接",
        "DEVICE_OFFLINE",
        409,
      );
    if (candidate.connectionStatus === "unauthorized") {
      throw new DeviceRegistrationError(
        "请在手机上确认 USB 调试授权后重新扫描",
        "DEVICE_UNAUTHORIZED",
        409,
      );
    }
    if (candidate.connectionStatus !== "online") {
      throw new DeviceRegistrationError(
        "设备当前不可录入，请检查 ADB 连接",
        "DEVICE_OFFLINE",
        409,
      );
    }

    const existing = this.database.getDeviceBySerial(serial);
    return this.database.upsertAdbDevice({
      id: existing?.id ?? stableDeviceId(serial),
      serial,
      name: candidate.name ?? candidate.model ?? serial,
      manufacturer: candidate.manufacturer ?? "Android",
      model: candidate.model,
      osVersion: candidate.androidVersion
        ? `Android ${candidate.androidVersion}`
        : "Android",
      apiLevel: candidate.apiLevel ?? 0,
      architecture: candidate.architecture ?? "unknown",
      buildVersion: candidate.buildVersion,
      securityPatch: candidate.securityPatch,
    });
  }

  async resolveExecutionEndpoint(
    deviceId: string,
    mode: TaskConnectionMode = "auto",
    options: { signal?: AbortSignal } = {},
  ) {
    const device = (await this.refreshRegistered("android", options)).find(
      (item) => item.id === deviceId,
    );
    if (!device)
      throw new DeviceRegistrationError(
        `设备 ${deviceId} 尚未录入`,
        "DEVICE_NOT_REGISTERED",
      );
    if (
      device.platform !== "android" ||
      device.executionMode !== "adb" ||
      !device.eligible
    ) {
      throw new DeviceRegistrationError(
        `${device.name} 不能执行 Android ADB 真机任务`,
        "DEVICE_NOT_ELIGIBLE",
      );
    }
    const networkOperationActive =
      this.database.hasActiveNetworkConnectionOperation();
    if (mode === "network" && networkOperationActive)
      this.assertNoActiveNetworkOperation();

    const nowMs = this.nowMs();
    // Observation freshness gates only devices whose network discovery is
    // supervised (shadow/managed). In manual mode the verified Endpoint state
    // itself is authoritative and must keep working without mDNS.
    const supervised = (() => {
      const mode = this.database.getDeviceConnectionState(deviceId)?.managementMode
      return mode === "shadow" || mode === "managed"
    })()
    const networkEndpoints = this.database
      .listDeviceEndpoints(deviceId)
      .filter(
        (endpoint) =>
          endpoint.kind === "network" &&
          endpoint.status === "online" &&
          endpoint.adbSerial,
      )
      .filter((endpoint) => {
        // An Observation is an ephemeral discovery hint. Once it expires, the
        // verified Endpoint remains available for bounded recovery, but it must
        // not silently receive a new task until discovery is fresh again.
        // Endpoints that were never observed keep manual-mode semantics; under
        // shadow/managed discovery they wait for their first Observation.
        if (!endpoint.observationExpiresAt) return !supervised
        return Date.parse(endpoint.observationExpiresAt) > nowMs
      });
    const networkResolution = selectNetworkTransport({
      discovered: [],
      verified: networkEndpoints
        .filter((endpoint) => endpoint.host && endpoint.port)
        .map((endpoint) => ({
          transportType: endpoint.transportType ?? "tcp_legacy",
          host: endpoint.host!,
          port: endpoint.port!,
          serviceInstance: endpoint.serviceInstance,
          endpoint,
        })),
    });
    const resolvedNetworkEndpoint = networkResolution?.candidate.endpoint;
    // Never fall back to the snapshot's network endpoint after freshness
    // filtering. A verified Endpoint is retained for recovery/audit when its
    // Observation expires, but a new task may use it only after a current
    // Observation has refreshed its freshness window.
    const candidates = [
      ...(mode === "network" ? [] : [device.endpoints?.usb]),
      ...(mode === "usb" || networkOperationActive
        ? []
        : [resolvedNetworkEndpoint]),
    ].filter(Boolean) as DeviceEndpoint[];
    const endpoint = candidates.find(
      (item) => item.status === "online" && item.adbSerial,
    );
    if (!endpoint && mode === "auto" && networkOperationActive) {
      throw new DeviceRegistrationError(
        "批量联网连接正在执行，USB 当前不可用，自动模式暂不选择联网 Endpoint",
        "NETWORK_CONNECT_OPERATION_CONFLICT",
        409,
      );
    }
    if (!endpoint) {
      const modeLabel =
        mode === "usb" ? "USB" : mode === "network" ? "联网" : "USB 或联网";
      throw new DeviceRegistrationError(
        `${device.name} 当前没有可用的${modeLabel} ADB 连接`,
        "DEVICE_NOT_ONLINE",
        409,
      );
    }
    return endpoint;
  }

  recordAdbCommandHealthEvidence(input: {
    deviceId: string;
    endpointId: string;
    generation: number;
    evidence: AdbCommandHealthEvidence;
  }) {
    const endpoint = this.database.getDeviceEndpoint(input.endpointId);
    if (
      !endpoint ||
      endpoint.deviceId !== input.deviceId ||
      endpoint.kind !== "network"
    )
      return false;
    return this.connectionController.recordPassiveHealth({
      ...input,
      transportType: endpoint.transportType ?? "tcp_legacy",
      endpointSummary: {
        host: endpoint.host,
        port: endpoint.port,
        transportType: endpoint.transportType ?? "tcp_legacy",
        serviceInstance: endpoint.serviceInstance,
      },
    });
  }

  async connectNetwork(deviceId: string, host: string, port: number) {
    this.assertNoActiveNetworkOperation();
    const normalizedHost = host?.trim().replace(/^\[|\]$/g, "");
    if (
      normalizedHost &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535
    ) {
      const serial = networkSerial(normalizedHost, port);
      const existingBinding = this.findNetworkEndpoint(
        normalizedHost,
        port,
        serial,
      );
      if (existingBinding?.deviceId !== deviceId) {
        this.assertDeviceAllowsDisruptiveNetworkChange(deviceId);
      }
    }
    return this.runControlledNetworkConnect(deviceId, host, port, {
      source: "manual",
    });
  }

  private async runControlledNetworkConnect(
    deviceId: string,
    host: string,
    port: number,
    options: {
      source: string;
      signal?: AbortSignal;
      detailedFailure?: boolean;
      onStarted?: () => void;
      transportType?: "tcp_legacy" | "wireless_tls";
      serviceInstance?: string;
    },
  ) {
    const intentKey = `connect:${networkSerial(host, port)}`;
    try {
      return await this.connectionController.run(
        deviceId,
        intentKey,
        async (connectionOperation) => {
          options.onStarted?.();
          return this.connectNetworkInternal(deviceId, host, port, {
            connectionOperation,
            detailedFailure: options.detailedFailure,
            transportType: options.transportType ?? "tcp_legacy",
            serviceInstance: options.serviceInstance,
          });
        },
        { source: options.source, signal: options.signal },
      );
    } catch (error) {
      if (error instanceof DeviceConnectionDeadlineExceededError) {
        throw new DeviceRegistrationError(error.message, error.code, 409);
      }
      if (error instanceof DeviceConnectionControllerShutdownError) {
        throw new DeviceRegistrationError(error.message, error.code, 503);
      }
      throw error;
    }
  }

  private async connectNetworkInternal(
    deviceId: string,
    host: string,
    port: number,
    options: {
      signal?: AbortSignal;
      detailedFailure?: boolean;
      recoveryMode?: boolean;
      transportType?: "tcp_legacy" | "wireless_tls";
      serviceInstance?: string;
      connectionOperation?: DeviceConnectionOperationContext;
      preserveStateOnFailure?: boolean;
    } = {},
  ) {
    const device = this.database.getDevice(deviceId);
    if (!device)
      throw new DeviceRegistrationError(
        "物理设备不存在",
        "DEVICE_NOT_FOUND",
        404,
      );
    const normalizedHost = host?.trim().replace(/^\[|\]$/g, "");
    if (
      !normalizedHost ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new DeviceRegistrationError(
        "请输入有效的主机名/IP 和端口",
        "INVALID_NETWORK_ENDPOINT",
      );
    }

    const serial = networkSerial(normalizedHost, port);
    const existingBinding = this.findNetworkEndpoint(
      normalizedHost,
      port,
      serial,
    );
    if (existingBinding && existingBinding.deviceId !== deviceId) {
      throw new DeviceRegistrationError(
        "该联网 Endpoint 已绑定到另一台物理设备，需要人工确认，系统不会自动合并",
        "NETWORK_ENDPOINT_ALREADY_BOUND",
        409,
      );
    }
    if (existingBinding?.deviceId !== deviceId) {
      this.assertDeviceAllowsDisruptiveNetworkChange(deviceId);
    }

    const provider = this.provider("android");
    if (!provider.connectNetwork)
      throw new DeviceRegistrationError(
        "当前 Android Provider 不支持联网 ADB",
        "NETWORK_ADB_NOT_AVAILABLE",
        409,
      );
    const candidate = await provider.connectNetwork(normalizedHost, port, {
      signal: options.signal ?? options.connectionOperation?.signal,
    });
    if (candidate.connectionStatus !== "online") {
      const evidence = {
        adbExitCode: candidate.adbExitCode,
        adbStdout: candidate.adbStdout,
        adbStderr: candidate.adbStderr,
        adbStdoutTruncated: candidate.adbStdoutTruncated,
        adbStderrTruncated: candidate.adbStderrTruncated,
      };
      const cancelled =
        options.signal?.aborted ||
        candidate.failureCode === "NETWORK_CONNECTION_CANCELLED";
      if (cancelled) {
        if (options.connectionOperation) {
          const preservedOnlineEndpoint =
            existingBinding?.deviceId === deviceId &&
            existingBinding.status === "online"
              ? existingBinding
              : undefined;
          options.connectionOperation.commit({
            observedState: preservedOnlineEndpoint ? "online" : "offline",
            activeEndpointId: preservedOnlineEndpoint?.id,
            reasonCode: "NETWORK_CONNECTION_CANCELLED",
          });
          options.connectionOperation.record({
            eventType: "operation_cancelled",
            transportType: options.transportType ?? "tcp_legacy",
            endpointSummary: {
              host: normalizedHost,
              port,
              transportType: options.transportType ?? "tcp_legacy",
              serviceInstance: options.serviceInstance,
            },
            result: "cancelled",
            failureCode: "NETWORK_CONNECTION_CANCELLED",
          });
        }
        throw new DeviceRegistrationError(
          candidate.failureMessage ?? "联网连接已取消",
          "NETWORK_CONNECTION_CANCELLED",
          409,
          evidence,
        );
      }
      const failureMessage =
        candidate.failureMessage ?? "adb connect 未能建立可用连接";
      const failureCode = options.detailedFailure
        ? (candidate.failureCode ?? "ADB_DEVICE_OFFLINE")
        : "NETWORK_DEVICE_OFFLINE";
      if (
        options.recoveryMode &&
        !options.preserveStateOnFailure &&
        options.connectionOperation &&
        existingBinding?.deviceId === deviceId
      ) {
        this.recordNetworkRecoveryFailure(
          options.connectionOperation,
          existingBinding,
          failureCode,
          failureMessage,
        );
        throw new DeviceRegistrationError(
          `联网设备恢复失败：${failureMessage}`,
          failureCode,
          409,
          evidence,
        );
      }
      if (
        options.connectionOperation &&
        !options.preserveStateOnFailure &&
        !options.connectionOperation.commit({
          observedState: "offline",
          reasonCode: failureCode,
        })
      ) {
        throw new DeviceRegistrationError(
          "联网连接失败结果已过期，已拒绝修改 Endpoint",
          "NETWORK_CONNECTION_STALE_RESULT",
          409,
          evidence,
        );
      }

      // Only an already verified Endpoint may receive a failed observation.
      // A new, unverified address must not replace the device's formal Endpoint.
      if (
        existingBinding?.deviceId === deviceId &&
        !options.preserveStateOnFailure
      ) {
        this.database.updateDeviceEndpointStatus(
          existingBinding.id,
          candidate.connectionStatus,
          failureMessage,
        );
      }
      throw new DeviceRegistrationError(
        `联网设备连接失败：${failureMessage}`,
        failureCode,
        409,
        evidence,
      );
    }

    try {
      this.assertNetworkIdentityMatches(device, candidate);
    } catch (error) {
      if (
        options.connectionOperation &&
        !options.preserveStateOnFailure &&
        error instanceof DeviceRegistrationError
      ) {
        if (
          !options.connectionOperation.commit({
            observedState: "manual_action",
            reasonCode: error.code,
          })
        ) {
          throw new DeviceRegistrationError(
            "联网身份验证结果已过期，已拒绝修改连接状态",
            "NETWORK_CONNECTION_STALE_RESULT",
            409,
            error.evidence,
          );
        }
      }
      throw error;
    }
    if (
      options.connectionOperation &&
      !options.connectionOperation.isCurrent()
    ) {
      throw new DeviceRegistrationError(
        "联网连接结果已过期，已拒绝写入正式 Endpoint",
        "NETWORK_CONNECTION_STALE_RESULT",
        409,
      );
    }
    const endpointInput = {
      deviceId,
      kind: "network" as const,
      transportType: options.transportType ?? ("tcp_legacy" as const),
      adbSerial: candidate.serial,
      host: normalizedHost,
      port,
      serviceInstance: options.serviceInstance,
      pairingState:
        options.transportType === "wireless_tls"
          ? ("observed_working" as const)
          : undefined,
      priority: options.transportType === "wireless_tls" ? 100 : 50,
      lastVerifiedAt: new Date().toISOString(),
      status: "online" as const,
    };
    const profile = {
      name: candidate.name,
      manufacturer: candidate.manufacturer,
      model: candidate.model,
      osVersion: candidate.androidVersion
        ? `Android ${candidate.androidVersion}`
        : undefined,
      apiLevel: candidate.apiLevel,
      architecture: candidate.architecture,
      buildVersion: candidate.buildVersion,
      securityPatch: candidate.securityPatch,
    };
    const endpoint = options.connectionOperation
      ? this.database.activateVerifiedNetworkEndpoint({
          deviceId,
          operationId: options.connectionOperation.operationId,
          generation: options.connectionOperation.generation,
          endpoint: endpointInput,
          profile,
          event: {
            eventType: "endpoint_activated",
            source: options.connectionOperation.source,
            transportType: options.transportType ?? "tcp_legacy",
            endpointSummary: {
              host: normalizedHost,
              port,
              transportType: options.transportType ?? "tcp_legacy",
              serviceInstance: options.serviceInstance,
            },
            result: "succeeded",
          },
        })
      : (() => {
          this.database.devices.updateProfile(deviceId, profile);
          this.database.markDeviceSeen(deviceId);
          return this.database.upsertDeviceEndpoint(endpointInput);
        })();
    if (!endpoint) {
      throw new DeviceRegistrationError(
        "联网连接结果已过期，未能原子激活 Endpoint",
        "NETWORK_CONNECTION_STALE_RESULT",
        409,
      );
    }
    return endpoint;
  }

  async disconnectNetwork(deviceId: string, endpointId: string) {
    this.assertNoActiveNetworkOperation();
    const endpoint = this.requireNetworkEndpoint(deviceId, endpointId);
    this.assertDeviceAllowsDisruptiveNetworkChange(deviceId);
    return this.connectionController.run(
      deviceId,
      `disconnect-network:${endpointId}`,
      async (context) => {
        try {
          await this.provider("android").disconnect?.(endpoint.adbSerial);
          if (!context.isCurrent()) {
            throw new DeviceRegistrationError(
              "联网断开结果已过期，已拒绝修改 Endpoint",
              "NETWORK_CONNECTION_STALE_RESULT",
              409,
            );
          }
          const updated = this.database.updateDeviceEndpointStatus(
            endpoint.id,
            "offline",
          );
          if (
            !context.commit({
              desiredState: "disconnected",
              observedState: "offline",
              clearActiveEndpoint: true,
            })
          ) {
            throw new DeviceRegistrationError(
              "联网断开结果已过期，未能提交离线状态",
              "NETWORK_CONNECTION_STALE_RESULT",
              409,
            );
          }
          context.record({
            eventType: "endpoint_disconnected",
            transportType: endpoint.transportType ?? "tcp_legacy",
            endpointSummary: {
              host: endpoint.host,
              port: endpoint.port,
              transportType: endpoint.transportType ?? "tcp_legacy",
            },
            result: "succeeded",
          });
          return updated;
        } catch (error) {
          if (context.isCurrent()) {
            context.commit({
              observedState: "degraded",
              reasonCode: "NETWORK_DISCONNECT_FAILED",
            });
            context.record({
              eventType: "endpoint_disconnect_failed",
              transportType: endpoint.transportType ?? "tcp_legacy",
              endpointSummary: {
                host: endpoint.host,
                port: endpoint.port,
                transportType: endpoint.transportType ?? "tcp_legacy",
              },
              result: "failed",
              failureCode:
                error instanceof DeviceRegistrationError
                  ? error.code
                  : "NETWORK_DISCONNECT_FAILED",
            });
          }
          throw error;
        }
      },
      { source: "manual" },
    );
  }

  /**
   * Human-confirmed recovery for a device locked in manual_action.
   * The controller remains the only state writer: every candidate attempt is
   * fenced by one operation/generation, and a failed attempt never clears the
   * manual lock. TLS is tried first; TCP 5555 is only a previously verified
   * endpoint for the same Physical Device.
   */
  async recoverNetworkConnection(deviceId: string) {
    const device = this.database.getDevice(deviceId);
    if (!device)
      throw new DeviceRegistrationError(
        "物理设备不存在",
        "DEVICE_NOT_FOUND",
        404,
      );
    const state = this.database.getDeviceConnectionState(deviceId);
    if (!state || state.observedNetworkState !== "manual_action") {
      throw new DeviceRegistrationError(
        "设备当前不处于人工处理锁定状态",
        "MANUAL_ACTION_NOT_REQUIRED",
        409,
      );
    }
    if (
      state.managementMode !== "managed" ||
      state.desiredNetworkState !== "connected"
    ) {
      throw new DeviceRegistrationError(
        "只有期望联网的 Managed 设备可以人工恢复",
        "MANAGED_NETWORK_RECOVERY_NOT_ALLOWED",
        409,
      );
    }
    const gateReason = this.getManagedObservationGateReason(deviceId);
    if (gateReason) {
      throw new DeviceRegistrationError(
        gateReason === "MANAGED_OBSERVATION_ADOPTION_DISABLED"
          ? "Managed 自动化 Gate 当前已关闭"
          : "设备不在当前 Managed Gate 白名单内",
        gateReason,
        409,
      );
    }
    if (this.database.getDeviceQueueStatus(deviceId) !== "idle") {
      throw new DeviceRegistrationError(
        "设备正在执行任务，暂不能人工恢复联网连接",
        "DEVICE_BUSY",
        409,
      );
    }

    const activeMdnsTlsObservations = this.endpointObservations
      .listActive()
      .filter(
        (observation) =>
          observation.source === "mdns" &&
          observation.transportType === "wireless_tls" &&
          serviceInstanceContainsSerial(observation.serviceInstance, device.serial),
      )
      .sort(
        (a, b) =>
          Date.parse(b.observedAt) - Date.parse(a.observedAt),
      );
    const observationByEndpoint = new Map<string, EndpointObservation>();
    const observedEndpoints = activeMdnsTlsObservations.map((observation) => {
      const endpoint: DeviceEndpoint = {
        id: `observation-endpoint:${observation.id}`,
        deviceId,
        kind: "network",
        transportType: observation.transportType,
        adbSerial: networkSerial(observation.host, observation.port),
        host: observation.host,
        port: observation.port,
        serviceInstance: observation.serviceInstance,
        pairingState: "observed_working",
        priority: 100,
        status: "unknown",
        lastObservationAt: observation.observedAt,
        observationExpiresAt: observation.expiresAt,
        observationSource: observation.source,
      };
      observationByEndpoint.set(endpoint.id, observation);
      return endpoint;
    });
    const persistedEndpoints = this.database
      .listDeviceEndpoints(deviceId)
      .filter(
        (endpoint) =>
          endpoint.kind === "network" && endpoint.host && endpoint.port,
      )
      .filter(
        (endpoint) =>
          endpoint.transportType === "wireless_tls" ||
          (endpoint.transportType === "tcp_legacy" &&
            endpoint.port === 5555 &&
            Boolean(endpoint.lastVerifiedAt)),
      );
    const endpointKeys = new Set(
      observedEndpoints.map((endpoint) =>
        `${endpoint.transportType}:${endpoint.host}:${endpoint.port}`,
      ),
    );
    const endpoints = [
      ...observedEndpoints,
      ...persistedEndpoints.filter((endpoint) => {
        const key = `${endpoint.transportType}:${endpoint.host}:${endpoint.port}`;
        if (endpointKeys.has(key)) return false;
        endpointKeys.add(key);
        return true;
      }),
    ].sort(
      (a, b) =>
        Number(b.transportType === "wireless_tls") -
        Number(a.transportType === "wireless_tls"),
    );
    if (endpoints.length === 0) {
      throw new DeviceRegistrationError(
        "没有可供人工恢复验证的 TLS 或历史 TCP 5555 Endpoint",
        "NETWORK_RECOVERY_PATH_UNAVAILABLE",
        409,
      );
    }

    let lastError: DeviceRegistrationError | undefined;
    try {
      return await this.connectionController.run(
        deviceId,
        "manual-recover-network",
        async (context) => {
          const provider = this.provider("android");
          for (const endpoint of endpoints) {
            try {
              const observation = observationByEndpoint.get(endpoint.id);
              if (observation && !this.endpointObservations.isActive(observation.id)) {
                throw new DeviceRegistrationError(
                  "当前 mDNS TLS Observation 已过期",
                  "NETWORK_ENDPOINT_EXPIRED",
                  409,
                );
              }
              if (provider.probeNetwork) {
                const reachable = await provider.probeNetwork(
                  endpoint.host!,
                  endpoint.port!,
                  { signal: context.signal },
                );
                if (!reachable) {
                  const failureCode = resolverFailureCodeForTransport(
                    endpoint.transportType ?? "tcp_legacy",
                    "ADB_PORT_UNREACHABLE",
                  );
                  throw new DeviceRegistrationError(
                    "联网 Endpoint TCP 端口不可达",
                    failureCode,
                    409,
                  );
                }
              }
              const recovered = await this.connectNetworkInternal(
                deviceId,
                endpoint.host!,
                endpoint.port!,
                {
                  connectionOperation: context,
                  detailedFailure: true,
                  transportType: endpoint.transportType ?? "tcp_legacy",
                  serviceInstance: endpoint.serviceInstance,
                  preserveStateOnFailure: true,
                },
              );
              context.record({
                eventType: "manual_recovery_succeeded",
                transportType: endpoint.transportType ?? "tcp_legacy",
                endpointSummary: {
                  host: endpoint.host,
                  port: endpoint.port,
                  transportType: endpoint.transportType ?? "tcp_legacy",
                  serviceInstance: endpoint.serviceInstance,
                },
                result: "succeeded",
              });
              return recovered;
            } catch (error) {
              const rawCode =
                error instanceof DeviceRegistrationError
                  ? error.code
                  : "NETWORK_ENDPOINT_VERIFICATION_FAILED";
              const code = resolverFailureCodeForTransport(
                endpoint.transportType ?? "tcp_legacy",
                rawCode,
              );
              const message =
                error instanceof Error ? error.message : String(error);
              lastError = new DeviceRegistrationError(
                message,
                code,
                error instanceof DeviceRegistrationError
                  ? error.statusCode
                  : 409,
                error instanceof DeviceRegistrationError
                  ? error.evidence
                  : undefined,
              );
              // A provider call may resolve after a newer operation has
              // advanced the device generation. Do not let that stale result
              // mutate endpoint health or append recovery evidence.
              if (!context.isCurrent()) {
                throw new DeviceRegistrationError(
                  "人工恢复结果已过期，已拒绝修改连接状态",
                  "NETWORK_CONNECTION_STALE_RESULT",
                  409,
                );
              }
              this.recordEndpointHealthFailure(endpoint, code, message, {
                terminal: [
                  "DEVICE_IDENTITY_MISMATCH",
                  "NETWORK_ENDPOINT_ALREADY_BOUND",
                  "ENDPOINT_OWNED_BY_ANOTHER_DEVICE",
                ].includes(code),
              });
              context.record({
                eventType: "manual_recovery_attempt_failed",
                transportType: endpoint.transportType ?? "tcp_legacy",
                endpointSummary: {
                  host: endpoint.host,
                  port: endpoint.port,
                  transportType: endpoint.transportType ?? "tcp_legacy",
                  serviceInstance: endpoint.serviceInstance,
                },
                result: "failed",
                failureCode: code,
              });
              if (
                endpoint.transportType !== "wireless_tls" ||
                !canFallbackToTcp(code)
              )
                break;
            }
          }
          const failure =
            lastError ??
            new DeviceRegistrationError(
              "人工恢复验证失败",
              "NETWORK_ENDPOINT_VERIFICATION_FAILED",
              409,
            );
          if (context.signal.aborted) throw failure;
          if (
            !context.recordHealthFailure({
              reasonCode: failure.code,
              terminal: true,
              manualAction: true,
            })
          ) {
            throw new DeviceRegistrationError(
              "人工恢复结果已过期，已拒绝修改连接状态",
              "NETWORK_CONNECTION_STALE_RESULT",
              409,
            );
          }
          throw failure;
        },
        {
          source: "manual_recovery",
          observedState: "recovering",
          restoreStateOnAbort: {
            observedState: "manual_action",
            desiredState: state.desiredNetworkState,
            activeEndpointId: state.activeEndpointId,
            reasonCode: state.reasonCode,
            actionRequired:
              state.actionRequired ?? "CHECK_NETWORK_ADB_ENDPOINT",
          },
        },
      );
    } catch (error) {
      if (error instanceof DeviceConnectionDeadlineExceededError)
        throw new DeviceRegistrationError(error.message, error.code, 409);
      if (error instanceof DeviceConnectionControllerShutdownError)
        throw new DeviceRegistrationError(error.message, error.code, 503);
      throw error;
    }
  }

  async refreshNetwork(deviceId: string, endpointId: string) {
    this.assertNoActiveNetworkOperation();
    const endpoint = this.requireNetworkEndpoint(deviceId, endpointId);
    if (!endpoint.host || !endpoint.port)
      throw new DeviceRegistrationError(
        "联网 Endpoint 缺少主机地址",
        "INVALID_NETWORK_ENDPOINT",
      );
    return this.runControlledNetworkConnect(
      deviceId,
      endpoint.host,
      endpoint.port,
      {
        source: "manual",
        transportType: endpoint.transportType ?? "tcp_legacy",
        serviceInstance: endpoint.serviceInstance,
      },
    );
  }

  async reconcileNetworkEndpoint(deviceId: string, endpointId: string) {
    const endpoint = this.requireNetworkEndpoint(deviceId, endpointId);
    if (!endpoint.host || !endpoint.port) {
      throw new DeviceRegistrationError(
        "联网 Endpoint 缺少主机地址",
        "INVALID_NETWORK_ENDPOINT",
      );
    }
    const queueStatus = this.database.getDeviceQueueStatus(deviceId);
    if (queueStatus !== "idle") {
      const state = this.database.getDeviceConnectionState(deviceId);
      this.database.appendConnectionEvent({
        deviceId,
        operationId: state?.operationId,
        generation: state?.connectionGeneration ?? 0,
        eventType: "recovery_skipped_device_busy",
        source: "reconciler",
        transportType: endpoint.transportType ?? "tcp_legacy",
        endpointSummary: {
          host: endpoint.host,
          port: endpoint.port,
          transportType: endpoint.transportType ?? "tcp_legacy",
        },
        result: "skipped",
        failureCode: "DEVICE_BUSY",
      });
      return { status: "busy" as const, failureCode: "DEVICE_BUSY" };
    }
    const state = this.database.getDeviceConnectionState(deviceId);
    const nextRetryMs = state?.nextRetryAt
      ? Date.parse(state.nextRetryAt)
      : Number.NaN;
    if (Number.isFinite(nextRetryMs) && nextRetryMs > this.nowMs()) {
      return {
        status: "backoff" as const,
        retryAfterMs: nextRetryMs - this.nowMs(),
      };
    }

    try {
      const result = await this.connectionController.run(
        deviceId,
        `recover-network:${endpointId}`,
        async (connectionOperation) => {
          const provider = this.provider("android");
          const trustedTcpFallback =
            endpoint.transportType === "wireless_tls"
              ? this.database
                  .listDeviceEndpoints(deviceId)
                  .find(
                    (candidate) =>
                      candidate.kind === "network" &&
                      candidate.transportType === "tcp_legacy" &&
                      candidate.port === 5555 &&
                      candidate.status === "online" &&
                      Boolean(candidate.lastVerifiedAt) &&
                      (!candidate.nextRetryAt ||
                        Date.parse(candidate.nextRetryAt) <= this.nowMs()),
                  )
              : undefined;
          const candidates = trustedTcpFallback
            ? [endpoint, trustedTcpFallback]
            : [endpoint];
          let lastFailure:
            | {
                endpoint: DeviceEndpoint;
                code: string;
                message: string;
              }
            | undefined;

          for (const candidateEndpoint of candidates) {
            try {
              if (provider.probeNetwork) {
                const reachable = await provider.probeNetwork(
                  candidateEndpoint.host!,
                  candidateEndpoint.port!,
                  { signal: connectionOperation.signal },
                );
                if (!reachable) {
                  const failureCode = resolverFailureCodeForTransport(
                    candidateEndpoint.transportType ?? "tcp_legacy",
                    "ADB_PORT_UNREACHABLE",
                  );
                  throw new DeviceRegistrationError(
                    "联网 Endpoint TCP 端口不可达",
                    failureCode,
                    409,
                  );
                }
              }
              const activated = await this.connectNetworkInternal(
                deviceId,
                candidateEndpoint.host!,
                candidateEndpoint.port!,
                {
                  connectionOperation,
                  detailedFailure: true,
                  recoveryMode: true,
                  transportType:
                    candidateEndpoint.transportType ?? "tcp_legacy",
                  serviceInstance: candidateEndpoint.serviceInstance,
                  preserveStateOnFailure: true,
                },
              );
              if (candidateEndpoint.id !== endpoint.id) {
                connectionOperation.record({
                  eventType: "managed_recovery_fallback_succeeded",
                  transportType:
                    candidateEndpoint.transportType ?? "tcp_legacy",
                  endpointSummary: {
                    host: candidateEndpoint.host,
                    port: candidateEndpoint.port,
                    transportType:
                      candidateEndpoint.transportType ?? "tcp_legacy",
                    serviceInstance: candidateEndpoint.serviceInstance,
                  },
                  result: "succeeded",
                  failureCode: lastFailure?.code,
                });
              }
              return { status: "online" as const, endpoint: activated };
            } catch (error) {
              const rawCode =
                error instanceof DeviceRegistrationError
                  ? error.code
                  : "NETWORK_ENDPOINT_VERIFICATION_FAILED";
              if (
                rawCode === "NETWORK_CONNECTION_STALE_RESULT" ||
                rawCode === "NETWORK_CONNECTION_CANCELLED"
              ) {
                throw error;
              }
              const code = resolverFailureCodeForTransport(
                candidateEndpoint.transportType ?? "tcp_legacy",
                rawCode,
              );
              const message =
                error instanceof Error ? error.message : String(error);
              lastFailure = { endpoint: candidateEndpoint, code, message };
              this.recordEndpointHealthFailure(
                candidateEndpoint,
                code,
                message,
                {
                  terminal: [
                    "DEVICE_IDENTITY_MISMATCH",
                    "NETWORK_ENDPOINT_ALREADY_BOUND",
                    "ENDPOINT_OWNED_BY_ANOTHER_DEVICE",
                  ].includes(code),
                },
              );
              connectionOperation.record({
                eventType: "managed_recovery_attempt_failed",
                transportType:
                  candidateEndpoint.transportType ?? "tcp_legacy",
                endpointSummary: {
                  host: candidateEndpoint.host,
                  port: candidateEndpoint.port,
                  transportType:
                    candidateEndpoint.transportType ?? "tcp_legacy",
                  serviceInstance: candidateEndpoint.serviceInstance,
                },
                result: "failed",
                failureCode: code,
              });
              if (
                candidateEndpoint.id !== endpoint.id ||
                candidateEndpoint.transportType !== "wireless_tls" ||
                !canFallbackToTcp(code)
              ) {
                break;
              }
            }
          }

          const failure = lastFailure ?? {
            endpoint,
            code: "NETWORK_ENDPOINT_VERIFICATION_FAILED",
            message: "Managed 联网 Endpoint 恢复验证失败",
          };
          return this.recordNetworkRecoveryFailure(
            connectionOperation,
            failure.endpoint,
            failure.code,
            failure.message,
            {
              recordEndpointHealth: false,
              forceManualAction: [
                "DEVICE_IDENTITY_MISMATCH",
                "NETWORK_ENDPOINT_ALREADY_BOUND",
                "ENDPOINT_OWNED_BY_ANOTHER_DEVICE",
              ].includes(failure.code),
            },
          );
        },
        { source: "reconciler", observedState: "recovering" },
      );
      return result;
    } catch (error) {
      if (error instanceof DeviceConnectionControllerShutdownError) {
        return {
          status: "cancelled" as const,
          failureCode: "SERVICE_SHUTDOWN",
        };
      }
      if (error instanceof DeviceConnectionDeadlineExceededError) {
        return {
          status: "offline" as const,
          failureCode: error.code,
          retryAfterMs: 0,
        };
      }
      if (error instanceof DeviceRegistrationError) {
        const failed = this.database.getDeviceConnectionState(deviceId);
        const retryAt = failed?.nextRetryAt
          ? Date.parse(failed.nextRetryAt)
          : this.nowMs();
        return {
          status:
            failed?.observedNetworkState === "manual_action"
              ? ("manual_action" as const)
              : failed?.observedNetworkState === "degraded"
                ? ("degraded" as const)
                : ("offline" as const),
          failureCode: error.code,
          retryAfterMs: Math.max(0, retryAt - this.nowMs()),
        };
      }
      throw error;
    }
  }

  async reconcileManagedNetworkEndpoints(
    maxParallel = 3,
    allowedDeviceIds?: string[],
  ) {
    // Keep the same distinction as Observation reconciliation: undefined is a
    // direct-call compatibility mode, while [] is an explicitly fail-closed Gate.
    const allowed =
      allowedDeviceIds === undefined ? undefined : new Set(allowedDeviceIds);
    const candidates = this.database
      .listDeviceConnectionStates()
      .flatMap((state) => {
        if (this.getManagedObservationGateReason(state.deviceId, allowed))
          return [];

        if (
          state.managementMode !== "managed" ||
          state.desiredNetworkState !== "connected" ||
          state.observedNetworkState === "manual_action"
        )
          return [];
        const endpoint = this.database.getDeviceEndpointByKind(
          state.deviceId,
          "network",
        );
        return endpoint?.host && endpoint.port ? [{ state, endpoint }] : [];
      });
    const results: Array<{
      deviceId: string;
      endpointId: string;
      result: Awaited<
        ReturnType<DeviceRegistryService["reconcileNetworkEndpoint"]>
      >;
    }> = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const candidate = candidates[cursor++];
        if (!candidate) return;
        const result = await this.reconcileNetworkEndpoint(
          candidate.state.deviceId,
          candidate.endpoint.id,
        );
        results.push({
          deviceId: candidate.state.deviceId,
          endpointId: candidate.endpoint.id,
          result,
        });
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(Math.max(1, maxParallel), candidates.length) },
        () => worker(),
      ),
    );
    return results;
  }

  async shutdownConnections() {
    this.shadowObservationController?.abort(new Error("服务正在关闭"));
    await Promise.allSettled(
      [
        this.shadowObservationRefresh,
        this.connectionController.shutdown(),
      ].filter(Boolean) as Promise<unknown>[],
    );
  }

  setNetworkManagementMode(
    deviceId: string,
    mode: DeviceConnectionManagementMode,
  ) {
    const device = this.database.getDevice(deviceId);
    if (!device)
      throw new DeviceRegistrationError(
        "物理设备不存在",
        "DEVICE_NOT_FOUND",
        404,
      );
    const endpoint = this.database.getDeviceEndpointByKind(deviceId, "network");
    if (mode !== "manual" && !endpoint) {
      throw new DeviceRegistrationError(
        "启用 shadow 或 managed 前必须先建立并验证联网 Endpoint",
        "VERIFIED_NETWORK_ENDPOINT_REQUIRED",
        409,
      );
    }
    const current = this.database.getDeviceConnectionState(deviceId);
    if (current?.managementMode === mode) return current;
    const updated = this.database.setDeviceConnectionManagementMode(
      deviceId,
      mode,
    );
    if (!updated)
      throw new DeviceRegistrationError(
        "设备连接状态不存在",
        "DEVICE_CONNECTION_STATE_NOT_FOUND",
        409,
      );
    this.database.appendConnectionEvent({
      deviceId,
      operationId: current?.operationId,
      generation: current?.connectionGeneration ?? 0,
      eventType: "management_mode_changed",
      source: "manual",
      transportType: endpoint
        ? (endpoint.transportType ?? "tcp_legacy")
        : undefined,
      endpointSummary: endpoint
        ? {
            host: endpoint.host,
            port: endpoint.port,
            transportType: endpoint.transportType ?? "tcp_legacy",
          }
        : undefined,
      result: mode,
    });
    return updated;
  }

  async removeNetworkEndpoint(deviceId: string, endpointId: string) {
    this.assertNoActiveNetworkOperation();
    const endpoint = this.requireNetworkEndpoint(deviceId, endpointId);
    this.assertDeviceAllowsDisruptiveNetworkChange(deviceId);
    return this.connectionController.run(
      deviceId,
      `remove-network:${endpointId}`,
      async (context) => {
        await this.provider("android").disconnect?.(endpoint.adbSerial);
        if (!context.isCurrent()) {
          throw new DeviceRegistrationError(
            "联网 Endpoint 删除结果已过期，已拒绝删除",
            "NETWORK_CONNECTION_STALE_RESULT",
            409,
          );
        }
        const removed = this.database.removeDeviceEndpoint(endpointId);
        if (
          !context.commit({
            desiredState: "disconnected",
            observedState: "offline",
            clearActiveEndpoint: true,
          })
        ) {
          throw new DeviceRegistrationError(
            "联网 Endpoint 删除结果已过期，未能提交离线状态",
            "NETWORK_CONNECTION_STALE_RESULT",
            409,
          );
        }
        context.record({
          eventType: "endpoint_removed",
          transportType: endpoint.transportType ?? "tcp_legacy",
          endpointSummary: {
            host: endpoint.host,
            port: endpoint.port,
            transportType: endpoint.transportType ?? "tcp_legacy",
          },
          result: "succeeded",
        });
        return removed;
      },
      { source: "manual" },
    );
  }

  startNetworkConnectionOperation(): NetworkConnectionOperationStart {
    if (this.database.hasActiveNetworkConnectionOperation()) {
      throw new DeviceRegistrationError(
        "已有联网批量连接操作正在执行",
        "NETWORK_CONNECT_OPERATION_ALREADY_RUNNING",
        409,
      );
    }
    const items = this.database.listDevices().flatMap((device) => {
      const endpoint = this.database
        .listDeviceEndpoints(device.id)
        .find((item) => item.kind === "network" && item.host && item.port);
      if (!endpoint?.host || !endpoint.port) return [];
      return [
        {
          deviceId: device.id,
          endpointId: endpoint.id,
          host: endpoint.host,
          port: endpoint.port,
          transportType: endpoint.transportType ?? "tcp_legacy",
          serviceInstance: endpoint.serviceInstance,
        },
      ];
    });
    if (items.length === 0) {
      throw new DeviceRegistrationError(
        "没有配置联网 Endpoint 的设备",
        "NO_NETWORK_ENDPOINTS",
        409,
      );
    }
    const operation = this.database.networkConnectionOperations.create({
      items,
    });
    const controller = new AbortController();
    this.networkOperationControllers.set(operation.id, controller);
    void this.runNetworkConnectionOperation(operation.id, controller);
    return {
      operationId: operation.id,
      status: operation.status,
      totalCount: operation.totalCount,
    };
  }

  getNetworkConnectionOperation(operationId: string) {
    const operation = this.database.getNetworkConnectionOperation(operationId);
    if (!operation)
      throw new DeviceRegistrationError(
        "联网批量连接操作不存在",
        "NETWORK_CONNECT_OPERATION_NOT_FOUND",
        404,
      );
    return operation;
  }

  cancelNetworkConnectionOperation(operationId: string) {
    const operation = this.getNetworkConnectionOperation(operationId);
    if (operation.status === "queued" || operation.status === "running") {
      this.database.networkConnectionOperations.requestCancel(operationId);
      this.networkOperationControllers.get(operationId)?.abort();
    }
    return this.getNetworkConnectionOperation(operationId);
  }

  private assertNoActiveNetworkOperation() {
    if (this.database.hasActiveNetworkConnectionOperation()) {
      throw new DeviceRegistrationError(
        "批量联网连接正在执行，当前单台操作被拒绝",
        "NETWORK_CONNECT_OPERATION_CONFLICT",
        409,
      );
    }
  }

  private assertDeviceAllowsDisruptiveNetworkChange(deviceId: string) {
    if (this.database.getDeviceQueueStatus(deviceId) !== "idle") {
      throw new DeviceRegistrationError(
        "设备正在排队或执行测试，不能更换、断开或删除联网 Endpoint",
        "DEVICE_BUSY",
        409,
      );
    }
  }

  private async runNetworkConnectionOperation(
    operationId: string,
    controller: AbortController,
  ) {
    const store = this.database.networkConnectionOperations;
    try {
      store.markRunning(operationId);
      const operation = store.get(operationId);
      if (!operation) return;
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const current = store.get(operationId);
          if (!current || cursor >= current.items.length) return;
          const item = current.items[cursor++];
          if (store.isCancelRequested(operationId)) {
            store.updateItem(item.id, {
              status: "cancelled",
              failureCode: "NETWORK_CONNECTION_CANCELLED",
              failureMessage: "联网连接已取消",
              cancelReason: current.cancelReason ?? "USER_REQUESTED",
              finishedAt: new Date().toISOString(),
            });
            continue;
          }
          const device = this.database.getDevice(item.deviceId);
          const queueStatus = device
            ? this.database.getDeviceQueueStatus(device.id)
            : "idle";
          if (queueStatus === "queued" || queueStatus === "running") {
            store.updateItem(item.id, {
              status: "skipped",
              skipReason: "DEVICE_BUSY",
              failureCode: "DEVICE_BUSY",
              failureMessage: "设备正在执行测试任务",
              finishedAt: new Date().toISOString(),
            });
            continue;
          }
          if (this.networkEndpointLocks.has(item.endpointId)) {
            store.updateItem(item.id, {
              status: "skipped",
              skipReason: "NETWORK_ENDPOINT_BUSY",
              failureCode: "NETWORK_ENDPOINT_BUSY",
              failureMessage: "该联网 Endpoint 正在执行其他连接操作",
              finishedAt: new Date().toISOString(),
            });
            continue;
          }
          this.networkEndpointLocks.add(item.endpointId);
          try {
            await this.runControlledNetworkConnect(
              item.deviceId,
              item.host,
              item.port,
              {
                source: "batch",
                signal: controller.signal,
                detailedFailure: true,
                transportType: item.transportType,
                serviceInstance: item.serviceInstance,
                onStarted: () => {
                  store.updateItem(item.id, {
                    status: "running",
                    startedAt: new Date().toISOString(),
                  });
                },
              },
            );
            store.updateItem(item.id, {
              status: "succeeded",
              finishedAt: new Date().toISOString(),
            });
          } catch (error) {
            const cancelled =
              controller.signal.aborted || store.isCancelRequested(operationId);
            const registrationError =
              error instanceof DeviceRegistrationError ? error : undefined;
            store.updateItem(item.id, {
              status: cancelled ? "cancelled" : "failed",
              failureCode: cancelled
                ? "NETWORK_CONNECTION_CANCELLED"
                : (registrationError?.code ?? "ADB_COMMAND_FAILED"),
              failureMessage: cancelled
                ? "联网连接已取消"
                : (registrationError?.message ??
                  (error instanceof Error ? error.message : String(error))),
              adbExitCode: registrationError?.evidence?.adbExitCode,
              adbStdout: registrationError?.evidence?.adbStdout,
              adbStderr: registrationError?.evidence?.adbStderr,
              adbStdoutTruncated:
                registrationError?.evidence?.adbStdoutTruncated,
              adbStderrTruncated:
                registrationError?.evidence?.adbStderrTruncated,
              cancelReason: cancelled
                ? (store.get(operationId)?.cancelReason ?? "USER_REQUESTED")
                : undefined,
              finishedAt: new Date().toISOString(),
            });
          } finally {
            this.networkEndpointLocks.delete(item.endpointId);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(3, operation.items.length) }, () =>
          worker(),
        ),
      );
      const final = store.get(operationId);
      if (!final) return;
      const hasPending = final.items.some(
        (item) => item.status === "pending" || item.status === "running",
      );
      if (hasPending || store.isCancelRequested(operationId)) {
        for (const item of final.items.filter(
          (candidate) =>
            candidate.status === "pending" || candidate.status === "running",
        )) {
          store.updateItem(item.id, {
            status: "cancelled",
            failureCode: "NETWORK_CONNECTION_CANCELLED",
            failureMessage: "联网连接已取消",
            cancelReason: final.cancelReason ?? "USER_REQUESTED",
            finishedAt: new Date().toISOString(),
          });
        }
        store.finish(
          operationId,
          "cancelled",
          final.cancelReason ?? "USER_REQUESTED",
        );
      } else {
        store.finish(operationId, "completed");
      }
      store.purgeCompleted(100);
    } catch (error) {
      const current = store.get(operationId);
      if (current) {
        for (const item of current.items.filter(
          (candidate) =>
            candidate.status === "pending" || candidate.status === "running",
        )) {
          store.updateItem(item.id, {
            status: "failed",
            failureCode: "NETWORK_CONNECT_OPERATION_FAILED",
            failureMessage:
              error instanceof Error ? error.message : String(error),
            finishedAt: new Date().toISOString(),
          });
        }
        store.finish(operationId, "failed");
      }
    } finally {
      this.networkOperationControllers.delete(operationId);
    }
  }

  private findNetworkEndpoint(host: string, port: number, adbSerial: string) {
    const bySerial = this.database.getDeviceEndpointBySerial(adbSerial);
    if (bySerial) return bySerial;
    for (const device of this.database.listDevices()) {
      const endpoint = this.database.getDeviceEndpointByKind(
        device.id,
        "network",
      );
      if (endpoint?.host === host && endpoint.port === port) return endpoint;
    }
    return undefined;
  }

  private requireNetworkEndpoint(deviceId: string, endpointId: string) {
    const endpoint = this.database.getDeviceEndpoint(endpointId);
    if (
      !endpoint ||
      endpoint.deviceId !== deviceId ||
      endpoint.kind !== "network"
    ) {
      throw new DeviceRegistrationError(
        "联网 Endpoint 不存在",
        "ENDPOINT_NOT_FOUND",
        404,
      );
    }
    return endpoint;
  }

  private networkIdentityError(
    device: DeviceProfile,
    candidate: DeviceDiscoveryCandidate,
  ) {
    const resolution = resolveDeviceIdentity(device, candidate, {
      findOwner: (hardwareSerial) =>
        this.database.getDeviceBySerial(hardwareSerial),
    });
    return resolution.decision === "matched" ? undefined : resolution.message;
  }

  private assertNetworkIdentityMatches(
    device: DeviceProfile,
    candidate: DeviceDiscoveryCandidate,
  ) {
    const resolution = resolveDeviceIdentity(device, candidate, {
      findOwner: (hardwareSerial) =>
        this.database.getDeviceBySerial(hardwareSerial),
    });
    if (resolution.decision !== "matched") {
      throw new DeviceRegistrationError(
        resolution.message,
        resolution.code,
        409,
        {
          adbExitCode: candidate.adbExitCode,
          adbStdout: candidate.adbStdout,
          adbStderr: candidate.adbStderr,
          adbStdoutTruncated: candidate.adbStdoutTruncated,
          adbStderrTruncated: candidate.adbStderrTruncated,
        },
      );
    }
  }

  private recordEndpointHealthFailure(
    endpoint: DeviceEndpoint,
    failureCode: string,
    failureMessage?: string,
    options: { terminal?: boolean } = {},
  ) {
    const consecutiveFailures = (endpoint.consecutiveFailures ?? 0) + 1;
    const terminal = options.terminal === true || consecutiveFailures >= 3;
    const backoffMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000][
      Math.min(consecutiveFailures - 1, 5)
    ];
    const nextRetryAt =
      options.terminal === true || consecutiveFailures >= 5
        ? undefined
        : new Date(
            this.nowMs() +
              Math.round(backoffMs * (0.8 + this.random() * 0.4)),
          ).toISOString();
    return this.database.recordDeviceEndpointHealthFailure(endpoint.id, {
      failureCode,
      nextRetryAt,
      terminal,
      lastError: failureMessage,
      evaluatedAt: new Date(this.nowMs()).toISOString(),
    });
  }

  private recordNetworkRecoveryFailure(
    connectionOperation: DeviceConnectionOperationContext,
    endpoint: DeviceEndpoint,
    failureCode: string,
    failureMessage: string,
    options: {
      recordEndpointHealth?: boolean;
      forceManualAction?: boolean;
    } = {},
  ) {
    if (options.recordEndpointHealth !== false) {
      this.recordEndpointHealthFailure(endpoint, failureCode, failureMessage);
    }
    const state = this.database.getDeviceConnectionState(endpoint.deviceId);
    const consecutiveFailures = (state?.consecutiveFailures ?? 0) + 1;
    const manualAction =
      options.forceManualAction === true || consecutiveFailures >= 5;
    const terminal = manualAction || consecutiveFailures >= 3;
    const backoffMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000][
      Math.min(consecutiveFailures - 1, 5)
    ];
    const retryAfterMs = Math.round(backoffMs * (0.8 + this.random() * 0.4));
    const nextRetryAt = manualAction
      ? undefined
      : new Date(this.nowMs() + retryAfterMs).toISOString();
    if (
      !connectionOperation.recordHealthFailure({
        reasonCode: failureCode,
        nextRetryAt,
        terminal,
        manualAction,
      })
    ) {
      throw new DeviceRegistrationError(
        "联网健康检查结果已过期，已拒绝修改连接状态",
        "NETWORK_CONNECTION_STALE_RESULT",
        409,
      );
    }
    if (terminal && options.recordEndpointHealth !== false) {
      this.database.updateDeviceEndpointStatus(
        endpoint.id,
        "offline",
        failureMessage,
      );
    }
    connectionOperation.record({
      eventType: manualAction
        ? "endpoint_manual_action_required"
        : terminal
          ? "endpoint_recovery_exhausted"
          : "endpoint_health_degraded",
      transportType: endpoint.transportType ?? "tcp_legacy",
      endpointSummary: {
        host: endpoint.host,
        port: endpoint.port,
        transportType: endpoint.transportType ?? "tcp_legacy",
      },
      result: "failed",
      failureCode,
    });
    return {
      status: manualAction
        ? ("manual_action" as const)
        : terminal
          ? ("offline" as const)
          : ("degraded" as const),
      failureCode,
      retryAfterMs,
    };
  }

  private updateDeviceFromCandidate(
    deviceId: string,
    candidate: DeviceDiscoveryCandidate,
  ) {
    this.database.devices.updateProfile(deviceId, {
      name: candidate.name,
      manufacturer: candidate.manufacturer,
      model: candidate.model,
      osVersion: candidate.androidVersion
        ? `Android ${candidate.androidVersion}`
        : undefined,
      apiLevel: candidate.apiLevel,
      architecture: candidate.architecture,
      buildVersion: candidate.buildVersion,
      securityPatch: candidate.securityPatch,
    });
  }
}
