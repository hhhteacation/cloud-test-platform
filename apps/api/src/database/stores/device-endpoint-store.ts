import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  DeviceConnectionKind,
  DeviceConnectionStatus,
  DeviceEndpoint,
  NetworkTransportType,
} from "../../types.js";
import { asNumber, asString, now, type Row } from "./shared.js";

export interface UpsertEndpointInput {
  deviceId: string;
  kind: DeviceConnectionKind;
  transportType?: NetworkTransportType;
  adbSerial: string;
  host?: string;
  port?: number;
  serviceInstance?: string;
  pairingState?: DeviceEndpoint["pairingState"];
  priority?: number;
  lastVerifiedAt?: string;
  lastFailureCode?: string;
  status?: DeviceConnectionStatus;
  lastError?: string;
  lastObservationAt?: string;
  observationExpiresAt?: string;
  observationSource?: 'mdns' | 'adb_track';
}

function mapEndpoint(row: Row): DeviceEndpoint {
  return {
    id: asString(row.id),
    deviceId: asString(row.device_id),
    kind: asString(row.kind) as DeviceConnectionKind,
    transportType:
      (asString(row.transport_type) as NetworkTransportType) || undefined,
    adbSerial: asString(row.adb_serial),
    host: asString(row.host) || undefined,
    port: row.port == null ? undefined : asNumber(row.port),
    serviceInstance: asString(row.service_instance) || undefined,
    pairingState:
      (asString(row.pairing_state) as DeviceEndpoint["pairingState"]) ||
      undefined,
    priority: row.priority == null ? undefined : asNumber(row.priority),
    lastVerifiedAt: asString(row.last_verified_at) || undefined,
    lastFailureCode: asString(row.last_failure_code) || undefined,
    consecutiveFailures:
      row.consecutive_failures == null ? 0 : asNumber(row.consecutive_failures),
    nextRetryAt: asString(row.next_retry_at) || undefined,
    lastHealthAt: asString(row.last_health_at) || undefined,
    status: (asString(row.status) || "unknown") as DeviceConnectionStatus,
    lastSeenAt: asString(row.last_seen_at) || undefined,
    lastError: asString(row.last_error) || undefined,
    lastObservationAt: asString(row.last_observation_at) || undefined,
    observationExpiresAt: asString(row.observation_expires_at) || undefined,
    observationSource: (asString(row.observation_source) as 'mdns' | 'adb_track') || undefined,
    supersededBy: asString(row.superseded_by) || undefined,
    isCanonical:
      row.is_canonical == null ? true : Boolean(asNumber(row.is_canonical)),
  };
}

export class DeviceEndpointStore {
  constructor(private readonly db: DatabaseSync) {}

