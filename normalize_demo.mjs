#!/usr/bin/env node
/**
 * normalize_demo.mjs
 * Demo: use previously exported CSVs/JSON to call normalize.entities and write normalized CSVs.
 *
 * Usage:
 *   node normalize_demo.mjs [baseUrl] [inDir] [outDir]
 * Defaults:
 *   baseUrl = http://localhost:8788/mcp
 *   inDir   = current dir
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

function readCSV(file) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf-8');
  const recs = parse(txt, { columns: true, skip_empty_lines: true });
  return recs;
}
function toCSV(rows) {
  if (!rows || !rows.length) return '';
  const headers = Array.from(rows.reduce((set,r)=>{ Object.keys(r||{}).forEach(k=>set.add(k)); return set; }, new Set()));
  const esc = v => v==null ? '' : (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g,'""') + '"' : String(v));
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

async function main() {
  ensureDir(outDir);

  // Try to reconstruct plausible raw payloads from the CSVs produced by sanity_export
  const pcProps = readCSV(path.join(inDir, 'compounds_pubchem_props.csv')); // already close to PropertyTable.Properties
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

  const payload = {
    pubchem_props: pcProps,
    chembl_targets: chemblTargets.map(t => ({
      target_chembl_id: t.target_chembl_id, pref_name: t.pref_name, organism: t.organism
    })),
    chembl_activities: chemblActs,
    uniprot_results,
    pubmed_esearch
  };

  const norm = await callTool('normalize.entities', payload);
  fs.writeFileSync(path.join(outDir, 'compounds.csv'), toCSV(norm.compounds));
  fs.writeFileSync(path.join(outDir, 'targets.csv'), toCSV(norm.targets));
  fs.writeFileSync(path.join(outDir, 'assays.csv'), toCSV(norm.assays));
  fs.writeFileSync(path.join(outDir, 'literature.csv'), toCSV(norm.literature));

  console.log(JSON.stringify({ base, outDir, counts: {
    compounds: norm.compounds.length,
    targets: norm.targets.length,
    assays: norm.assays.length,
    literature: norm.literature.length
  }}, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
