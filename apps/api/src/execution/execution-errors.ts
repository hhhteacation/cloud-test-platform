/** Stable error boundary between the executor and the task/report layer. */
export class TaskExecutionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'TaskExecutionError'
  }
}
