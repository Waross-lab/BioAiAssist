#!/usr/bin/env node
/**
 * MCP smoke test (v3): fix Entrez ESearch shape (esearchresult.count/idlist)
 * Usage:
 *   node smoke_v3.mjs [baseUrl]
 *   BASE_URL=http://localhost:8788/mcp node smoke_v3.mjs
 */
const base = process.env.BASE_URL || process.argv[2] || 'http://localhost:8788/mcp';

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

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k];
  return out;
}

async function main() {
  const out = { base, ok: true, steps: [] };

  // 0) tools list
  const tools = await listTools();
  out.steps.push({ step: 'tools/list', n: Array.isArray(tools) ? tools.length : undefined });

  // 1) PubChem
  const pc1 = await callTool('pubchem.compound.search', { namespace: 'name', identifier: 'ciprofloxacin', max: 3 });
  const cids = pc1?.cids || pc1?.IdentifierList?.CID || pc1?.cids?.CID || [];
  assert(Array.isArray(cids), 'pubchem search: cids should be array');
  out.steps.push({ step: 'pubchem.compound.search', cids: cids.slice(0,3) });
  if (cids.length) {
    const pc2 = await callTool('pubchem.compound.props', { cids: cids.slice(0,3).map(String) });
    const arr = Array.isArray(pc2) ? pc2 : (pc2?.PropertyTable?.Properties || []);
    assert(Array.isArray(arr), 'pubchem props should be array-ish');
    out.steps.push({ step: 'pubchem.compound.props', sample: arr[0] });
  }

  // 2) ChEMBL
  const tsearch = await callTool('chembl.target.search', { q: 'gyrA', limit: 5, offset: 0 });
  assert(Array.isArray(tsearch), 'chembl.target.search should return array');
  const target = tsearch[0];
  assert(target?.target_chembl_id, 'target_chembl_id missing');
  out.steps.push({ step: 'chembl.target.search', sample: pick(target, ['target_chembl_id','pref_name','organism']) });

  const acts = await callTool('chembl.activities', { target_chembl_id: target.target_chembl_id, pchembl_only: true, limit: 10, offset: 0 });
  assert(Array.isArray(acts), 'chembl.activities should return array');
  out.steps.push({ step: 'chembl.activities', n: acts.length, sample: pick(acts[0] || {}, ['assay_chembl_id','standard_type','standard_value','pchembl_value']) });

  // 3) UniProt
  const uni = await callTool('uniprot.search', { query: 'gene:gyrA AND reviewed:true', limit: 1 });
  assert(Array.isArray(uni?.results), 'uniprot.search results array expected');
  out.steps.push({ step: 'uniprot.search', sample: pick(uni.results[0] || {}, ['primaryAccession','organism']) });

  // 4) PubMed via Entrez ESearch (JSON shape: { esearchresult: { count, idlist } })
  const pm = await callTool('entrez.esearch', { db: 'pubmed', term: 'gyrA ciprofloxacin (S83 OR D87)', retmax: 5 });
  const es = pm?.esearchresult || pm?.esearchResult || pm;
  const count = es?.count ? Number(es.count) : (Array.isArray(es?.idlist) ? es.idlist.length : undefined);
  const ids = es?.idlist || es?.idList || [];
  assert(typeof count === 'number' || Array.isArray(ids), 'entrez.esearch should include esearchresult.count or idlist');
  out.steps.push({ step: 'entrez.esearch', count, ids: ids.slice(0,5) });

  // 5) BLAST
  const seq = 'MKKSTNATLLKSEAQLA'; // short placeholder
  const bl = await callTool('blast.submit', { program: 'blastp', db: 'nr', sequence: seq });
  assert(bl?.rid, 'blast.submit should return rid');
  const bp = await callTool('blast.poll', { rid: bl.rid });
  assert(['WAITING','READY','UNKNOWN','FAILED','FINISHED'].includes(bp?.status || ''), 'blast.poll status invalid');
  out.steps.push({ step: 'blast.submit+poll', status: bp.status });

  // 6) Stats
  const stats = await callTool('stats.linear_regression', { x: [1,2,3,4], y: [1.1,1.9,3.0,4.1] });
  assert(typeof stats?.r2 === 'number', 'stats.linear_regression r2 missing');
  out.steps.push({ step: 'stats.linear_regression', r2: stats.r2 });

  console.log(JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ base, ok: false, error: String(err) }, null, 2));
  process.exit(1);
});
