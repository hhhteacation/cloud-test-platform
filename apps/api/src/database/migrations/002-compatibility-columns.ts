export const compatibilityColumns = {
  devices: [
    ['platform', "TEXT NOT NULL DEFAULT 'android'"],
    ['model', 'TEXT'],
    ['build_version', 'TEXT'],
    ['security_patch', 'TEXT'],
    ['registered_at', 'TEXT'],
    ['last_seen_at', 'TEXT'],
  ],
  tasks: [
    ['platform', "TEXT NOT NULL DEFAULT 'android'"],
  ],
  device_runs: [
    ['execution_status', 'TEXT'],
    ['execution_failure_code', 'TEXT'],
    ['media_integrity_status', 'TEXT'],
    ['media_integrity_failure_code', 'TEXT'],
    ['media_metadata', 'TEXT'],
  ],
} as const
