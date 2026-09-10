export const endpointHealthColumns = {
  consecutive_failures:
    "INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0)",
  next_retry_at: "TEXT",
  last_health_at: "TEXT",
} as const;
