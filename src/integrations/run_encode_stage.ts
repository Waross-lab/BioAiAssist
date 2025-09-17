// src/integrations/run_encode_stage.ts
// Wires ENCODE into your orchestrator using the helper functions.
// Call this once during your fetch/normalize stages.

import { makeEncodeQuery, fetchEncode, normalizeEncode, encodeRowMatchesOrganism } from "./encode_helpers.js";

export type TimedFn = <T = any>(
  source: "ENCODE",
  params: Record<string, any>,
  fn: () => Promise<T[]>
) => Promise<T[]>;

/**
 * Execute the ENCODE stage:
 * 1) Build query from tokens + organism
 * 2) Fetch rows via adapter (wrapped in your timed provenance)
 * 3) Organism-filter
 * 4) Normalize -> lightweight targets + assays
 */
export async function runEncodeStage(opts: {
  tokens: string[];
  organism: string;
  maxPerSource: number;
  raw: Record<string, any[]>;
  timed: TimedFn;
}): Promise<{ targets: any[]; assays: any[] }> {
  const { tokens, organism, maxPerSource, raw, timed } = opts;

  // 1) Query
  const q = makeEncodeQuery(tokens, organism, maxPerSource);

  // 2) Fetch (provenance via timed)
  const rows = await timed("ENCODE", q, () => fetchEncode(q));

  // 3) Organism filter (ENCODE-specific shape)
  const filtered = rows.filter((r) => encodeRowMatchesOrganism(r, organism));
  raw["ENCODE"] = filtered;

  // 4) Normalize
  const { targets, assays } = normalizeEncode(filtered, organism);
  return { targets, assays };
}
