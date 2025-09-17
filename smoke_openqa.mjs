// smoke_openqa.mjs (ESM) — enhanced: add --pdf output.pdf to export a nicely formatted report

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { answerOpenQuestion } from "./dist/src/openqa/answer_open_question.js";

// --- optional: try real MCP; fall back to mock if not wired yet ---
async function getContext() {
  try {
    const { makeMcpClients, discoverAllTools } = await import("./dist/src/openqa/mcp_bridge.js");
    const mcpClients = await makeMcpClients();

    // Add Europe PMC locally (paper search)
    const { makeEuropePmcClient } = await import("./dist/src/openqa/clients/europmc_client.js");
    mcpClients.europmc = makeEuropePmcClient();

    const discoverTools = async () => {
      const base = await discoverAllTools(mcpClients);
      const tools = await mcpClients.europmc.listTools();
      base.push(...tools.map(t => ({ server: "europmc", name: t.name, description: t.description })));
      return base;
    };
    return { mcpClients, discoverTools };
  } catch {
    // fall back to mock + europepmc
    const { makeEuropePmcClient } = await import("./dist/src/openqa/clients/europmc_client.js");
    const europmc = makeEuropePmcClient();

    const { mcpClients: mockClients, discoverTools: mockDiscover } = makeMockContext();
    const mcpClients = { ...mockClients, europmc };
    const discoverTools = async () => {
      const mock = await mockDiscover();
      const tools = await europmc.listTools();
      mock.push(...tools.map(t => ({ server: "europmc", name: t.name, description: t.description })));
      return mock;
    };
    return { mcpClients, discoverTools };
  }
}

