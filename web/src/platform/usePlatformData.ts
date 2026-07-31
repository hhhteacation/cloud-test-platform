import { useCallback, useEffect, useState } from 'react'

import type { DeviceProfile, TestTask } from '../types'
import { platformClient } from './client'

export function usePlatformTasks(pollActive = false) {
  const [tasks, setTasks] = useState<TestTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const reload = useCallback(async () => {
    try {
      setError(undefined)
      setTasks(await platformClient.listTasks())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '任务加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    if (!pollActive) return
    const timer = window.setInterval(() => void reload(), 2000)
    return () => window.clearInterval(timer)
  }, [pollActive, reload])

  return { tasks, loading, error, reload }
}

export function usePlatformDevices() {
  const [devices, setDevices] = useState<DeviceProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const reload = useCallback(async () => {
    try {
      setError(undefined)
      setDevices(await platformClient.listDevices())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '设备加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { devices, loading, error, reload }
}
