export const taskIdempotencyMigration = `
  CREATE TABLE IF NOT EXISTS task_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    request_fingerprint TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
`
