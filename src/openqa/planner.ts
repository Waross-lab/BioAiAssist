import type { McpToolMeta, QueryPlan, ToolCall } from "./types.js";

function heuristicRouting(q: string, tools: McpToolMeta[]) {
  const calls: ToolCall[] = [];
  const Q = q.toLowerCase();

  const wantGene    = /\b[A-Z0-9]{2,7}\b/.test(q) || /gene|variant|snv|mutation/.test(Q);
  const wantProtein = /protein|uniprot|isoform|domain/.test(Q);
  const wantPathway = /pathway|reactome|kegg/.test(Q);
  const wantTrials  = /clinical trial|nct\d+/i.test(q) || /trial|phase [i1-4v]/i.test(q);
  const wantDrugs   = /drug|target|inhibitor|agonist|antagonist|binder|compound/.test(Q);

  const addIf = (pred: boolean, match: RegExp) => {
    if (!pred) return;
    for (const t of tools) {
      const s = `${t.server}:${t.name}:${t.description ?? ""}`.toLowerCase();
      if (match.test(s)) calls.push({ server: t.server, tool: t.name, args: {}, parallelGroup: "default" });
    }
  };

  // keep original lines…
  addIf(wantGene, /(ensembl|ncbi|gene)/);
  addIf(wantProtein || wantDrugs || wantGene, /(uniprot|protein)/); // <— NEW: include UniProt if drugs OR gene present
  addIf(wantPathway, /(reactome|kegg|pathway)/);
  addIf(wantTrials, /(clinicaltrials|ctgov|trials)/);

  return calls;
}


export async function planFromQuery(
  query: string,
  discoverTools: () => Promise<McpToolMeta[]>,
  llmPlanner?: (q: string, toolsJson: any) => Promise<QueryPlan | null>
): Promise<QueryPlan> {
  const toolList = await discoverTools();

  if (llmPlanner) {
    try {
      const llm = await llmPlanner(query, toolList);
      if (llm && llm.calls?.length) return llm;
    } catch {}
  }

  const calls = heuristicRouting(query, toolList);
  return {
    rationale: "heuristic-routing v0",
    calls: calls.length ? calls : toolList.slice(0, 3).map(t => ({ server: t.server, tool: t.name, args: {} })),
  };
}
