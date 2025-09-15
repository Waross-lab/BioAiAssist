
// scripts/test_encode.cjs
// Usage: node scripts/test_encode.cjs "ATAC-seq in Homo sapiens K562"
'use strict';

const { URLSearchParams } = require('url');

function chooseOrganism(text) {
  if (!text) return 'Homo sapiens';
  const t = String(text).toLowerCase();
  if (t.includes('mus musculus') || /\bmouse|mice\b/.test(t)) return 'Mus musculus';
  if (t.includes('rattus norvegicus') || /\brat\b/.test(t)) return 'Rattus norvegicus';
  if (t.includes('saccharomyces cerevisiae') || /\byeast\b/.test(t)) return 'Saccharomyces cerevisiae';
  if (t.includes('danio rerio') || /\bzebrafish\b/.test(t)) return 'Danio rerio';
  if (t.includes('drosophila melanogaster') || /\bfruit\s*fly|drosophila\b/.test(t)) return 'Drosophila melanogaster';
  if (t.includes('caenorhabditis elegans') || /\bc\.?\s*elegans\b/.test(t)) return 'Caenorhabditis elegans';
  return 'Homo sapiens';
}

function detectAssay(text) {
  if (!text) return null;
  const m = String(text).match(/(chip-?seq|atac-?seq|rna-?seq|dnase-?seq|hi-?c)/i);
  return m ? m[1].toLowerCase().replace(/-/g, '-') : null;
}

function detectCellHint(text) {
  if (!text) return null;
  const m = String(text).match(/\b(HEK293|HeLa|K562|GM12878|HCT116|A549|HepG2|U2OS|[A-Z]{2,}\d{2,})\b/);
  return m ? m[1] : null;
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (Array.isArray(v)) {
      for (const x of v) sp.append(k, String(x));
      continue;
    }
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

async function run() {
  const qtext = process.argv.slice(2).join(' ') || 'ATAC-seq in Homo sapiens K562';
  const organism = chooseOrganism(qtext);
  const assay = detectAssay(qtext);
  const cell = detectCellHint(qtext);

  const params = {
    type: 'Experiment',
    status: 'released',
    format: 'json',
    limit: 100,
    'organism.scientific_name': organism
  };
  if (assay) params['assay_title'] = assay.toUpperCase().replace('SEQ', '-seq').replace('CHIP', 'ChIP');
  if (cell) params['biosample_ontology.term_name'] = cell;

  const url = 'https://www.encodeproject.org/search/?' + qs(params);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    console.error('ENCODE fetch failed:', res.status, res.statusText);
    process.exit(1);
  }
  const data = await res.json();
  const rows = Array.isArray(data && data['@graph']) ? data['@graph'] : [];

  const byCell = new Map();
  function getCell(r) {
    const t = (r && r.biosample_ontology && r.biosample_ontology.term_name) || r.biosample_term_name || '';
    if (t) return t;
    const s = r && r.biosample_summary || '';
    const m = String(s).match(/^([^,;]+)[,;]?/);
    return m ? m[1] : 'unknown';
  }
  function getSevCounts(r) {
    const a = (r && r.audit) || {};
    const counts = { ERROR:0, WARNING:0, NOT_COMPLIANT:0, DCC_ACTION:0, INTERNAL_ACTION:0 };
    for (const sev of Object.keys(counts)) {
      const arr = Array.isArray(a[sev]) ? a[sev] : [];
      counts[sev] += arr.length;
    }
    return counts;
  }

  for (const r of rows) {
    const cellType = getCell(r);
    const cur = byCell.get(cellType) || { n:0, sev:{ ERROR:0, WARNING:0, NOT_COMPLIANT:0, DCC_ACTION:0, INTERNAL_ACTION:0 } };
    cur.n += 1;
    const sc = getSevCounts(r);
    for (const k of Object.keys(cur.sev)) cur.sev[k] += sc[k];
    byCell.set(cellType, cur);
  }

  const top = Array.from(byCell.entries())
    .sort((a,b)=>b[1].n - a[1].n)
    .slice(0, 12);

  console.log('Query:', qtext);
  console.log('Organism:', organism, '| Assay:', assay || '(any)', '| Cell hint:', cell || '(none)');
  console.log('Experiments:', rows.length);
  console.log('\nTop cell types (n, ERROR, WARNING, NOT_COMPLIANT):');
  for (const [ct, obj] of top) {
    console.log('-', ct, '=>', 'n='+obj.n, '| ERR='+obj.sev.ERROR, '| WARN='+obj.sev.WARNING, '| NC='+obj.sev.NOT_COMPLIANT);
  }

  const bad = rows.filter(r => {
    const a = (r && r.audit) || {};
    return (Array.isArray(a.ERROR) && a.ERROR.length) || (Array.isArray(a.NOT_COMPLIANT) && a.NOT_COMPLIANT.length);
  }).slice(0, 5);

  if (bad.length) {
    console.log('\nExamples with issues:');
    for (const r of bad) {
      const acc = r.accession || r.uuid;
      const title = r.assay_title || r.assay_term_name;
      const cellType = getCell(r);
      const errs = ((r.audit && r.audit.ERROR) || []).map(x=>x.category).join(', ');
      const ncs  = ((r.audit && r.audit.NOT_COMPLIANT) || []).map(x=>x.category).join(', ');
      console.log('* ' + acc + ' | ' + title + ' | ' + cellType + ' | ERROR:[' + errs + '] NOT_COMPLIANT:[' + ncs + ']');
    }
  } else {
    console.log('\nNo problematic audits found among the first ' + rows.length + ' experiments for this query.');
  }
}

run().catch(e => { console.error(e); process.exit(1); });
