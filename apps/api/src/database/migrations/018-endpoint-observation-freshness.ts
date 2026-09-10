export const endpointObservationFreshnessColumns = {
  last_observation_at: "TEXT",
  observation_expires_at: "TEXT",
  observation_source:
    "TEXT CHECK (observation_source IS NULL OR observation_source IN ('mdns', 'adb_track'))",
} as const;
