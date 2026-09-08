import type { DatabaseSync } from 'node:sqlite'

export const attemptConnectionSnapshotDefinition = {
  table: 'video_run_attempts',
  columns: ['endpoint_id', 'connection_kind', 'network_transport', 'adb_serial', 'endpoint_generation'],
} as const

export function addAttemptConnectionSnapshot(db: DatabaseSync) {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(video_run_attempts)').all() as Array<{ name: string }>)
      .map((column) => column.name),
  )
  const columns = [
    ['endpoint_id', 'TEXT'],
    ['connection_kind', 'TEXT'],
    ['network_transport', 'TEXT'],
    ['adb_serial', 'TEXT'],
    ['endpoint_generation', 'INTEGER NOT NULL DEFAULT 0 CHECK (endpoint_generation >= 0)'],
  ] as const
  for (const [name, definition] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE video_run_attempts ADD COLUMN ${name} ${definition}`)
  }
}
