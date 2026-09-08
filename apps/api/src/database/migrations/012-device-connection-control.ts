export const deviceConnectionControlMigration = `
  CREATE TABLE IF NOT EXISTS device_connection_state (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    management_mode TEXT NOT NULL DEFAULT 'manual'
      CHECK (management_mode IN ('manual', 'shadow', 'managed')),
    desired_network_state TEXT NOT NULL DEFAULT 'disconnected'
      CHECK (desired_network_state IN ('disconnected', 'connected')),
    observed_network_state TEXT NOT NULL DEFAULT 'offline'
      CHECK (observed_network_state IN (
        'offline', 'discovered', 'connecting', 'verifying', 'online',
        'degraded', 'recovering', 'manual_action'
      )),
    active_endpoint_id TEXT REFERENCES device_endpoints(id) ON DELETE SET NULL,
    connection_generation INTEGER NOT NULL DEFAULT 0 CHECK (connection_generation >= 0),
    operation_id TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    next_retry_at TEXT,
    deadline_at TEXT,
    reason_code TEXT,
    action_required TEXT,
    last_health_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS device_connection_state_observed_idx
    ON device_connection_state(observed_network_state);
  CREATE INDEX IF NOT EXISTS device_connection_state_retry_idx
    ON device_connection_state(next_retry_at);

  CREATE TABLE IF NOT EXISTS connection_events (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    operation_id TEXT,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    event_type TEXT NOT NULL,
    source TEXT NOT NULL,
    transport_type TEXT,
    endpoint_summary TEXT,
    result TEXT NOT NULL,
    failure_code TEXT,
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS connection_events_device_created_idx
    ON connection_events(device_id, created_at);
  CREATE INDEX IF NOT EXISTS connection_events_operation_idx
    ON connection_events(operation_id);

  INSERT OR IGNORE INTO device_connection_state (
    device_id, management_mode, desired_network_state, observed_network_state,
    connection_generation, retry_count, consecutive_failures, updated_at
  )
  SELECT id, 'manual', 'disconnected', 'offline', 0, 0, 0,
         COALESCE(last_seen_at, registered_at, CURRENT_TIMESTAMP)
  FROM devices;
`
