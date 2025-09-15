#!/usr/bin/env node
/**
 * sanity_export.mjs
 * Validate existing MCP tools and export tidy CSVs for quick inspection.
 *
 * What it does:
 *  - Calls tools/list to discover capabilities.
 *  - PubChem: search a couple example compounds (ciprofloxacin, levofloxacin) -> props CSV.
 *  - ChEMBL: target search for generic queries, then activities for the first few targets -> activities CSV.
 *  - UniProt: generic search -> targets CSV.
 *  - PubMed (Entrez ESearch): keyword query -> literature CSV (ids only; fetch can be added later).
 *  - Optional EuropePMC/OpenAlex if available -> literature counts CSV.
 *  - Writes a run summary JSON + provenance JSONL.
 *
 * Usage:
 *   node sanity_export.mjs [baseUrl] [outDir]
 *   BASE_URL=http://localhost:8788/mcp node sanity_export.mjs
 */
const base = process.env.BASE_URL || process.argv[2] || 'http://localhost:8788/mcp';
const outDirArg = process.argv[3];
const ts = new Date().toISOString().replace(/[:.]/g,'-');
const outDir = outDirArg || `sanity_out_${ts}`;

import fs from 'fs';
import path from 'path';

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function toCSV(rows) {
  if (!rows || !rows.length) return '';
  const headers = Array.from(rows.reduce((set,r)=>{
    Object.keys(r||{}).forEach(k=>set.add(k));
    return set;
  }, new Set()));
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
    return s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => esc(r[h])).join(','));
  }
  return lines.join('\n');
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
  return r?.tools || r;
}
async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  return r?.content ?? r;
}

function assert(cond, msg) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }

function flat(obj, prefix='') {
  const out = {};
  for (const [k,v] of Object.entries(obj||{})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flat(v, key));
    } else {
      out[key] = Array.isArray(v) ? v.join('|') : v;
    }
  }
  return out;
}

