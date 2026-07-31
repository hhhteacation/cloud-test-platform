import { randomUUID } from 'node:crypto'
import { cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

const rootDir = process.cwd()
const dataDir = path.resolve(process.env.CLOUD_TEST_DATA_DIR ?? path.join(rootDir, 'data'))
const databasePath = path.join(dataDir, 'cloud-test.sqlite')
const backupsDir = path.join(dataDir, 'backups')
const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const backupName = `cloud-test-${timestamp}`
const temporaryDir = path.join(backupsDir, `.incomplete-${backupName}-${randomUUID()}`)
const finalDir = path.join(backupsDir, backupName)

async function copyDirectoryIfPresent(name) {
  const source = path.join(dataDir, name)
  try {
    const sourceStat = await stat(source)
    if (!sourceStat.isDirectory()) throw new Error(`${source} 不是目录`)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }

  await cp(source, path.join(temporaryDir, name), {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  })
  return true
}

function readTableCounts(db) {
  const expectedTables = [
    'devices',
    'artifacts',
    'tasks',
    'device_runs',
    'check_results',
    'task_logs',
    'task_outputs',
    'task_deletion_audits',
  ]
  const existingTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)),
  )

  return Object.fromEntries(expectedTables
    .filter((name) => existingTables.has(name))
    .map((name) => [name, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count)]))
}

let sourceDatabase
try {
  await mkdir(backupsDir, { recursive: true })
  await mkdir(temporaryDir, { recursive: false })
  sourceDatabase = new DatabaseSync(databasePath, { readOnly: true })
  sourceDatabase.exec('PRAGMA foreign_keys = ON')

  const tableCounts = readTableCounts(sourceDatabase)
  await backup(sourceDatabase, path.join(temporaryDir, 'cloud-test.sqlite'))
  const copiedDirectories = {
    artifacts: await copyDirectoryIfPresent('artifacts'),
    tasks: await copyDirectoryIfPresent('tasks'),
  }

  await writeFile(
    path.join(temporaryDir, 'manifest.json'),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      sourceDataDir: dataDir,
      databaseFile: 'cloud-test.sqlite',
      copiedDirectories,
      tableCounts,
      note: 'SQLite 使用在线 backup API 生成；该备份不依赖源数据库 WAL/SHM 文件。',
    }, null, 2),
  )

  sourceDatabase.close()
  sourceDatabase = undefined
  await rename(temporaryDir, finalDir)
  process.stdout.write(`备份完成：${finalDir}\n`)
} catch (error) {
  try {
    sourceDatabase?.close()
  } catch {
    // 保留原始备份异常。
  }
  await rm(temporaryDir, { recursive: true, force: true })
  throw error
}
