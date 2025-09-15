#!/usr/bin/env node
/**
 * research_run_demo.mjs
 * Example client: call research.run and write normalized CSVs + a brief.
 *
 * Usage:
 *   node research_run_demo.mjs [baseUrl] [outDir]
 * Defaults:
 *   baseUrl = http://localhost:8788/mcp
 *   outDir  = research_out_<timestamp>
 */
const base = process.env.BASE_URL || process.argv[2] || 'http://localhost:8788/mcp';
const ts = new Date().toISOString().replace(/[:.]/g,'-');
const outDir = process.argv[3] || `research_out_${ts}`;

import fs from 'fs';
import path from 'path';

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function toCSV(rows) {
  if (!rows || !rows.length) return '';
  const headers = Array.from(rows.reduce((set,r)=>{ Object.keys(r||{}).forEach(k=>set.add(k)); return set; }, new Set()));
  const esc = v => v==null ? '' : (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g,'""') + '"' : String(v));
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

async function rpc(method, params, id=1) {
  const res = await fetch(base, {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0', id, method, params})
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}: ${body}`);
  let j;
  try { j = JSON.parse(body); } catch(e) { throw new Error(`Bad JSON from server: ${body}`); }
  if (j.error) throw new Error(`${method} -> ${JSON.stringify(j.error)}`);
  return j.result ?? j;
}
async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  return r?.content ?? r;
}

async function main() {
  ensureDir(outDir);

  const spec = {
    compounds: [{ name: 'ciprofloxacin' }, { name: 'levofloxacin' }],
    targets: [{ query: 'DNA gyrase' }, { query: 'topoisomerase' }],
    keywords: ['fluoroquinolone resistance'],
    sources: ['pubchem','chembl','uniprot','entrez','europepmc','openalex'],
    options: {
      pchemblOnly: true,
      maxPerSource: 50,
      
    }
  };

  const res = await callTool('research.run', spec);

  // Write normalized tables
  fs.writeFileSync(path.join(outDir, 'compounds.csv'), toCSV(res.normalized.compounds));
  fs.writeFileSync(path.join(outDir, 'targets.csv'), toCSV(res.normalized.targets));
  fs.writeFileSync(path.join(outDir, 'assays.csv'), toCSV(res.normalized.assays));
  fs.writeFileSync(path.join(outDir, 'literature.csv'), toCSV(res.normalized.literature));

  // Simple brief
  const m = res.metrics;
  const brief = `# Research Brief
- term: ${res.term}

## Counts
- compounds: ${m.counts.compounds}
- targets: ${m.counts.targets}
- assays: ${m.counts.assays}
- literature: ${m.counts.literature}

## Quality
- InChIKey coverage: ${m.metrics.compounds_inchikey_cov.toFixed(1)}%
- Targets w/ UniProt: ${m.metrics.targets_uniprot_cov.toFixed(1)}%
- Assays linked to target: ${m.metrics.assays_target_linked.toFixed(1)}%
- DOI coverage: ${m.metrics.literature_doi_cov.toFixed(1)}%

## Notes
${m.notes.length ? m.notes.map((n)=>`- ${n}`).join('\n') : '- (none)'}
`;
  fs.writeFileSync(path.join(outDir, 'research_brief.md'), brief);

  // Provenance (for transparency)
  fs.writeFileSync(path.join(outDir, 'provenance.jsonl'), res.provenance.map((o)=>JSON.stringify(o)).join('\n'));

  console.log(JSON.stringify({ base, outDir, term: res.term, metrics: res.metrics }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
