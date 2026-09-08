import type { DatabaseSync } from "node:sqlite";

/**
 * Migration 013 made adb_serial globally unique. That is not a Physical
 * Device identity: the same device may expose a USB serial, tcp:5555 and a
 * Wireless TLS serial, and the TLS port can change. Migration 014 keeps every
 * historical row for audit/snapshot references, but marks one row per logical
 * (device, kind, transport) key as canonical for current lookups.
 */
export const endpointLogicalIdentityMigration = `
  PRAGMA foreign_keys = OFF;

  CREATE TABLE device_endpoints_v3 (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('usb', 'network')),
    transport_type TEXT CHECK (transport_type IS NULL OR transport_type IN ('tcp_legacy', 'wireless_tls')),
    adb_serial TEXT NOT NULL,
    host TEXT,
    port INTEGER,
    service_instance TEXT,
    pairing_state TEXT CHECK (pairing_state IS NULL OR pairing_state IN ('unknown', 'pairing_required', 'observed_working', 'repair_required')),
    priority INTEGER,
    last_verified_at TEXT,
    last_failure_code TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_seen_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    superseded_by TEXT,
    is_canonical INTEGER NOT NULL DEFAULT 1 CHECK (is_canonical IN (0, 1))
  );

  INSERT INTO device_endpoints_v3 (
    id, device_id, kind, transport_type, adb_serial, host, port, service_instance,
    pairing_state, priority, last_verified_at, last_failure_code, status,
    last_seen_at, last_error, created_at, updated_at
  )
  SELECT id, device_id, kind,
    CASE WHEN kind = 'network' THEN COALESCE(transport_type, 'tcp_legacy') ELSE NULL END,
    adb_serial, host, port, service_instance, pairing_state, priority,
    last_verified_at, last_failure_code, status, last_seen_at, last_error,
    created_at, updated_at
  FROM device_endpoints;

  DROP TABLE device_endpoints;
  ALTER TABLE device_endpoints_v3 RENAME TO device_endpoints;

  CREATE INDEX device_endpoints_device_idx ON device_endpoints(device_id);
  CREATE INDEX device_endpoints_status_idx ON device_endpoints(status);
  CREATE INDEX device_endpoints_transport_idx ON device_endpoints(device_id, kind, transport_type, status);
  PRAGMA foreign_keys = ON;
`;

interface EndpointRow {
  id: string;
  device_id: string;
  kind: "usb" | "network";
  transport_type: "tcp_legacy" | "wireless_tls" | null;
  status: string;
  last_verified_at: string | null;
  last_seen_at: string | null;
  updated_at: string;
  created_at: string;
}

function endpointGroup(row: EndpointRow) {
  return row.kind === "network"
    ? `${row.device_id}\u0000network\u0000${row.transport_type ?? "tcp_legacy"}`
    : `${row.device_id}\u0000usb`;
}

function timestampRank(value: string | null | undefined) {
  return value ? Date.parse(value) || 0 : 0;
}

export function repairEndpointLogicalIdentity(db: DatabaseSync) {
  const activeIds = new Set(
    (
      db
        .prepare(
          "SELECT active_endpoint_id FROM device_connection_state WHERE active_endpoint_id IS NOT NULL",
        )
        .all() as Array<{ active_endpoint_id: string }>
    ).map((row) => row.active_endpoint_id),
  );
  const rows = db
    .prepare(
      `
    SELECT id, device_id, kind, transport_type, status, last_verified_at,
           last_seen_at, updated_at, created_at
    FROM device_endpoints
    ORDER BY device_id, kind, transport_type, updated_at DESC, id
  `,
    )
    .all() as unknown as EndpointRow[];
  const groups = new Map<string, EndpointRow[]>();
  for (const row of rows) {
    const group = groups.get(endpointGroup(row)) ?? [];
    group.push(row);
    groups.set(endpointGroup(row), group);
  }

  const markCanonical = db.prepare(
    "UPDATE device_endpoints SET is_canonical = 1, superseded_by = NULL WHERE id = ?",
  );
  const markHistorical = db.prepare(
    "UPDATE device_endpoints SET is_canonical = 0, superseded_by = ? WHERE id = ?",
  );
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const activeRank =
        Number(activeIds.has(b.id)) - Number(activeIds.has(a.id));
      if (activeRank) return activeRank;
      const verifiedRank =
        timestampRank(b.last_verified_at) - timestampRank(a.last_verified_at);
      if (verifiedRank) return verifiedRank;
      const seenRank =
        timestampRank(b.last_seen_at) - timestampRank(a.last_seen_at);
      if (seenRank) return seenRank;
      const createdRank =
        timestampRank(b.created_at) - timestampRank(a.created_at);
      if (createdRank) return createdRank;
      return a.id.localeCompare(b.id);
    });
    const canonical = group[0];
    if (!canonical) continue;
    markCanonical.run(canonical.id);
    for (const historical of group.slice(1))
      markHistorical.run(canonical.id, historical.id);
  }
  db.exec(`
    CREATE UNIQUE INDEX device_endpoints_network_logical_unique
      ON device_endpoints(device_id, kind, transport_type)
      WHERE kind = 'network' AND is_canonical = 1;
    CREATE UNIQUE INDEX device_endpoints_usb_logical_unique
      ON device_endpoints(device_id, kind)
      WHERE kind = 'usb' AND is_canonical = 1;
  `);
}

export function migrateEndpointLogicalIdentity(db: DatabaseSync) {
  db.exec(endpointLogicalIdentityMigration);
  repairEndpointLogicalIdentity(db);
}
