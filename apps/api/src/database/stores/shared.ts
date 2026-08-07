import type { DatabaseRow } from '../mappers.js'

export type Row = DatabaseRow
export const now = () => new Date().toISOString()
export const asString = (value: unknown) => typeof value === 'string' ? value : ''
export const asNumber = (value: unknown) => typeof value === 'number' ? value : Number(value ?? 0)