// --- mock clients so the smoke always runs ---
function makeMockContext() {
  const uniprot = {
    listTools: async () => [{ name: "search_proteins", description: "Mock UniProt search" }],
    callTool: async (name, args) => ({
      tool: name, query: args,
      hits: [{ id: "P01116", symbol: "KRAS", note: "mock" }], source: "uniprot",
    }),
  };
  const reactome = {
    listTools: async () => [{ name: "pathways_for_gene", description: "Mock Reactome pathways" }],
    callTool: async (name, args) => ({
      tool: name, query: args,
      pathways: [{ id: "R-HSA-6802957", name: "Signaling by KRAS (mock)" }], source: "reactome",
    }),
  };
  const ctgov = {
    listTools: async () => [{ name: "search_trials", description: "Mock ClinicalTrials.gov search" }],
    callTool: async (name, args) => ({
      tool: name, query: args,
      trials: [{ nct: "NCT00000000", title: "NSCLC KRAS G12C inhibitor (mock)", status: "Recruiting" }], source: "ctgov",
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

// ---- CLI parse ----
const args = process.argv.slice(2);
const pdfArg = args.find(a => a.startsWith("--pdf"));
const pdfPath = pdfArg
  ? (pdfArg.includes("=") ? pdfArg.split("=")[1] : "report.pdf")
  : null;
const query = args.filter(a => !a.startsWith("--pdf")).join(" ")
  || "Find drug targets for KRAS G12C and list active NSCLC clinical trials";

// ---- run ----
const { mcpClients, discoverTools } = await getContext();
const result = await answerOpenQuestion(query, { discoverTools, mcpClients, concurrency: 4 });

if (!pdfPath) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// ---- PDF export ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });

const htmlFile = path.join(outDir, `report-${Date.now()}.html`);
const pdfFile = path.isAbsolute(pdfPath) ? pdfPath : path.join(__dirname, pdfPath);

const html = renderReportHTML(result);
fs.writeFileSync(htmlFile, html, "utf8");

try {
  await headlessPrint(htmlFile, pdfFile);
  console.log(`\n✅ PDF saved to: ${pdfFile}`);
} catch (err) {
  console.warn("⚠️ Headless print failed. Opening HTML so you can Save as PDF manually.");
  openInDefaultApp(htmlFile);
}

// ------- helpers -------

function renderReportHTML(result) {
  const card = result.answerCard ?? {};
  const toolsRun = card.toolsRun ?? (result.toolsRun ?? []);
  const slots = card.slots ?? {};
  const ents = card.entities ?? {};
  const evidence = card.evidence ?? [];
  const highlights = card.highlights ?? [];
  const notes = card.notes ?? "";

  const esc = (s) => String(s ?? "").replace(/[&<>]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c]));

  const li = (arr) => (arr || []).map(x => `<li>${esc(x.text ?? x)}</li>`).join("");
  const chipList = (label, arr) =>
    arr && arr.length ? `<div class="chips"><span class="h">${label}:</span> ${arr.map(x => `<span class="chip">${esc(x)}</span>`).join(" ")}</div>` : "";

  const pubRows = (ents.publications || []).slice(0, 20).map(p => {
    const src = p.pmid ? `PMID:${p.pmid}` : (p.doi ? `DOI:${p.doi}` : (p.id || ""));
    const ex = p?.meta?.extracted;
    const cut = ex?.cutoffs?.[0]?.value != null ? `${ex.cutoffs[0].value}%` : "";
    const hr = ex?.hr?.[0]?.value != null ? `${ex.hr[0].value}${ex.hr[0].ci ? " " + ex.hr[0].ci : ""}` : "";
    const mos = ex?.medians?.find(m => m.endpoint === "OS")?.value ?? "";
    const mps = ex?.medians?.find(m => m.endpoint === "PFS")?.value ?? "";
    return `<tr>
      <td>${esc(p.title || "")}</td>
      <td>${esc(src)}</td>
      <td>${esc(cut)}</td>
      <td>${esc(hr)}</td>
      <td>${esc(mos)}</td>
      <td>${esc(mps)}</td>
    </tr>`;
  }).join("");

  const trialRows = (ents.trials || []).slice(0, 15).map(t => {
    return `<tr>
      <td>${esc(t.nctId ?? t.id ?? "")}</td>
      <td>${esc(t.title ?? "")}</td>
      <td>${esc(t.status ?? "")}</td>
      <td>${esc(t.phase ?? "")}</td>
      <td>${esc(t.condition ?? "")}</td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>BioAiAssist Report</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 28px; color: #111; }
  h1 { margin: 0 0 8px; }
  .muted { color: #666; font-size: 12px; }
  .section { margin-top: 24px; }
  .chips { margin-top: 6px; }
  .chips .h { font-weight: 600; margin-right: 6px; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 999px; border: 1px solid #ddd; margin: 2px 4px 0 0; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 16px; }
  .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; background: #fff; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 8px; vertical-align: top; }
  th { background: #f8fafc; text-align: left; }
  ul { margin: 6px 0 0 18px; }
  .kvs { display:flex; gap:12px; flex-wrap:wrap; font-size:12px; color:#333; }
  .kvs div { background:#f8fafc; padding:6px 8px; border-radius:8px; border:1px solid #e5e7eb; }
  .small { font-size: 12px; }
</style>
</head>
<body>
  <h1>BioAiAssist Report</h1>
  <div class="muted">Query: <b>${esc(result.query || card.query || "")}</b></div>

  <div class="section">
    <div class="kvs">
      <div>Tool hits: <b>${esc(result.hits ?? toolsRun.filter(t=>t.ok).length)}</b></div>
      <div>Failures: <b>${(result.failures ?? []).length}</b></div>
    </div>
  </div>

  <div class="section grid">
    <div class="card">
      <h3>Slots</h3>
      ${chipList("Genes", slots.genes || [])}
      ${chipList("Variants", slots.variants || [])}
      ${chipList("Diseases", slots.diseases || [])}
      ${chipList("Drugs", slots.drugs || [])}
      ${chipList("Phases", (slots.phases || []).map(String))}
      ${chipList("NCT IDs", slots.nctIds || [])}
    </div>

    <div class="card">
      <h3>Highlights</h3>
      <ul>${li(highlights)}</ul>
      ${notes ? `<p class="small"><b>Note:</b> ${esc(notes)}</p>` : ""}
    </div>
  </div>

  <div class="section card">
    <h3>Publications (top)</h3>
    <table>
      <thead><tr><th>Title</th><th>ID</th><th>Cutoff %</th><th>HR (95% CI)</th><th>Median OS (mo)</th><th>Median PFS (mo)</th></tr></thead>
      <tbody>${pubRows || ""}</tbody>
    </table>
  </div>

  <div class="section card">
    <h3>Clinical Trials (top)</h3>
    <table>
      <thead><tr><th>NCT</th><th>Title</th><th>Status</th><th>Phase</th><th>Condition</th></tr></thead>
      <tbody>${trialRows || ""}</tbody>
    </table>
  </div>

  <div class="section card">
    <h3>Tools Run</h3>
    <table>
      <thead><tr><th>Server</th><th>Tool</th><th>OK</th><th>Elapsed (ms)</th></tr></thead>
      <tbody>
        ${toolsRun.map(t => `<tr><td>${esc(t.server)}</td><td>${esc(t.tool)}</td><td>${t.ok ? "✔︎" : "✖"}</td><td>${t.ms ?? ""}</td></tr>`).join("")}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

async function headlessPrint(htmlPath, pdfPath) {
  const candidates = [
    "msedge", // Edge if in PATH
    "C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe",
    "C:\\\\Program Files\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe",
    "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe",
    "chrome" // Chrome if in PATH
  ];
  for (const bin of candidates) {
    try {
      await execOnce(bin, ["--headless=new", "--disable-gpu", `--print-to-pdf=${pdfPath}`, htmlPath], 20000);
      return;
    } catch {
      // try next
    }
  }
  throw new Error("No headless Edge/Chrome found");
}

function execOnce(bin, args, timeoutMs=20000) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: "ignore", windowsHide: true });
    const to = setTimeout(() => { p.kill(); reject(new Error("timeout")); }, timeoutMs);
    p.on("exit", code => { clearTimeout(to); code === 0 ? resolve() : reject(new Error(`exit ${code}`)); });
    p.on("error", err => { clearTimeout(to); reject(err); });
  });
}

function openInDefaultApp(filePath) {
  const cmd = process.platform === "win32" ? "cmd" : (process.platform === "darwin" ? "open" : "xdg-open");
  const args = process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
