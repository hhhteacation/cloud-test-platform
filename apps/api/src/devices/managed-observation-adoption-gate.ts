export interface ManagedObservationAdoptionGateOptions {
  enabled: boolean;
  deviceIds?: string[];
  reconcile(maxParallel: number, deviceIds?: string[]): Promise<unknown>;
  now?: () => Date;
}

type ManagedObservationAdoptionGateResult =
  { status: "disabled" } | { status: "completed"; results: unknown };

function errorMessage(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 500);
}

export class ManagedObservationAdoptionGate {
  private inFlight?: Promise<ManagedObservationAdoptionGateResult>;
  private cyclesStarted = 0;
  private cyclesCompleted = 0;
  private adoptionFailures = 0;
  private discoveryFailures = 0;
  private lastStartedAt?: string;
  private lastCompletedAt?: string;
  private lastResult?: {
    total: number;
    adopted: number;
    skipped: number;
    failed: number;
    outsideAllowlist: number;
    manualActionBlocked: number;
    identityRejected: number;
    endpointAlreadyActive: number;
    deviceBusy: number;
    skippedReasonCounts: Record<string, number>;
    failedReasonCounts: Record<string, number>;
  };
  private lastDiscoveryError?: { at: string; message: string };
  private lastAdoptionError?: { at: string; message: string };

  constructor(
    private readonly options: ManagedObservationAdoptionGateOptions,
  ) {}

  snapshot() {
    return {
      enabled: this.options.enabled,
      gateMode: this.options.enabled
        ? this.options.deviceIds?.length
          ? "allowlist"
          : "fail_closed_empty_allowlist"
        : "disabled",
      allowedDeviceIds: [...(this.options.deviceIds ?? [])],
      running: this.inFlight !== undefined,
      cyclesStarted: this.cyclesStarted,
      cyclesCompleted: this.cyclesCompleted,
      adoptionFailures: this.adoptionFailures,
      discoveryFailures: this.discoveryFailures,
      ...(this.lastStartedAt ? { lastStartedAt: this.lastStartedAt } : {}),
      ...(this.lastCompletedAt
        ? { lastCompletedAt: this.lastCompletedAt }
        : {}),
      ...(this.lastResult ? { lastResult: { ...this.lastResult } } : {}),
      ...(this.lastDiscoveryError
        ? { lastDiscoveryError: { ...this.lastDiscoveryError } }
        : {}),
      ...(this.lastAdoptionError
        ? { lastAdoptionError: { ...this.lastAdoptionError } }
        : {}),
    };
  }

  recordDiscoveryFailure(error: unknown) {
    this.discoveryFailures += 1;
    this.lastDiscoveryError = {
      at: (this.options.now?.() ?? new Date()).toISOString(),
      message: errorMessage(error),
    };
  }

  runOnce(): Promise<ManagedObservationAdoptionGateResult> {
    if (!this.options.enabled) return Promise.resolve({ status: "disabled" });
    if (this.inFlight) return this.inFlight;
    this.cyclesStarted += 1;
    this.lastStartedAt = (this.options.now?.() ?? new Date()).toISOString();
    const run = Promise.resolve()
      .then(() =>
        this.options.reconcile(3, [...(this.options.deviceIds ?? [])]),
      )
      .then(
        (results) => {
          this.cyclesCompleted += 1;
          this.lastCompletedAt = (
            this.options.now?.() ?? new Date()
          ).toISOString();
          const items = Array.isArray(results) ? results : [];
          const reasonCount = (
            status: "skipped" | "failed",
            reason: string,
          ) =>
            items.filter(
              (item) =>
                item &&
                typeof item === "object" &&
                "status" in item &&
                item.status === status &&
                "reasonCode" in item &&
                item.reasonCode === reason,
            ).length;
          const reasonCountsForStatus = (status: "skipped" | "failed") => {
            const counts: Record<string, number> = {};
            for (const item of items) {
              if (
                !item ||
                typeof item !== "object" ||
                !("status" in item) ||
                item.status !== status ||
                !("reasonCode" in item) ||
                typeof item.reasonCode !== "string" ||
                item.reasonCode.length === 0
              ) {
                continue;
              }
              counts[item.reasonCode] = (counts[item.reasonCode] ?? 0) + 1;
            }
            return counts;
          };
          this.lastResult = {
            total: items.length,
            adopted: items.filter(
              (item) =>
                item &&
                typeof item === "object" &&
                "status" in item &&
                item.status === "adopted",
            ).length,
            skipped: items.filter(
              (item) =>
                item &&
                typeof item === "object" &&
                "status" in item &&
                item.status === "skipped",
            ).length,
            failed: items.filter(
              (item) =>
                item &&
                typeof item === "object" &&
                "status" in item &&
                item.status === "failed",
            ).length,
            outsideAllowlist: reasonCount(
              "skipped",
              "NOT_IN_MANAGED_GATE_ALLOWLIST",
            ),
            manualActionBlocked: reasonCount("skipped", "MANUAL_ACTION_REQUIRED"),
            identityRejected: [
              "OBSERVATION_IDENTITY_AMBIGUOUS",
              "DEVICE_IDENTITY_MISMATCH",
              "ENDPOINT_OWNED_BY_ANOTHER_DEVICE",
            ].reduce(
              (total, reason) =>
                total + reasonCount("skipped", reason) + reasonCount("failed", reason),
              0,
            ),
            endpointAlreadyActive: reasonCount(
              "skipped",
              "ENDPOINT_ALREADY_ACTIVE",
            ),
            deviceBusy: reasonCount("skipped", "DEVICE_BUSY"),
            skippedReasonCounts: reasonCountsForStatus("skipped"),
            failedReasonCounts: reasonCountsForStatus("failed"),
          };
          return { status: "completed" as const, results };
        },
        (error) => {
          this.adoptionFailures += 1;
          this.lastAdoptionError = {
            at: (this.options.now?.() ?? new Date()).toISOString(),
            message: errorMessage(error),
          };
          throw error;
        },
      );
    this.inFlight = run;
    const clear = () => {
      if (this.inFlight === run) this.inFlight = undefined;
    };
    void run.then(clear, clear);
    return run;
  }

  async drain() {
    try {
      await this.inFlight;
    } catch {
      // The caller of runOnce owns error reporting; shutdown only waits for settlement.
    }
  }
}

export async function runManagedObservationCycle(options: {
  refreshObservations(): Promise<unknown>;
  adoptionGate: ManagedObservationAdoptionGate;
  onDiscoveryError(error: unknown): void;
  onAdoptionError(error: unknown): void;
}) {
  try {
    await options.refreshObservations();
  } catch (error) {
    options.adoptionGate.recordDiscoveryFailure(error);
    options.onDiscoveryError(error);
  }
  try {
    await options.adoptionGate.runOnce();
  } catch (error) {
    options.onAdoptionError(error);
  }
}
