// src/openqa/normalize_and_report.ts
import type { CanonicalRecord } from "./schemas.js";

import { toCanonical } from "./normalization_map.js";
import { extractMetrics } from "./extractors/text_metrics.js";
import { buildAnswerCard } from "./answer_card.js";
import { fillSlots } from "./slot_filler.js";

type ToolCall = { server: string; tool: string; args?: any };

// Results coming back from the runner; "data" may be absent on failures.
// Accept both "ms" and "elapsedMs" as timing fields.
export type ToolResultLike = {
  call: ToolCall;
  data?: any;
  ok?: boolean;
  ms?: number;
  elapsedMs?: number;
  error?: string;
};

function mapOne(r: ToolResultLike): CanonicalRecord[] {
  return toCanonical({
    server: r?.call?.server,
    tool:   r?.call?.tool,
    raw:    r?.data
  });
}

/** Flatten tool results -> canonical records, and attach extracted metrics to publications. */
export function normalize(results: ToolResultLike[]): CanonicalRecord[] {
  const records: CanonicalRecord[] = [];
  for (const r of results || []) {
    try {
      records.push(...mapOne(r));
    } catch {
      // keep going on individual mapping errors
    }
  }

  // Attach extracted metrics to publications (for PDF columns: Cutoff%, HR, Median OS/PFS)
  for (const rec of records) {
    if (rec?.kind === "Publication") {
      const title = rec.title ?? "";
      const abs   = String(rec.meta?.abstract ?? "");
      const text  = `${title}\n${abs}`;
      try {
        const extracted = extractMetrics(text);
        (rec.meta ??= {}).extracted = extracted;
      } catch {
        // ignore extractor errors
      }
    }
  }
  return records;
}

/** Produce the object used by the smoke runner / PDF (includes the Answer Card). */
export function renderAnswer(query: string, results: ToolResultLike[]) {
  const slots = fillSlots(query);
  const records = normalize(results);

  // Minimal toolsRun summary for the card footer
  const toolsRun = (results || []).map(r => ({
    server: r?.call?.server ?? "",
    tool:   r?.call?.tool ?? "",
    ok:     !!r?.ok,
    ms:     Number((r as any).ms ?? (r as any).elapsedMs ?? 0),
  }));

  const answerCard = buildAnswerCard(query, slots, records, toolsRun);

  return {
    query,
    records,
    answerCard
  };
}

