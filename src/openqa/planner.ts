// src/openqa/planner.ts
import type { McpToolMeta, QueryPlan, ToolCall } from "./types.js";
import { fillSlots } from "./slot_filler.js";
import { buildEuropePmcQuery } from "./query_builders/literature.js";

export async function planFromQuery(
  query: string,
  discoverTools: () => Promise<McpToolMeta[]>,
  llmPlanner?: (q: string, toolsJson: any) => Promise<QueryPlan | null>
): Promise<QueryPlan> {
  const toolList = await discoverTools();
  const slots = fillSlots(query);
  const Q = query.toLowerCase();

  // Try LLM planner first (optional)
  if (llmPlanner) {
    try {
      const llm = await llmPlanner(query, toolList);
      if (llm && llm.calls?.length) return llm;
    } catch {}
  }

  // Heuristic intents (generic; no domain hard-coding)
  const wantGene    = /\b[A-Z0-9]{2,7}\b/.test(query) || /gene|variant|snv|mutation/.test(Q);
  const wantProtein = /protein|uniprot|isoform|domain/.test(Q);
  const wantPathway = /pathway|reactome|kegg/.test(Q);
  const wantTrials  = /clinical trial|nct\d+/i.test(query) || /trial|phase [i1-4v]/i.test(Q);
  const wantDrugs   = /drug|target|inhibitor|agonist|antagonist|binder|compound/.test(Q);
  const wantPapers  =
    /benefit|survival|hazard\s*ratio|hr\b|overall\s*survival|os\b|progression|pfs\b|cut[\-\s]?off|threshold|meta[-\s]?analysis|randomized|randomised|cohort|case[-\s]?control/i
      .test(Q);

  const calls: ToolCall[] = [];

  // ✅ Correct arrow-function helper
  const consider = (
    predicate: boolean,
    match: RegExp,
    buildArgs?: (t: McpToolMeta) => Record<string, any>
  ) => {
    if (!predicate) return;
    for (const t of toolList) {
      const s = `${t.server}:${t.name}:${t.description ?? ""}`.toLowerCase();
      if (match.test(s)) {
        calls.push({
          server: t.server,
          tool: t.name,
          args: buildArgs ? buildArgs(t) : {},
          parallelGroup: "default",
        });
      }
    }
  };

  // Gene/protein/pathway/trials routing
  consider(wantGene, /(ensembl|ncbi|gene)/);
  consider(wantProtein || wantDrugs || wantGene, /(uniprot|protein)/);
  consider(wantPathway, /(reactome|kegg|pathway)/);
  consider(wantTrials, /(clinicaltrials|ctgov|trials)/);

  // Literature (Europe PMC / PubMed-like) — generic builder, query-agnostic
  consider(
    wantPapers,
    /(europmc|europepmc|pubmed|paper|publication|literature)/,
    () => ({
      query: buildEuropePmcQuery(slots, query),
      size: 25,
      yearFrom: process.env.BIOAI_EUROPMC_YEAR_FROM || undefined,
      yearTo:   process.env.BIOAI_EUROPMC_YEAR_TO   || undefined,
    })
  );

  // Fallback if nothing matched: call up to 3 tools
  const finalCalls =
    calls.length ? calls : toolList.slice(0, 3).map(t => ({ server: t.server, tool: t.name, args: {} }));

  return {
    rationale: "heuristic-routing v1 (generic) + literature builder",
    calls: finalCalls,
  };
}
