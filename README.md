BioAiAssist

Goal: a single search bar for biology/chemistry/genetics that fans a question out to multiple bioinformatics tools, collects best fit data based on query, analyzes the results, and returns structured, citable results.

This repo currently provides a working Planner → Runner → Normalizer pipeline in TypeScript (ESM), plus a smoke test that runs out-of-the-box with mock tools. You can optionally flip it to real MCP tools by wiring a tiny bridge to your existing bio-mcp.ts connections.



   ✨ What works today

Open-ended question in → multi-tool plan out

A lightweight planner turns free text into a list of tool calls (heuristics; no LLM required).

Parallel execution with timeouts

The runner executes tool calls concurrently and survives per-tool failures.

Normalization & summary

Tool outputs are normalized into a simple, consistent JSON and summarized.

Smoke test

smoke_openqa.mjs runs immediately with mocked UniProt/Reactome/CTGov tools, so you can see end-to-end output without configuring anything.

In the default mock run you’ll see a JSON bundle with query, hits, records, and provenance (server, tool).



   🧩 Architecture (PRNR)

Question
   │
   ▼
Planner ──► QueryPlan (which tools to call, with args)
   │
   ▼
Runner  ──► ToolResult[] (ok/error, elapsedMs, payload)
   │
   ▼
Normalizer/Reporter ──► Structured JSON (records + summary)

Planner (src/openqa/planner.ts)
Heuristics that route questions to relevant tools (gene/protein/pathway/trials).

Runner (src/openqa/runner.ts)
Concurrency + per-tool timeouts, no external deps.

Normalizer/Reporter (src/openqa/normalize_and_report.ts)
Flattens results and emits a compact summary (drop-in mappers live here).


   📁 Repo layout (key files)

root/
  smoke_openqa.mjs                 # end-to-end smoke (mock tools by default)
  bio-mcp.ts                       # (your existing MCP connections – optional bridge target)
  research_orchestrator.ts         # (existing) can re-export the OpenQA entry point
  stage2_normalization.ts          # (existing) future place for richer canonical mapping

  src/openqa/
    types.ts
    planner.ts
    runner.ts
    normalize_and_report.ts
    answer_open_question.ts
    mcp_bridge.ts                  # optional: wraps your bio-mcp exports when you connect real tools


   🚀 Quickstart (Windows / PowerShell shown)
    
Prereqs: Node 18+ (Node 20/22 tested), npm.

1. Install & build
npm i
npm run build

2. Run the smoke (mock tools)
node .\smoke_openqa.mjs "Find drug targets for KRAS G12C and list active NSCLC clinical trials"

You should see JSON, e.g.:
Tip: Running from the repo folder avoids “Cannot find module …\smoke_openqa.mjs”.
If you’re elsewhere, use the full path:
node "C:\Users\you\Desktop\BioAiAssist\smoke_openqa.mjs" "your query"


🔌 (Optional) Connect to real MCP tools

By default the smoke uses mock clients so it always runs. To hit real tools:

1. Ensure bio-mcp.ts exports two functions after build (names are flexible; the bridge looks for either):   
// dist/bio-mcp.js should export:
export async function startAll(): Promise<string[]>;     // e.g. ["uniprot","reactome","ctgov"]
export function getClientFor(name: string): {
  listTools: () => Promise<Array<{name:string, description?:string}>>,
  callTool:  (tool: string, args: any, opts?: {timeoutMs?: number}) => Promise<any>
};

2. The included src/openqa/mcp_bridge.ts tries a few relative paths to load your compiled dist/bio-mcp.js and adapt it to the runner’s interface.
3. The smoke script will auto-try real MCP first, then fall back to mocks. No code changes needed:  
   // smoke_openqa.mjs
const { makeMcpClients, discoverAllTools } = await import("./dist/src/openqa/mcp_bridge.js");
const mcpClients = await makeMcpClients();                // if this fails, it silently uses the mocks

4. Rebuild + run:
   npm run build
