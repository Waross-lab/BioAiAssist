#!/usr/bin/env node
/**
 * validate_normalization_plus.mjs (paging-safe)
 * - EuropePMC: pageSize <= 100, fetch multiple pages and merge
 * - OpenAlex: per_page <= 100 (single page to avoid tool limits)
 *
 * Usage:
 *   node validate_normalization_plus.mjs [baseUrl] [inDir] [outDir]
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
function readJSON(file, fallback=null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
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
async function listTools() {
  const r = await rpc('tools/list', {});
  return r?.tools || r || [];
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

  if (rep.metrics.compounds_inchikey_cov < 80) rep.notes.push('Low InChIKey coverage for compounds (consider identity resolution).');
  if (rep.metrics.targets_uniprot_cov < 40) rep.notes.push('Many targets missing UniProt accessions (consider component mapping or filters).');
  if (rep.metrics.assays_target_linked < 40) rep.notes.push('Few assays linked to normalized targets; verify ChEMBL→UniProt mapping.');
  if (rep.metrics.assays_pchembl_cov < 30) rep.notes.push('Low pChEMBL coverage; consider relaxing pchembl_only or broadening targets.');
  if (rep.metrics.literature_unique_ratio < 0.8) rep.notes.push('High literature duplication across sources; dedup logic may need tuning.');

  return rep;
}

function findQueryTerm(inDir) {
  const provFile = path.join(inDir, 'provenance.jsonl');
  if (fs.existsSync(provFile)) {
    const lines = fs.readFileSync(provFile, 'utf-8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j?.source === 'entrez.esearch' && j?.params?.term) return String(j.params.term);
      } catch {}
    }
  }
  const sum = readJSON(path.join(inDir, 'summary.json'), null);
  if (sum?.query) return String(sum.query);
  return 'fluoroquinolone resistance';
}

async function fetchEuropePMC(term, pages=3) {
  const pageSize = 100; // tool limit
  const all = [];
  for (let page=1; page<=pages; page++) {
    const r = await callTool('europepmc.search', { query: term, pageSize, page });
    const items = r?.resultList?.result || [];
    if (items.length === 0) break;
    all.push(...items);
    if (items.length < pageSize) break;
  }
  return { resultList: { result: all } };
}

async function fetchOpenAlex(term) {
  const per_page = 100; // stay under tool limits
  const r = await callTool('openalex.works', { search: term, per_page });
  // Normalizer supports .results or .data
  const items = (r?.results || r?.data || []);
  return { results: items };
}

async function main() {
  ensureDir(outDir);

  const tools = await listTools();
  const toolNames = new Set((tools||[]).map(t => t.name || t));
  const hasEPMC = toolNames.has('europepmc.search');
  const hasOA   = toolNames.has('openalex.works');

  // Load sanity outputs as inputs
  const pcProps = readCSV(path.join(inDir, 'compounds_pubchem_props.csv'));
  const chemblTargets = readCSV(path.join(inDir, 'targets_chembl_search.csv'));
  const chemblActs = readCSV(path.join(inDir, 'activities_chembl.csv'));
  const uni = readCSV(path.join(inDir, 'uniprot_search.csv'));
  const pmids = readCSV(path.join(inDir, 'pubmed_ids.csv'));

  if (![pcProps, chemblTargets, chemblActs, uni, pmids].every(a => Array.isArray(a))) {
    throw new Error(`Missing or unreadable sanity CSVs in ${inDir}`);
  }

  const uniprot_results = { results: uni.map(r => ({
    primaryAccession: r.primaryAccession,
    organism: { scientificName: r.organism },
    genes: r.gene ? [{ geneName: { value: r.gene } }] : []
  })) };
  const pubmed_esearch = { esearchresult: { idlist: pmids.map(r => r.pmid) } };

  // Fetch DOI-bearing sources using the same query term
  const term = findQueryTerm(inDir);
  let epmc = undefined, openalex = undefined;
  if (hasEPMC) {
    epmc = await fetchEuropePMC(term, 3);
    fs.writeFileSync(path.join(outDir, 'europepmc.json'), JSON.stringify(epmc, null, 2));
  }
  if (hasOA) {
    openalex = await fetchOpenAlex(term);
    fs.writeFileSync(path.join(outDir, 'openalex.json'), JSON.stringify(openalex, null, 2));
  }

  // Normalize via server tool
  const norm = await callTool('normalize.entities', {
    pubchem_props: pcProps,
    chembl_targets: chemblTargets.map(t => ({ target_chembl_id: t.target_chembl_id, pref_name: t.pref_name, organism: t.organism })),
    chembl_activities: chemblActs,
    uniprot_results,
    pubmed_esearch,
    europepmc_search: epmc,
    openalex_works: openalex
  });

  // Write normalized outputs
  fs.writeFileSync(path.join(outDir, 'compounds.csv'), toCSV(norm.compounds));
  fs.writeFileSync(path.join(outDir, 'targets.csv'), toCSV(norm.targets));
  fs.writeFileSync(path.join(outDir, 'assays.csv'), toCSV(norm.assays));
  fs.writeFileSync(path.join(outDir, 'literature.csv'), toCSV(norm.literature));

  // Validate & write report
  const rep = summarizeNormalization(norm);
  const md = `# Stage-2 Normalization Report (DOI-enriched, paging-safe)
- base: ${base}
- outDir: ${outDir}
- term: ${term}

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

  console.log(JSON.stringify({ base, outDir, term, report: rep }, null, 2));
}

main().catch(err => { console.error(JSON.stringify({ base, ok:false, error: String(err) }, null, 2)); process.exit(1); });
