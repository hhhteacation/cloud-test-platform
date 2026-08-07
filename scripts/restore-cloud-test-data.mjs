import { cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const [backupArgument, targetArgument] = process.argv.slice(2)
if (!backupArgument || backupArgument === '--help' || backupArgument === '-h') {
  console.log('用法：node scripts/restore-cloud-test-data.mjs <备份目录> <绝对目标数据目录>')
  console.log('示例：node scripts/restore-cloud-test-data.mjs data/backups/cloud-test-... /tmp/cloud-test-restored')
  process.exit(backupArgument ? 0 : 1)
}
if (!targetArgument || !path.isAbsolute(targetArgument)) {
  throw new Error('恢复目标必须显式提供绝对路径；为避免误覆盖，不支持直接恢复到当前 data/ 目录')
}

const backupDir = path.resolve(rootDir, backupArgument)
const targetDir = path.normalize(targetArgument)
if (path.resolve(backupDir) === path.resolve(targetDir)) throw new Error('备份目录和恢复目标不能相同')
const manifestPath = path.join(backupDir, 'manifest.json')
const sourceDatabasePath = path.join(backupDir, 'cloud-test.sqlite')

async function exists(filePath) {
  try { await stat(filePath); return true } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function assertTargetIsSafe() {
  if (!(await exists(targetDir))) return
  const entries = await readdir(targetDir)
  if (entries.length > 0) throw new Error(`恢复目标不是空目录，拒绝覆盖：${targetDir}`)
}

if (!(await exists(manifestPath)) || !(await exists(sourceDatabasePath))) {
  throw new Error(`备份目录不完整，必须包含 manifest.json 和 cloud-test.sqlite：${backupDir}`)
}
await assertTargetIsSafe()

const sourceDb = new DatabaseSync(sourceDatabasePath, { readOnly: true })
try {
  const required = ['devices', 'artifacts', 'tasks', 'device_runs']
  const tables = new Set(sourceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)))
  const missing = required.filter((table) => !tables.has(table))
  if (missing.length) throw new Error(`备份数据库缺少必要表：${missing.join(', ')}`)
} finally {
  sourceDb.close()
}

const temporaryDir = path.join(path.dirname(targetDir), `.restore-${path.basename(targetDir)}-${os.tmpdir().split('/').pop()}-${Date.now()}`)
try {
  await mkdir(path.dirname(targetDir), { recursive: true })
  await mkdir(temporaryDir, { recursive: false })
  await cp(sourceDatabasePath, path.join(temporaryDir, 'cloud-test.sqlite'))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const name of ['artifacts', 'tasks']) {
    if (manifest.copiedDirectories?.[name] && await exists(path.join(backupDir, name))) {
      await cp(path.join(backupDir, name), path.join(temporaryDir, name), { recursive: true })
    }
  }
  await rename(temporaryDir, targetDir)
  console.log(`恢复完成：${targetDir}`)
  console.log('建议：先用该目录启动一次并运行 pnpm test，再决定是否替换正式数据目录。')
} catch (error) {
  await rm(temporaryDir, { recursive: true, force: true })
  throw error
}
