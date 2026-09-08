export const networkTransportMetadataMigration = {
  transport_type: "TEXT CHECK (transport_type IS NULL OR transport_type IN ('tcp_legacy', 'wireless_tls'))",
  service_instance: 'TEXT',
  pairing_state: "TEXT CHECK (pairing_state IS NULL OR pairing_state IN ('unknown', 'pairing_required', 'observed_working', 'repair_required'))",
  priority: 'INTEGER',
  last_verified_at: 'TEXT',
  last_failure_code: 'TEXT',
} as const
