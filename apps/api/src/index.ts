import { config } from './config.js'
import { buildServer } from './server.js'

try {
  const server = await buildServer({ config })
  await server.listen({ host: config.host, port: config.port })
  server.log.info({ host: config.host, port: config.port }, 'Phase 0 本机单用户模式已启动')
} catch (error) {
  console.error(`服务启动失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
