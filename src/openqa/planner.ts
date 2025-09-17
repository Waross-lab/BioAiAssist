// src/openqa/planner.ts
import type { QueryPlan } from "./types.js";
import { fillSlots } from "./slot_filler.js";
import { buildEuropePmcQuery } from "./query_builders/literature.js";
import { buildCtgovExpr } from "./clients/trials.js";

export async function planFromQuery(query: string): Promise<QueryPlan> {
  const slots = fillSlots(query);

  const plan: QueryPlan = {
    rationale: "heuristic-routing v2: literature + trials when disease+drug or trial hints",
    calls: []
  };

  // --- Literature (Europe PMC) ---
  plan.calls.push({
    server: "europmc",
    tool: "search_publications",
    args: { query: buildEuropePmcQuery(slots, query), size: 25 },
    parallelGroup: "default"
  });

  // --- Trials (ClinicalTrials.gov) ---
  const wantTrials =
    /clinical trial|nct\d+/i.test(query) ||
    /(?:^|\s)trial(?:s)?\b|phase\s*(?:i{1,3}|iv|[1-4])/i.test(query) ||
    ((slots.diseases?.length ?? 0) > 0 && (slots.drugs?.length ?? 0) > 0);

  if (wantTrials) {
    plan.calls.push({
      server: "ctgov",
      tool: "search_trials",
      args: {
        expr: buildCtgovExpr(slots, query),
        status: ["RECRUITING","NOT_YET_RECRUITING","ACTIVE_NOT_RECRUITING","ENROLLING_BY_INVITATION","COMPLETED"],
        maxRank: 100
      },
      parallelGroup: "default"
    });
  }

  return plan;
}
