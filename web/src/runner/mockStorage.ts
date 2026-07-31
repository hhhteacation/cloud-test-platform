import { withTaskCapabilities } from '../features/tasks/taskCapabilities'
import type { TestTask } from '../types'

export const TASKS_STORAGE_KEY = 'sdk-cloud-test-tasks'

export function readTasks(): TestTask[] {
  try {
    const value = JSON.parse(localStorage.getItem(TASKS_STORAGE_KEY) || '[]')
    return Array.isArray(value) ? value.map((task) => withTaskCapabilities(task as TestTask)) : []
  } catch {
    return []
  }
}

export function writeTasks(tasks: TestTask[]) {
  localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks.map(withTaskCapabilities)))
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
