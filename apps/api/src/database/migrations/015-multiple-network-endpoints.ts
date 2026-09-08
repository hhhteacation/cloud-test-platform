export const multipleNetworkEndpointsMigration = `
  PRAGMA foreign_keys = OFF;

  CREATE TABLE device_endpoints_v2 (
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
    UNIQUE(adb_serial),
    UNIQUE(device_id, kind, transport_type, adb_serial)
  );

  INSERT INTO device_endpoints_v2 (
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
  ALTER TABLE device_endpoints_v2 RENAME TO device_endpoints;
  CREATE INDEX device_endpoints_device_idx ON device_endpoints(device_id);
  CREATE INDEX device_endpoints_status_idx ON device_endpoints(status);
  CREATE INDEX device_endpoints_transport_idx ON device_endpoints(device_id, kind, transport_type, status);

  PRAGMA foreign_keys = ON;
`