node .\smoke_openqa.mjs "Summarize UniProt protein info and Reactome pathways for KRAS"


🧠 Programmatic API (what you call from Node)

import { answerOpenQuestion } from "./dist/src/openqa/answer_open_question.js";

const result = await answerOpenQuestion("KRAS G12C trials in NSCLC", {
  discoverTools, // () => Promise<{server, name, description}[]>
  mcpClients,    // { [server]: { listTools():Promise<...>, callTool(name,args,opts):Promise<any> } }
  concurrency: 4
});

console.log(result);
// { query, hits, summary, records: [...], /* plan may be included if you added that */ }

discoverTools() can be built from your mcpClients (see the smoke script for a tiny implementation).
mcpClients come either from mocks (in the smoke), or from the optional mcp_bridge.makeMcpClients().


🛠 Configuration notes (ESM/TypeScript)

package.json
To avoid ESM warnings, set:
{
  "type": "module",
  "scripts": { "build": "tsc -p tsconfig.json" }
}

tsconfig.json (works well with Node ESM)

{
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true
  },
  "include": ["src/**/*", "*.ts"]
}

Relative imports in TS must include the extension .js (Node ESM rule).
Example: import { runPlan } from "./runner.js";
Build output path:
With rootDir: ".": compiled files land under dist/src/... and dist/....
With rootDir: "src": they land under dist/.... Make sure your runtime imports match.


🧪 Example prompts that route well

“Find drug targets for KRAS G12C and list active NSCLC clinical trials.”

“Summarize UniProt protein info and Reactome pathways for KRAS.”

“For EGFR L858R, list relevant pathways and any phase 2 or 3 trials in NSCLC.”

“Show details for NCT04585815 and related KRAS G12C trials.”

Routing is currently heuristic: gene/protein/variant/pathway/trial keywords are detected and the relevant tools are selected. Argument filling is minimal in this baseline.



🧭 Roadmap (near-term)

Tool argument filling from query text (gene, variant, disease, phase, NCT ids).
Richer normalization into canonical records (Gene/Protein/Pathway/Variant/Trial/Publication).
Evidence & ranking (authority/recency/agreement) with explicit citations/IDs.
Optional LLM planner that reads MCP tool metadata and proposes a QueryPlan (heuristic fallback stays in place).



🧯 Troubleshooting

ERR_MODULE_NOT_FOUND … "./planner"
Add .js to local imports in TS: import "./planner.js", rebuild.

Cannot find module '...dist/openqa/answer_open_question.js'
Your build likely outputs to dist/src/.... Adjust the import in smoke_openqa.mjs:

import { answerOpenQuestion } from "./dist/src/openqa/answer_open_question.js";

Warning: MODULE_TYPELESS_PACKAGE_JSON
Add "type": "module" to package.json.

TS error: Cannot find module 'p-limit'
We removed that dependency. If you still see it, replace src/openqa/runner.ts with the dep-free version (uses an internal concurrency queue).

Running from C:\WINDOWS\system32 can’t find the smoke file
cd into the repo first, or use an absolute path to smoke_openqa.mjs.



📜 License

Copyright © 2025 Waross-Lab

Use of External Data
BioAiAssist queries and retrieves data from publicly available biology databases, including but not limited to PubMed, PubChem, BLAST, UniProt, and similar resources. All retrieved raw data remains the intellectual property of the respective database providers and is subject to their Terms of Service and applicable licenses. BioAiAssist does not claim ownership of this external data.

Attribution
All raw data is cited to its original source. Users are responsible for complying with the license terms of any third-party database from which data is retrieved.

Disclaimer
BioAiAssist provides analyzed and interpreted outputs for research and educational purposes only. The Owner makes no warranties regarding the accuracy, completeness, or fitness for any particular purpose of the information generated by this software.



🙏 Acknowledgments

Inspired by the Model Context Protocol (MCP) ecosystem for tool discovery & invocation.
Thanks to open bioinformatics resources (UniProt, Reactome, ClinicalTrials.gov, etc.) whose schemas inform the normalization shapes used here.


