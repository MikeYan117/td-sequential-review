// Stand-in for the host service's push task: only the constant the insight snapshot reads.
// The live service refreshes each symbol this long after a 5m bar closes.
export const TICK_OFFSET_MS = 10_000;
