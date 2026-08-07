import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import { QueueNotAcceptingError } from '../queue.js'
import type { TaskService } from '../tasks/task-service.js'
import { registerTaskRoutes } from './task-routes.js'

describe('task routes', () => {
  it('服务关闭期间创建任务返回 503', async () => {
    const app = Fastify()
    registerTaskRoutes(app, {
      async create() { throw new QueueNotAcceptingError() },
      list() { return [] },
      get() { return undefined },
      cancel() { return undefined },
      report() { return undefined },
    } as unknown as TaskService)

    const response = await app.inject({ method: 'POST', url: '/api/tasks', payload: {} })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ code: 'QUEUE_NOT_ACCEPTING' })
    await app.close()
  })
})
