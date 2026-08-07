import { readdir, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const configuredDataDir = process.env.CLOUD_TEST_DATA_DIR?.trim()
if (configuredDataDir && !path.isAbsolute(configuredDataDir)) throw new Error('CLOUD_TEST_DATA_DIR 必须是绝对路径')
const dataDir = path.normalize(configuredDataDir || path.join(rootDir, 'data'))
const artifactsDir = path.join(dataDir, 'artifacts')
const databasePath = path.join(dataDir, 'cloud-test.sqlite')

try {
  await stat(databasePath)
  await stat(artifactsDir)
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    console.log(JSON.stringify({ dataDir, orphanDirectories: [], note: '数据目录尚未初始化' }, null, 2))
    process.exit(0)
  }
  throw error
}

const db = new DatabaseSync(databasePath, { readOnly: true })
try {
  const known = new Set(db.prepare('SELECT storage_path FROM artifacts').all().map((row) => path.resolve(String(row.storage_path))))
  const entries = await readdir(artifactsDir, { withFileTypes: true })
  const orphanDirectories = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('store-'))
    .map((entry) => path.join(artifactsDir, entry.name))
    .filter((directory) => !known.has(path.resolve(directory)))
  console.log(JSON.stringify({ dataDir, orphanDirectories, count: orphanDirectories.length, note: '只报告，不自动删除。确认数据库和备份后再人工清理。' }, null, 2))
} finally {
  db.close()
}