async function main() {
  ensureDir(outDir);
  const provenance = [];
  const summary = { base, outDir, ok: true, steps: [] };

  const tools = await listTools();
  const toolNames = new Set((tools||[]).map(t=>t.name || t));
  summary.steps.push({ step: 'tools/list', n: toolNames.size });

  // ---------- PubChem compounds -> props ----------
  const compounds = ['ciprofloxacin', 'levofloxacin'];
  const allPropRows = [];
  for (const name of compounds) {
    const search = await callTool('pubchem.compound.search', { namespace: 'name', identifier: name, max: 5 });
    provenance.push({ source: 'pubchem.compound.search', params: { name }, rawKeys: Object.keys(search||{}) });
    const cids = search?.cids || search?.IdentifierList?.CID || search?.cids?.CID || [];
    if (cids.length) {
      const props = await callTool('pubchem.compound.props', { cids: cids.slice(0,3).map(String) });
      const arr = Array.isArray(props) ? props : (props?.PropertyTable?.Properties || []);
      provenance.push({ source: 'pubchem.compound.props', params: { cids: cids.slice(0,3) }, n: arr.length });
      for (const r of arr) allPropRows.push({ query: name, ...r });
    }
  }
  if (allPropRows.length) {
    fs.writeFileSync(path.join(outDir, 'compounds_pubchem_props.csv'), toCSV(allPropRows));
    summary.steps.push({ step: 'pubchem.props', n: allPropRows.length });
  } else {
    summary.steps.push({ step: 'pubchem.props', n: 0, warn: 'No props returned' });
  }

  // ---------- ChEMBL targets & activities ----------
  const targetQueries = ['DNA gyrase', 'topoisomerase', 'beta-lactamase']; // generic targets as examples
  const targetRows = [];
  const activityRows = [];
  for (const q of targetQueries) {
    const tsearch = await callTool('chembl.target.search', { q, limit: 10, offset: 0 });
    provenance.push({ source: 'chembl.target.search', params: { q }, n: (tsearch||[]).length });
    for (const t of (tsearch || []).slice(0,3)) {
      targetRows.push({ query: q, target_chembl_id: t.target_chembl_id, pref_name: t.pref_name, organism: t.organism });
      if (t.target_chembl_id) {
        const acts = await callTool('chembl.activities', { target_chembl_id: t.target_chembl_id, pchembl_only: true, limit: 20, offset: 0 });
        provenance.push({ source: 'chembl.activities', params: { target_chembl_id: t.target_chembl_id }, n: (acts||[]).length });
        for (const a of (acts||[])) {
          activityRows.push({
            target_chembl_id: t.target_chembl_id,
            assay_chembl_id: a.assay_chembl_id,
            standard_type: a.standard_type,
            standard_value: a.standard_value,
            standard_units: a.standard_units,
            pchembl_value: a.pchembl_value,
            molecule_chembl_id: a.molecule_chembl_id
          });
        }
      }
    }
  }
  if (targetRows.length) fs.writeFileSync(path.join(outDir, 'targets_chembl_search.csv'), toCSV(targetRows));
  if (activityRows.length) fs.writeFileSync(path.join(outDir, 'activities_chembl.csv'), toCSV(activityRows));
  summary.steps.push({ step: 'chembl.target.search', n: targetRows.length });
  summary.steps.push({ step: 'chembl.activities', n: activityRows.length });

  // ---------- UniProt generic search ----------
  if (toolNames.has('uniprot.search')) {
    const uni = await callTool('uniprot.search', { query: 'reviewed:true AND (kinase OR gyrase OR polymerase)', limit: 10 });
    provenance.push({ source: 'uniprot.search', params: { limit: 10 }, n: (uni?.results||[]).length });
    const uniRows = (uni?.results || []).map(r => ({
      primaryAccession: r.primaryAccession,
      organism: r?.organism?.scientificName,
      gene: (r?.genes?.[0]?.geneName?.value) || '',
      protein: r?.proteinDescription?.recommendedName?.fullName?.value || r?.proteinDescription?.submissionNames?.[0]?.fullName?.value || ''
    }));
    if (uniRows.length) fs.writeFileSync(path.join(outDir, 'uniprot_search.csv'), toCSV(uniRows));
    summary.steps.push({ step: 'uniprot.search', n: uniRows.length });
  }

  // ---------- PubMed via Entrez ESearch ----------
  const pm = await callTool('entrez.esearch', { db: 'pubmed', term: 'fluoroquinolone resistance', retmax: 30 });
  const es = pm?.esearchresult || pm?.esearchResult || pm;
  const pmIds = (es?.idlist || es?.idList || []);
  const pmCount = Number(es?.count || pmIds.length || 0);
  provenance.push({ source: 'entrez.esearch', params: { term: 'fluoroquinolone resistance' }, count: pmCount });
  const litRows = pmIds.map(id => ({ pmid: id }));
  if (litRows.length) fs.writeFileSync(path.join(outDir, 'pubmed_ids.csv'), toCSV(litRows));
  summary.steps.push({ step: 'entrez.esearch', count: pmCount, ids: pmIds.slice(0,5) });

  // ---------- Optional: EuropePMC / OpenAlex if present ----------
  if (toolNames.has('europepmc.search')) {
    const ep = await callTool('europepmc.search', { query: 'fluoroquinolone resistance', pageSize: 20, page: 1 });
    const n = (ep?.resultList?.result || []).length;
    provenance.push({ source: 'europepmc.search', params: { q: 'fluoroquinolone resistance' }, n });
    summary.steps.push({ step: 'europepmc.search', n });
  }
  if (toolNames.has('openalex.works')) {
    const oa = await callTool('openalex.works', { search: 'fluoroquinolone resistance', per_page: 20 });
    const n = (oa?.results || oa?.data || []).length;
    provenance.push({ source: 'openalex.works', params: { search: 'fluoroquinolone resistance' }, n });
    summary.steps.push({ step: 'openalex.works', n });
  }

  // ---------- Write summary & provenance ----------
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'provenance.jsonl'), provenance.map(o=>JSON.stringify(o)).join('\n'));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ base, ok: false, error: String(err) }, null, 2));
  process.exit(1);
});
