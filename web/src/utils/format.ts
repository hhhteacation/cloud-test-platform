const BYTE_UNITS = ['B', 'KB', 'MB', 'GB']

export function formatBytes(bytes: number) {
  if (!bytes) {
    return '0 B'
  }

  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  )

  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex ? 1 : 0)} ${BYTE_UNITS[unitIndex]}`
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}
