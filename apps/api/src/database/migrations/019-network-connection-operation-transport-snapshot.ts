export const networkConnectionOperationTransportSnapshotColumns = {
  transport_type:
    "TEXT CHECK (transport_type IS NULL OR transport_type IN ('tcp_legacy', 'wireless_tls'))",
  service_instance: "TEXT",
} as const;
