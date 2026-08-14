import type { ArtifactRecord, ArtifactView, DeviceProfile, TestOutput } from '../types.js'

export type DatabaseRow = Record<string, unknown>

function stringValue(value: unknown) { return typeof value === 'string' ? value : '' }
function numberValue(value: unknown) { return typeof value === 'number' ? value : Number(value ?? 0) }

export function mapArtifactRow(row: DatabaseRow): ArtifactRecord {
  return {
    id: stringValue(row.id), kind: stringValue(row.kind) as ArtifactRecord['kind'],
    originalName: stringValue(row.original_name), mimeType: stringValue(row.mime_type),
    storagePath: stringValue(row.storage_path), sizeBytes: numberValue(row.size_bytes),
    sha256: stringValue(row.sha256), packageName: stringValue(row.package_name) || undefined,
    createdAt: stringValue(row.created_at),
  }
}

export function mapDeviceRow(row: DatabaseRow): DeviceProfile {
  return {
    id: stringValue(row.id),
    platform: (stringValue(row.platform) || 'android') as DeviceProfile['platform'],
    name: stringValue(row.name),
    manufacturer: stringValue(row.manufacturer),
    osVersion: stringValue(row.os_version),
    apiLevel: numberValue(row.api_level),
    architecture: stringValue(row.architecture),
    executionMode: stringValue(row.execution_mode) as DeviceProfile['executionMode'],
    eligible: numberValue(row.eligible) === 1,
    serial: stringValue(row.serial) || undefined,
    model: stringValue(row.model) || undefined,
    buildVersion: stringValue(row.build_version) || undefined,
    securityPatch: stringValue(row.security_patch) || undefined,
    registeredAt: stringValue(row.registered_at) || undefined,
    lastSeenAt: stringValue(row.last_seen_at) || undefined,
    connectionStatus: 'unknown',
  }
}

export function mapOutputRow(row: DatabaseRow): TestOutput {
  const id = stringValue(row.id)
  return {
    id, taskId: stringValue(row.task_id), deviceRunId: stringValue(row.device_run_id),
    videoRunResultId: stringValue(row.video_run_result_id) || undefined, kind: 'processed_video',
    name: stringValue(row.name), mimeType: 'video/mp4', sizeBytes: numberValue(row.size_bytes), sha256: stringValue(row.sha256),
    previewUrl: `/api/outputs/${id}/content`, downloadUrl: `/api/outputs/${id}/download`,
  }
}
