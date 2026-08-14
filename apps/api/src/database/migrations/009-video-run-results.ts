import type { DatabaseSync } from 'node:sqlite'

export const videoRunResultsDefinition = {
  creates: ['video_run_results', 'video_run_attempts'],
  scopes: ['task_outputs.video_run_result_id', 'check_results.video_run_result_id', 'task_logs.video_run_result_id'],
  backfills: ['legacy device run to one video run result', 'legacy outputs and checks to the backfilled video result'],
} as const

function columns(db: DatabaseSync, table: string) {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  )
}

function addColumnIfMissing(db: DatabaseSync, table: string, name: string, definition: string) {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
}

export function migrateVideoRunResults(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_run_results (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      task_video_id TEXT NOT NULL REFERENCES task_videos(id) ON DELETE CASCADE,
      device_run_id TEXT NOT NULL REFERENCES device_runs(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      phase TEXT,
      progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
      failure_code TEXT,
      failure_message TEXT,
      execution_status TEXT,
      execution_failure_code TEXT,
      execution_failure_json TEXT,
      started_at TEXT,
      finished_at TEXT,
      media_integrity_status TEXT NOT NULL DEFAULT 'not_checked',
      media_integrity_failure_code TEXT,
      media_metadata TEXT,
      UNIQUE(task_video_id, device_run_id)
    );

    CREATE INDEX IF NOT EXISTS video_run_results_task_video_idx
    ON video_run_results(task_id, task_video_id);

    CREATE INDEX IF NOT EXISTS video_run_results_device_run_idx
    ON video_run_results(device_run_id);

    INSERT OR IGNORE INTO video_run_results (
      id, task_id, task_video_id, device_run_id, status, phase, progress,
      failure_code, failure_message, execution_status, execution_failure_code,
      execution_failure_json, started_at, finished_at, media_integrity_status,
      media_integrity_failure_code, media_metadata
    )
    SELECT
      'video-run-legacy-' || device_runs.id,
      device_runs.task_id,
      task_videos.id,
      device_runs.id,
      device_runs.status,
      device_runs.phase,
      device_runs.progress,
      device_runs.failure_code,
      device_runs.failure_message,
      device_runs.execution_status,
      device_runs.execution_failure_code,
      device_runs.execution_failure_json,
      device_runs.started_at,
      device_runs.finished_at,
      COALESCE(device_runs.media_integrity_status, 'not_checked'),
      device_runs.media_integrity_failure_code,
      device_runs.media_metadata
    FROM device_runs
    JOIN task_videos
      ON task_videos.task_id = device_runs.task_id
     AND task_videos.sequence = 0;

    CREATE TABLE IF NOT EXISTS video_run_attempts (
      id TEXT PRIMARY KEY,
      video_run_result_id TEXT NOT NULL REFERENCES video_run_results(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      status TEXT NOT NULL,
      failure_code TEXT,
      failure_message TEXT,
      execution_failure_json TEXT,
      evidence_directory TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(video_run_result_id, attempt_number)
    );

    CREATE INDEX IF NOT EXISTS video_run_attempts_result_idx
    ON video_run_attempts(video_run_result_id, attempt_number);

    INSERT OR IGNORE INTO video_run_attempts (
      id, video_run_result_id, attempt_number, status,
      failure_code, failure_message, execution_failure_json,
      started_at, finished_at, created_at
    )
    SELECT
      'video-attempt-legacy-' || video_run_results.id,
      video_run_results.id,
      1,
      video_run_results.status,
      video_run_results.failure_code,
      video_run_results.failure_message,
      video_run_results.execution_failure_json,
      video_run_results.started_at,
      video_run_results.finished_at,
      COALESCE(video_run_results.started_at, tasks.created_at)
    FROM video_run_results
    JOIN tasks ON tasks.id = video_run_results.task_id
    WHERE video_run_results.status <> 'queued';
  `)

  addColumnIfMissing(
    db,
    'task_outputs',
    'video_run_result_id',
    'TEXT REFERENCES video_run_results(id) ON DELETE CASCADE',
  )
  addColumnIfMissing(
    db,
    'task_logs',
    'video_run_result_id',
    'TEXT REFERENCES video_run_results(id) ON DELETE CASCADE',
  )

  db.exec(`
    UPDATE task_outputs
    SET video_run_result_id = (
      SELECT video_run_results.id
      FROM video_run_results
      WHERE video_run_results.device_run_id = task_outputs.device_run_id
      ORDER BY video_run_results.id
      LIMIT 1
    )
    WHERE video_run_result_id IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS task_outputs_primary_video_unique
    ON task_outputs(video_run_result_id, kind)
    WHERE video_run_result_id IS NOT NULL AND kind = 'processed_video';

    CREATE INDEX IF NOT EXISTS task_logs_video_run_result_idx
    ON task_logs(video_run_result_id, id);
  `)

  if (!columns(db, 'check_results').has('video_run_result_id')) {
    db.exec(`
      CREATE TABLE check_results_v2 (
        id TEXT PRIMARY KEY,
        device_run_id TEXT NOT NULL REFERENCES device_runs(id) ON DELETE CASCADE,
        video_run_result_id TEXT REFERENCES video_run_results(id) ON DELETE CASCADE,
        check_key TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        message TEXT,
        updated_at TEXT NOT NULL
      );

      INSERT INTO check_results_v2 (
        id, device_run_id, video_run_result_id, check_key,
        name, status, duration_ms, message, updated_at
      )
      SELECT
        check_results.id,
        check_results.device_run_id,
        (
          SELECT video_run_results.id
          FROM video_run_results
          WHERE video_run_results.device_run_id = check_results.device_run_id
          ORDER BY video_run_results.id
          LIMIT 1
        ),
        check_results.check_key,
        check_results.name,
        check_results.status,
        check_results.duration_ms,
        check_results.message,
        check_results.updated_at
      FROM check_results;

      DROP TABLE check_results;
      ALTER TABLE check_results_v2 RENAME TO check_results;
    `)
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS check_results_device_scope_unique
    ON check_results(device_run_id, check_key)
    WHERE video_run_result_id IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS check_results_video_scope_unique
    ON check_results(video_run_result_id, check_key)
    WHERE video_run_result_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS check_results_device_run_idx
    ON check_results(device_run_id);
  `)
}
