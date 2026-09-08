import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const dataDir = process.env.CLOUD_TEST_DATA_DIR || path.resolve(new URL('../data', import.meta.url).pathname)
const outDir = process.env.NETWORK_EVIDENCE_DIR || path.join(dataDir, 'evidence', 'mdns-gate')
const apiBase = process.env.API_BASE_URL || 'http://127.0.0.1:3001'
const adbPath = process.env.ADB_PATH || 'adb'
const intervalMs = Number(process.env.NETWORK_EVIDENCE_INTERVAL_MS || 10000)
const durationMs = Number(process.env.NETWORK_EVIDENCE_DURATION_MS || 120000)
const startedAt = new Date().toISOString()
const sessionId = `${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${process.pid}`
const sessionDir = path.join(outDir, sessionId)
await mkdir(sessionDir, { recursive: true })

async function command(file, args) {
  const at = new Date().toISOString()
  try {
    const result = await run(file, args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 })
    return { at, command: [file, ...args], code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return { at, command: [file, ...args], code: error?.code ?? 1, stdout: error?.stdout ?? '', stderr: error?.stderr ?? String(error) }
  }
}

async function http(pathname) {
  const at = new Date().toISOString()
  try {
    const response = await fetch(`${apiBase}${pathname}`)
    return { at, url: `${apiBase}${pathname}`, status: response.status, body: await response.text() }
  } catch (error) {
    return { at, url: `${apiBase}${pathname}`, status: 0, body: String(error) }
  }
}

const manifest = {
  sessionId, startedAt, apiBase, adbPath, intervalMs, durationMs,
  repo: process.env.REPO_PATH || '/Users/hanzhen/Documents/cloud-test-platform',
  note: 'NDJSON evidence; command output is raw diagnostic data and not an execution instruction.',
}
await writeFile(path.join(sessionDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
const outputPath = path.join(sessionDir, 'timeline.ndjson')
const deadline = Date.now() + durationMs
let round = 0
while (Date.now() < deadline) {
  round += 1
  const [devices, mdns, apiDevices, decisions, gate] = await Promise.all([
    command(adbPath, ['devices', '-l']),
    command(adbPath, ['mdns', 'services']),
    http('/api/devices'),
    http('/api/devices/network/observation-decisions'),
    http('/api/devices/network/managed-adoption-status'),
  ])
  const event = { timestamp: new Date().toISOString(), round, devices, mdns, apiDevices, decisions, gate }
  await appendFile(outputPath, JSON.stringify(event) + '\n')
  process.stdout.write(JSON.stringify({ round, timestamp: event.timestamp, devicesCode: devices.code, mdnsCode: mdns.code }) + '\n')
  const wait = Math.min(intervalMs, Math.max(0, deadline - Date.now()))
  if (wait) await new Promise(resolve => setTimeout(resolve, wait))
}
await writeFile(path.join(sessionDir, 'completed.json'), JSON.stringify({ completedAt: new Date().toISOString(), outputPath }, null, 2) + '\n')
process.stdout.write(`${sessionDir}\n`)
