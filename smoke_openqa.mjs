// smoke_openqa.mjs (ESM)

import { answerOpenQuestion } from "./dist/src/openqa/answer_open_question.js";

// --- optional: try real MCP; fall back to mock if not wired yet ---
async function getContext() {
  try {
    const { makeMcpClients, discoverAllTools } = await import(
      "./dist/src/openqa/mcp_bridge.js"
    );
    const mcpClients = await makeMcpClients();
    return { mcpClients, discoverTools: () => discoverAllTools(mcpClients) };
  } catch {
    return makeMockContext();
  }
}

// --- mock clients so the smoke always runs ---
function makeMockContext() {
  const uniprot = {
    listTools: async () => [{ name: "search_proteins", description: "Mock UniProt search" }],
    callTool: async (name, args) => ({
      tool: name,
      query: args,
      hits: [{ id: "P01116", symbol: "KRAS", note: "mock" }],
      source: "uniprot",
    }),
  };
  const reactome = {
    listTools: async () => [{ name: "pathways_for_gene", description: "Mock Reactome pathways" }],
    callTool: async (name, args) => ({
      tool: name,
      query: args,
      pathways: [{ id: "R-HSA-6802957", name: "Signaling by KRAS (mock)" }],
      source: "reactome",
    }),
  };
  const ctgov = {
    listTools: async () => [{ name: "search_trials", description: "Mock ClinicalTrials.gov search" }],
    callTool: async (name, args) => ({
      tool: name,
      query: args,
      trials: [{ nct: "NCT00000000", title: "NSCLC KRAS G12C inhibitor (mock)", status: "Recruiting" }],
      source: "ctgov",
    }),
  };

  const mcpClients = { uniprot, reactome, ctgov };
  const discoverTools = async () => {
    const out = [];
    for (const [server, client] of Object.entries(mcpClients)) {
      const tools = await client.listTools();
      for (const t of tools) out.push({ server, name: t.name, description: t.description });
    }
    return out;
  };
  return { mcpClients, discoverTools };
}

// ---- main ----
const query =
  process.argv.slice(2).join(" ") ||
  "Find drug targets for KRAS G12C and list active NSCLC clinical trials";

const { mcpClients, discoverTools } = await getContext();

const result = await answerOpenQuestion(query, {
  discoverTools,
  mcpClients,
  concurrency: 4,
});

console.log(JSON.stringify(result, null, 2));