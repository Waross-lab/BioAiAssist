#!/usr/bin/env node
/**
 * validate_normalization.mjs
 *
 * Runs Stage-2 normalization via your MCP server and validates core invariants.
 * Also writes normalized CSVs and a small markdown report.
 *
 * Usage:
 *   node validate_normalization.mjs [baseUrl] [inDir] [outDir]
 * Defaults:
 *   baseUrl = http://localhost:8788/mcp
 *   inDir   = '.'  (expects sanity_export outputs like compounds_pubchem_props.csv, etc.)
 *   outDir  = normalized_out_<timestamp>
 */
const base = process.env.BASE_URL || process.argv[2] || 'http://localhost:8788/mcp';
const inDir = process.argv[3] || '.';
const ts = new Date().toISOString().replace(/[:.]/g,'-');
const outDir = process.argv[4] || `normalized_out_${ts}`;

import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function readCSV(file) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf-8');
  return parse(txt, { columns: true, skip_empty_lines: true });
}
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

function pct(n, d) { return d ? (100 * n / d) : 0; }
function asNum(x) { const n = Number(x); return Number.isFinite(n) ? n : undefined; }

function summarizeNormalization(norm) {
  const rep = { counts: {}, metrics: {} , notes: [] };

  // Compounds
  const C = norm.compounds || [];
  const c_inchikey = C.filter(c => (c.inchikey||'').length>0).length;
  const c_props = C.filter(c => c.mw != null && c.tpsa != null).length;
  const c_dupes = C.length - new Set(C.map(c => c.compound_id)).size;
  rep.counts.compounds = C.length;
  rep.metrics.compounds_inchikey_cov = pct(c_inchikey, C.length);
  rep.metrics.compounds_props_cov = pct(c_props, C.length);
  rep.metrics.compounds_duplicates = c_dupes;

  // Targets
  const T = norm.targets || [];
  const t_uniprot = T.filter(t => (t.uniprot||'').length>0).length;
  const t_chembl = T.filter(t => (t.chembl_target_id||'').length>0).length;
  rep.counts.targets = T.length;
  rep.metrics.targets_uniprot_cov = pct(t_uniprot, T.length);
  rep.metrics.targets_chembl_cov = pct(t_chembl, T.length);

  // Assays
  const A = norm.assays || [];
  const a_pchembl = A.filter(a => a.pchembl_value != null && a.pchembl_value !== '').length;
  const a_stdnum = A.filter(a => asNum(a.standard_value) != null).length;
  const a_linked = A.filter(a => (a.target_id||'').length>0).length;
  rep.counts.assays = A.length;
  rep.metrics.assays_pchembl_cov = pct(a_pchembl, A.length);
  rep.metrics.assays_standard_numeric = pct(a_stdnum, A.length);
  rep.metrics.assays_target_linked = pct(a_linked, A.length);

  // Literature
  const L = norm.literature || [];
  const Luniq = new Set(L.map(l => l.key)).size;
  const l_pmid = L.filter(l => (l.pmid||'').length>0).length;
  const l_doi = L.filter(l => (l.doi||'').length>0).length;
  rep.counts.literature = L.length;
  rep.metrics.literature_unique_ratio = Luniq ? (Luniq / L.length) : 1;
  rep.metrics.literature_pmid_cov = pct(l_pmid, L.length);
  rep.metrics.literature_doi_cov = pct(l_doi, L.length);

  // Notes (light heuristics)
  if (rep.metrics.compounds_inchikey_cov < 80) rep.notes.push('Low InChIKey coverage for compounds (consider identity resolution).');
  if (rep.metrics.targets_uniprot_cov < 40) rep.notes.push('Many targets missing UniProt accessions (consider component mapping or filters).');
  if (rep.metrics.assays_target_linked < 40) rep.notes.push('Few assays linked to normalized targets; verify ChEMBL→UniProt mapping.');
  if (rep.metrics.assays_pchembl_cov < 30) rep.notes.push('Low pChEMBL coverage; consider relaxing pchembl_only or broadening targets.');
  if (rep.metrics.literature_unique_ratio < 0.8) rep.notes.push('High literature duplication across sources; dedup logic may need tuning.');

  return rep;
}

async function main() {
  ensureDir(outDir);

  // Load sanity outputs as inputs
  const pcProps = readCSV(path.join(inDir, 'compounds_pubchem_props.csv'));
  const chemblTargets = readCSV(path.join(inDir, 'targets_chembl_search.csv'));
  const chemblActs = readCSV(path.join(inDir, 'activities_chembl.csv'));
  const uni = readCSV(path.join(inDir, 'uniprot_search.csv'));
  const pmids = readCSV(path.join(inDir, 'pubmed_ids.csv'));

  const uniprot_results = { results: uni.map(r => ({
    primaryAccession: r.primaryAccession,
    organism: { scientificName: r.organism },
    genes: r.gene ? [{ geneName: { value: r.gene } }] : []
  })) };
  const pubmed_esearch = { esearchresult: { idlist: pmids.map(r => r.pmid) } };

  // Normalize via server tool
  const norm = await callTool('normalize.entities', {
    pubchem_props: pcProps,
    chembl_targets: chemblTargets.map(t => ({ target_chembl_id: t.target_chembl_id, pref_name: t.pref_name, organism: t.organism })),
    chembl_activities: chemblActs,
    uniprot_results,
    pubmed_esearch
  });

  // Write normalized outputs
  fs.writeFileSync(path.join(outDir, 'compounds.csv'), toCSV(norm.compounds));
  fs.writeFileSync(path.join(outDir, 'targets.csv'), toCSV(norm.targets));
  fs.writeFileSync(path.join(outDir, 'assays.csv'), toCSV(norm.assays));
  fs.writeFileSync(path.join(outDir, 'literature.csv'), toCSV(norm.literature));

  // Validate & write report
  const rep = summarizeNormalization(norm);
  const md = `# Stage-2 Normalization Report
- base: ${base}
- outDir: ${outDir}

## Counts
- compounds: ${rep.counts.compounds}
- targets: ${rep.counts.targets}
- assays: ${rep.counts.assays}
- literature: ${rep.counts.literature}

## Metrics (coverage / quality)
- compounds: InChIKey coverage ${rep.metrics.compounds_inchikey_cov.toFixed(1)}%, props coverage ${rep.metrics.compounds_props_cov.toFixed(1)}%, duplicates ${rep.metrics.compounds_duplicates}
- targets: UniProt coverage ${rep.metrics.targets_uniprot_cov.toFixed(1)}%, ChEMBL ID coverage ${rep.metrics.targets_chembl_cov.toFixed(1)}%
- assays: pChEMBL present ${rep.metrics.assays_pchembl_cov.toFixed(1)}%, standard_value numeric ${rep.metrics.assays_standard_numeric.toFixed(1)}%, linked to normalized target ${rep.metrics.assays_target_linked.toFixed(1)}%
- literature: unique ratio ${(rep.metrics.literature_unique_ratio*100).toFixed(1)}%, PMID coverage ${rep.metrics.literature_pmid_cov.toFixed(1)}%, DOI coverage ${rep.metrics.literature_doi_cov.toFixed(1)}%

## Notes
${rep.notes.length ? rep.notes.map(n => `- ${n}`).join('\n') : '- (none)'}
`;
  fs.writeFileSync(path.join(outDir, 'normalized_report.md'), md);

  console.log(JSON.stringify({ base, outDir, report: rep }, null, 2));
}

main().catch(err => { console.error(JSON.stringify({ base, ok:false, error: String(err) }, null, 2)); process.exit(1); });
