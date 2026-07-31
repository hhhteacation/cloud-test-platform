import { config } from './config.js'
import { buildServer } from './server.js'

const server = await buildServer()

try {
  await server.listen({ host: config.host, port: config.port })
} catch (error) {
  server.log.error(error)
  process.exitCode = 1
}
