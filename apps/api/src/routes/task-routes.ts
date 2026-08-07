import type { FastifyInstance, FastifyReply } from 'fastify'

import { QueueNotAcceptingError } from '../queue.js'
import { InsufficientDiskSpaceError } from '../storage-health.js'
import { TaskRequestError, type CreateTaskCommand, type TaskService } from '../tasks/task-service.js'

function taskError(error: unknown, reply: FastifyReply) {
  if (error instanceof TaskRequestError) return reply.code(error.statusCode).send({ code: error.code, message: error.message })
  if (error instanceof InsufficientDiskSpaceError) return reply.code(507).send({ code: error.code, message: error.message })
  if (error instanceof QueueNotAcceptingError) return reply.code(503).send({ code: error.code, message: error.message })
  throw error
}

export function registerTaskRoutes(app: FastifyInstance, tasks: TaskService) {
  app.post<{ Body: CreateTaskCommand }>('/api/tasks', async (request, reply) => {
    try { return reply.code(201).send(await tasks.create(request.body ?? {})) } catch (error) { return taskError(error, reply) }
  })
  app.get('/api/tasks', async () => tasks.list())
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => (
    tasks.get(request.params.id) ?? reply.code(404).send({ code: 'TASK_NOT_FOUND', message: '测试任务不存在' })
  ))
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (request, reply) => {
    try { return reply.code(202).send(tasks.cancel(request.params.id)) } catch (error) { return taskError(error, reply) }
  })
  app.get<{ Params: { id: string } }>('/api/tasks/:id/report', async (request, reply) => (
    tasks.report(request.params.id) ?? reply.code(404).send({ code: 'TASK_NOT_FOUND', message: '测试任务不存在' })
  ))
}
