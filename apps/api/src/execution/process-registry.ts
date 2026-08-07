import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** Owns cancellable process handles and cleanup state for task execution. */
export class TaskProcessRegistry {
  private readonly controllers = new Map<string, AbortController>()
  private readonly activeProcesses = new Map<string, Set<ChildProcessWithoutNullStreams>>()
  private readonly activePackages = new Map<string, string>()

  constructor(private readonly killGraceMs = 3000) {}

  begin(taskId: string, controller: AbortController, packageName: string) {
    this.controllers.set(taskId, controller)
    this.activeProcesses.set(taskId, new Set())
    this.activePackages.set(taskId, packageName)
  }

  abort(taskId: string) {
    this.controllers.get(taskId)?.abort()
  }

  killChildren(taskId: string) {
    for (const child of this.activeProcesses.get(taskId) ?? []) {
      if (child.exitCode !== null) continue
      child.kill('SIGTERM')
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, this.killGraceMs)
      timer.unref()
    }
  }

  packageName(taskId: string) {
    return this.activePackages.get(taskId)
  }

  add(taskId: string, child: ChildProcessWithoutNullStreams) {
    this.activeProcesses.get(taskId)?.add(child)
  }

  remove(taskId: string, child: ChildProcessWithoutNullStreams) {
    this.activeProcesses.get(taskId)?.delete(child)
  }

  clear(taskId: string) {
    this.controllers.delete(taskId)
    this.activeProcesses.delete(taskId)
    this.activePackages.delete(taskId)
  }
}
