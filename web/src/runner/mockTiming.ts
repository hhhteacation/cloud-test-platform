/** Timing knobs for the browser-only runner. Keeping them in one module makes
 * the demo predictable and lets tests or a future demo plan replace them. */
export const MOCK_TIMING = {
  runningStartMs: 350,
  firstCheckMs: 700,
  checkIntervalMs: 230,
} as const
