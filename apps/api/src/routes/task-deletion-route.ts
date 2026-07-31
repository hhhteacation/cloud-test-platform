import type { FastifyInstance } from 'fastify'

import { TaskDeletionError } from '../task-deletion.js'
import type { TaskDeletionReceipt } from '../types.js'

/**
 * 删除模块在 HTTP 层暴露的最小接口。
 * 路由只做协议转换，不知道数据库、事务或磁盘目录的实现细节。
 */
export interface TaskDeletionModule {
  deleteTask(taskId: string): Promise<TaskDeletionReceipt>
}

export function registerTaskDeletionRoute(
  app: FastifyInstance,
  deletionModule: TaskDeletionModule,
) {
  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    try {
      return await deletionModule.deleteTask(request.params.id)
    } catch (error) {
      if (error instanceof TaskDeletionError) {
        return reply.code(error.statusCode).send({ code: error.code, message: error.message })
      }

      request.log.error(error)
      return reply.code(500).send({
        code: 'TASK_DELETE_FAILED',
        message: '删除测试任务失败',
      })
    }
  })
}
