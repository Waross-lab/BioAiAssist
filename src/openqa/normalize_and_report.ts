// src/openqa/normalize_and_report.ts
import type { ToolResult } from "./runner.js";
import { toCanonical } from "./normalization_map.js";
import { buildAnswerCard } from "./answer_card.js";
import { fillSlots } from "./slot_filler.js";
import type { AnswerCard } from "./schemas.js";

// Flatten tool results into canonical records
export function normalize(results: ToolResult[]) {
  const out: any[] = [];
  for (const r of results) {
    if (!r.ok) continue;
    const prov = { server: r.call.server, tool: r.call.tool, args: r.call.args };
    const mapped = toCanonical(r.call.server, r.call.tool, r.data, r.call.args);
    for (const m of mapped) out.push(m);
  }
  return out;
}

// Legacy summary (kept for compatibility)
export function renderAnswer(query: string, results: ToolResult[]) {
  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  return {
    query,
    hits: ok.length,
    failures: failed.map(f => ({ server: f.call.server, tool: f.call.tool, error: f.error })),
    summary: `Collected ${ok.length} tool results; ${failed.length} failed.`,
    records: normalize(ok),
  };
}

// NEW: rich AnswerCard alongside legacy
export function renderAnswerCard(
  query: string,
  results: ToolResult[]
): { card: AnswerCard; legacy: any } {
  const legacy = renderAnswer(query, results);
  const toolsRun = results.map(r => ({
    server: r.call.server,
    tool: r.call.tool,
    ok: r.ok,
    ms: r.elapsedMs,
  }));
  const slots = fillSlots(query);
  const card = buildAnswerCard(query, slots, legacy.records, toolsRun);
  return { card, legacy };
}