  listForDevice(deviceId: string): DeviceEndpoint[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM device_endpoints WHERE device_id = ? AND COALESCE(is_canonical, 1) = 1 ORDER BY kind",
        )
        .all(deviceId) as Row[]
    ).map(mapEndpoint);
  }

  get(id: string): DeviceEndpoint | undefined {
    const row = this.db
      .prepare("SELECT * FROM device_endpoints WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? mapEndpoint(row) : undefined;
  }

  getByDeviceAndKind(
    deviceId: string,
    kind: DeviceConnectionKind,
  ): DeviceEndpoint | undefined {
    const row = this.db
      .prepare(
        `
      SELECT * FROM device_endpoints
      WHERE device_id = ? AND kind = ? AND COALESCE(is_canonical, 1) = 1
      ORDER BY
        CASE WHEN status = 'online' THEN 0 ELSE 1 END,
        CASE WHEN transport_type = 'wireless_tls' THEN 0 ELSE 1 END,
        COALESCE(priority, 0) DESC,
        updated_at DESC
      LIMIT 1
    `,
      )
      .get(deviceId, kind) as Row | undefined;
    return row ? mapEndpoint(row) : undefined;
  }

  getByDeviceAndTransport(
    deviceId: string,
    kind: DeviceConnectionKind,
    transportType: NetworkTransportType,
  ): DeviceEndpoint | undefined {
    const row = this.db
      .prepare(
        `
      SELECT * FROM device_endpoints
      WHERE device_id = ? AND kind = ? AND transport_type = ?
        AND COALESCE(is_canonical, 1) = 1
      ORDER BY updated_at DESC
      LIMIT 1
    `,
      )
      .get(deviceId, kind, transportType) as Row | undefined;
    return row ? mapEndpoint(row) : undefined;
  }

  getBySerial(adbSerial: string): DeviceEndpoint | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM device_endpoints WHERE adb_serial = ? AND COALESCE(is_canonical, 1) = 1",
      )
      .get(adbSerial) as Row | undefined;
    return row ? mapEndpoint(row) : undefined;
  }

  upsert(input: UpsertEndpointInput): DeviceEndpoint {
    const timestamp = now();
    const transportType =
      input.transportType ??
      (input.kind === "network" ? "tcp_legacy" : undefined);
    const existing =
      input.kind === "network" && transportType
        ? this.getByDeviceAndTransport(
            input.deviceId,
            input.kind,
            transportType,
          )
        : this.getByDeviceAndKind(input.deviceId, input.kind);
    const id = existing?.id ?? `endpoint-${randomUUID()}`;
    this.db
      .prepare(
        `
      INSERT INTO device_endpoints
        (id, device_id, kind, transport_type, adb_serial, host, port, service_instance, pairing_state, priority,
         last_verified_at, last_failure_code, consecutive_failures, next_retry_at, last_health_at,
         status, last_seen_at, last_error, last_observation_at, observation_expires_at,
         observation_source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        transport_type = excluded.transport_type,
        adb_serial = excluded.adb_serial,
        host = excluded.host,
        port = excluded.port,
        service_instance = excluded.service_instance,
        pairing_state = excluded.pairing_state,
        priority = excluded.priority,
        last_verified_at = excluded.last_verified_at,
        last_failure_code = CASE
          WHEN excluded.status = 'online' THEN NULL
          ELSE excluded.last_failure_code
        END,
        consecutive_failures = CASE
          WHEN excluded.status = 'online' THEN 0
          ELSE device_endpoints.consecutive_failures
        END,
        next_retry_at = CASE
          WHEN excluded.status = 'online' THEN NULL
          ELSE device_endpoints.next_retry_at
        END,
        last_health_at = CASE
          WHEN excluded.status = 'online'
            THEN COALESCE(excluded.last_verified_at, excluded.updated_at)
          ELSE device_endpoints.last_health_at
        END,
        status = excluded.status,
        last_seen_at = excluded.last_seen_at,
        last_error = excluded.last_error,
        last_observation_at = CASE WHEN excluded.last_observation_at IS NULL THEN device_endpoints.last_observation_at ELSE excluded.last_observation_at END,
        observation_expires_at = CASE WHEN excluded.observation_expires_at IS NULL THEN device_endpoints.observation_expires_at ELSE excluded.observation_expires_at END,
        observation_source = CASE WHEN excluded.observation_source IS NULL THEN device_endpoints.observation_source ELSE excluded.observation_source END,
        superseded_by = NULL,
        is_canonical = 1,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        id,
        input.deviceId,
        input.kind,
        transportType ?? null,
        input.adbSerial,
        input.host ?? null,
        input.port ?? null,
        input.serviceInstance ?? null,
        input.pairingState ?? null,
        input.priority ?? null,
        input.lastVerifiedAt ?? (input.status === "online" ? timestamp : null),
        input.lastFailureCode ?? null,
        0,
        null,
        input.status === "online" ? timestamp : null,
        input.status ?? "unknown",
        input.status === "online" ? timestamp : null,
        input.lastError ?? null,
        input.lastObservationAt ?? null,
        input.observationExpiresAt ?? null,
        input.observationSource ?? null,
        timestamp,
        timestamp,
      );
    return this.get(id)!;
  }

  updateObservation(id: string, input: { observedAt: string; expiresAt: string; source: 'mdns' | 'adb_track' }) {
    this.db.prepare(`
      UPDATE device_endpoints
      SET last_observation_at = ?, observation_expires_at = ?, observation_source = ?, updated_at = ?
      WHERE id = ?
    `).run(input.observedAt, input.expiresAt, input.source, now(), id)
    return this.get(id)
  }

  clearExpiredObservation(id: string, expiresAt: string) {
    this.db.prepare(`
      UPDATE device_endpoints
      SET observation_expires_at = ?, updated_at = ?
      WHERE id = ? AND (observation_expires_at IS NULL OR observation_expires_at <= ?)
    `).run(expiresAt, now(), id, expiresAt)
    return this.get(id)
  }

  updateStatus(id: string, status: DeviceConnectionStatus, lastError?: string) {
    const timestamp = now();
    this.db
      .prepare(
        `
      UPDATE device_endpoints
      SET status = ?, last_seen_at = CASE WHEN ? = 'online' THEN ? ELSE last_seen_at END,
          last_error = CASE
            WHEN ? = 'online' THEN NULL
            WHEN ? IS NULL THEN last_error
            ELSE ?
          END,
          last_failure_code = CASE WHEN ? = 'online' THEN NULL ELSE last_failure_code END,
          consecutive_failures = CASE WHEN ? = 'online' THEN 0 ELSE consecutive_failures END,
          next_retry_at = CASE WHEN ? = 'online' THEN NULL ELSE next_retry_at END,
          last_health_at = CASE WHEN ? = 'online' THEN ? ELSE last_health_at END,
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        status,
        status,
        timestamp,
        status,
        lastError ?? null,
        lastError ?? null,
        status,
        status,
        status,
        status,
        timestamp,
        timestamp,
        id,
      );
    return this.get(id);
  }

  recordHealthFailure(
    id: string,
    input: {
      failureCode: string;
      nextRetryAt?: string;
      terminal?: boolean;
      lastError?: string;
      evaluatedAt?: string;
    },
  ) {
    const evaluatedAt = input.evaluatedAt ?? now();
    this.db
      .prepare(
        `
      UPDATE device_endpoints
      SET consecutive_failures = consecutive_failures + 1,
          next_retry_at = ?, last_failure_code = ?, last_health_at = ?,
          last_error = COALESCE(?, last_error),
          status = CASE WHEN ? = 1 THEN 'offline' ELSE status END,
          updated_at = ?
      WHERE id = ? AND COALESCE(is_canonical, 1) = 1
    `,
      )
      .run(
        input.nextRetryAt ?? null,
        input.failureCode,
        evaluatedAt,
        input.lastError ?? null,
        input.terminal ? 1 : 0,
        evaluatedAt,
        id,
      );
    return this.get(id);
  }

  recordHealthSuccess(id: string, evaluatedAt = now()) {
    this.db
      .prepare(
        `
      UPDATE device_endpoints
      SET status = 'online', last_verified_at = ?, last_seen_at = ?,
          last_failure_code = NULL, consecutive_failures = 0,
          next_retry_at = NULL, last_health_at = ?, last_error = NULL,
          updated_at = ?
      WHERE id = ? AND COALESCE(is_canonical, 1) = 1
    `,
      )
      .run(evaluatedAt, evaluatedAt, evaluatedAt, evaluatedAt, id);
    return this.get(id);
  }

  remove(id: string) {
    return (
      this.db.prepare("DELETE FROM device_endpoints WHERE id = ?").run(id)
        .changes === 1
    );
  }
}
