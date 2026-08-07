export const taskExecutionEndpointColumns = {
  tasks: [
    ['connection_mode', "TEXT NOT NULL DEFAULT 'auto'"],
  ],
  device_runs: [
    ['endpoint_id', 'TEXT'],
    ['connection_kind', 'TEXT'],
    ['adb_serial', 'TEXT'],
  ],
} as const
