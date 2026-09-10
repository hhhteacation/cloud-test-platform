import { describe, expect, it, vi } from "vitest";

import {
  ManagedObservationAdoptionGate,
  runManagedObservationCycle,
} from "./managed-observation-adoption-gate.js";

describe("ManagedObservationAdoptionGate", () => {
  it("初始快照明确显示默认关闭且没有运行历史", () => {
    const gate = new ManagedObservationAdoptionGate({
      enabled: false,
      reconcile: async () => [],
    });

    expect(gate.snapshot()).toEqual({
      enabled: false,
      gateMode: "disabled",
      allowedDeviceIds: [],
      running: false,
      cyclesStarted: 0,
      cyclesCompleted: 0,
      adoptionFailures: 0,
      discoveryFailures: 0,
    });
  });

  it("默认关闭时不调用 Managed Observation 对账", async () => {
    const reconcile = vi.fn(async () => [{ status: "adopted" }]);
    const gate = new ManagedObservationAdoptionGate({
      enabled: false,
      reconcile,
    });

    await expect(gate.runOnce()).resolves.toEqual({ status: "disabled" });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("成功周期只记录采用结果摘要和起止时间", async () => {
    let now = new Date("2026-08-25T07:00:00.000Z");
    const gate = new ManagedObservationAdoptionGate({
      enabled: true,
      now: () => now,
      reconcile: async () => {
        now = new Date("2026-08-25T07:00:02.500Z");
        return [
          { observationId: "one", status: "adopted" },
          { observationId: "two", status: "skipped" },
          { observationId: "three", status: "failed" },
        ];
      },
    });

    await gate.runOnce();

    expect(gate.snapshot()).toEqual({
      enabled: true,
      gateMode: "fail_closed_empty_allowlist",
      allowedDeviceIds: [],
      running: false,
      cyclesStarted: 1,
      cyclesCompleted: 1,
      adoptionFailures: 0,
      discoveryFailures: 0,
      lastStartedAt: "2026-08-25T07:00:00.000Z",
      lastCompletedAt: "2026-08-25T07:00:02.500Z",
      lastResult: {
        total: 3,
        adopted: 1,
        skipped: 1,
        failed: 1,
        outsideAllowlist: 0,
        manualActionBlocked: 0,
        identityRejected: 0,
        endpointAlreadyActive: 0,
        deviceBusy: 0,
        skippedReasonCounts: {},
        failedReasonCounts: {},
      },
    });
  });

  it("最近周期按候选状态分别保留所有 reasonCode 统计", async () => {
    const gate = new ManagedObservationAdoptionGate({
      enabled: true,
      reconcile: async () => [
        {
          observationId: "adopted-with-stale-reason",
          status: "adopted",
          reasonCode: "MANUAL_ACTION_REQUIRED",
        },
        {
          observationId: "skipped-manual",
          status: "skipped",
          reasonCode: "MANUAL_ACTION_REQUIRED",
        },
        {
          observationId: "skipped-gate",
          status: "skipped",
          reasonCode: "NOT_IN_MANAGED_GATE_ALLOWLIST",
        },
        {
          observationId: "failed-connect",
          status: "failed",
          reasonCode: "NETWORK_ENDPOINT_VERIFICATION_FAILED",
        },
        {
          observationId: "skipped-unknown",
          status: "skipped",
          reasonCode: "NEW_DECISION_REASON",
        },
      ],
    });

    await gate.runOnce();

    expect(gate.snapshot().lastResult).toMatchObject({
      total: 5,
      adopted: 1,
      skipped: 3,
      failed: 1,
      skippedReasonCounts: {
        MANUAL_ACTION_REQUIRED: 1,
        NOT_IN_MANAGED_GATE_ALLOWLIST: 1,
        NEW_DECISION_REASON: 1,
      },
      failedReasonCounts: {
        NETWORK_ENDPOINT_VERIFICATION_FAILED: 1,
      },
    });
  });

  it("启用后合并重叠周期，并固定最多并发验证三台设备", async () => {
    let release: (() => void) | undefined;
    const reconcile = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [{ status: "adopted" }];
    });
    const gate = new ManagedObservationAdoptionGate({
      enabled: true,
      reconcile,
    });

    const first = gate.runOnce();
    const second = gate.runOnce();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(reconcile).toHaveBeenCalledWith(3, []);
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "completed", results: [{ status: "adopted" }] },
      { status: "completed", results: [{ status: "adopted" }] },
    ]);
  });

  it("关闭服务时等待正在执行的采用周期结束", async () => {
    let release: (() => void) | undefined;
    const gate = new ManagedObservationAdoptionGate({
      enabled: true,
      reconcile: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [];
      },
    });
    const run = gate.runOnce();
    let drained = false;
    const drain = gate.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    release?.();
    await expect(Promise.all([run, drain])).resolves.toEqual([
      { status: "completed", results: [] },
      undefined,
    ]);
    expect(drained).toBe(true);
  });

  it("mDNS 刷新失败不代表已有 Observation 消失，仍执行采用 Gate", async () => {
    const discoveryError = new Error("mDNS unavailable");
    const onDiscoveryError = vi.fn();
    const reconcile = vi.fn(async () => [
      { status: "adopted", observationId: "from-adb-track" },
    ]);
    const gate = new ManagedObservationAdoptionGate({
      enabled: true,
      reconcile,
    });

    await expect(
      runManagedObservationCycle({
        refreshObservations: async () => {
          throw discoveryError;
        },
        adoptionGate: gate,
        onDiscoveryError,
        onAdoptionError: vi.fn(),
      }),
    ).resolves.toBeUndefined();
    expect(onDiscoveryError).toHaveBeenCalledWith(discoveryError);
    expect(reconcile).toHaveBeenCalledWith(3, []);
  });

  it("分别统计发现失败和采用失败，并保留可解释的最近错误", async () => {
    const now = new Date("2026-08-25T08:00:00.000Z");
    const gate = new ManagedObservationAdoptionGate({
      enabled: true,
      now: () => now,
      reconcile: async () => {
        throw new Error("candidate verification failed");
      },
    });

    await runManagedObservationCycle({
      refreshObservations: async () => {
        throw new Error("mDNS timed out");
      },
      adoptionGate: gate,
      onDiscoveryError: vi.fn(),
      onAdoptionError: vi.fn(),
    });

    expect(gate.snapshot()).toEqual({
      enabled: true,
      gateMode: "fail_closed_empty_allowlist",
      allowedDeviceIds: [],
      running: false,
      cyclesStarted: 1,
      cyclesCompleted: 0,
      adoptionFailures: 1,
      discoveryFailures: 1,
      lastStartedAt: "2026-08-25T08:00:00.000Z",
      lastDiscoveryError: {
        at: "2026-08-25T08:00:00.000Z",
        message: "mDNS timed out",
      },
      lastAdoptionError: {
        at: "2026-08-25T08:00:00.000Z",
        message: "candidate verification failed",
      },
    });
  });
});
