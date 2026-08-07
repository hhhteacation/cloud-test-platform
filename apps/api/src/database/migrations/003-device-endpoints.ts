export const deviceEndpointsMigration = `
  CREATE TABLE IF NOT EXISTS device_endpoints (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('usb', 'network')),
    adb_serial TEXT NOT NULL,
    host TEXT,
    port INTEGER,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_seen_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(device_id, kind),
    UNIQUE(adb_serial)
  );
  CREATE INDEX IF NOT EXISTS device_endpoints_device_idx ON device_endpoints(device_id);
  CREATE INDEX IF NOT EXISTS device_endpoints_status_idx ON device_endpoints(status);
`
