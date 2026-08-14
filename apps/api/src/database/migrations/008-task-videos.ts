export const taskVideosMigration = `
  CREATE TABLE IF NOT EXISTS task_videos (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(task_id, sequence),
    UNIQUE(task_id, artifact_id)
  );

  CREATE INDEX IF NOT EXISTS task_videos_task_sequence_idx
  ON task_videos(task_id, sequence);

  INSERT OR IGNORE INTO task_videos (
    id, task_id, artifact_id, sequence, display_name, created_at
  )
  SELECT
    'task-video-legacy-' || tasks.id,
    tasks.id,
    tasks.video_artifact_id,
    0,
    artifacts.original_name,
    tasks.created_at
  FROM tasks
  JOIN artifacts ON artifacts.id = tasks.video_artifact_id;
`
