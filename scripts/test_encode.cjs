#!/usr/bin/env node
// scripts/test_encode.cjs  — robust ENCODE Experiment query helper
// Usage examples:
//   node scripts/test_encode.cjs "ChIP-seq in Homo sapiens GM12878"
//   node scripts/test_encode.cjs "RNA-seq in Mus musculus brain"

'use strict';

const { URLSearchParams } = require('url');

// Normalize common assay names to ENCODE's canonical "assay_term_name" values
function canonicalAssay(token) {
  if (!token) return null;
  const map = {
    'chip-seq': 'ChIP-seq',
    'atac-seq': 'ATAC-seq',
    'rna-seq': 'RNA-seq',
    'dnase-seq': 'DNase-seq',
    'hi-c': 'Hi-C',
  };
  const key = String(token).toLowerCase();
  return map[key] || null;
}

function detectAssay(q) {
  const m = String(q).match(/\b(chip-?seq|atac-?seq|rna-?seq|dnase-?seq|hi-?c)\b/i);
  return canonicalAssay(m && m[1]);
}

function detectOrganism(q) {
  const s = String(q).toLowerCase();
  if (s.includes('homo sapiens') || s.includes('human')) return 'Homo sapiens';
  if (s.includes('mus musculus') || s.includes('mouse')) return 'Mus musculus';
  if (s.includes('rattus norvegicus') || s.includes('rat')) return 'Rattus norvegicus';
  if (s.includes('drosophila melanogaster') || s.includes('fruit fly') || s.includes('drosophila')) return 'Drosophila melanogaster';
  if (s.includes('danio rerio') || s.includes('zebrafish')) return 'Danio rerio';
  if (s.includes('saccharomyces cerevisiae') || s.includes('yeast')) return 'Saccharomyces cerevisiae';
  if (s.includes('caenorhabditis elegans') || s.match(/\bc\.?\s*elegans\b/i)) return 'Caenorhabditis elegans';
  return null;
}

// Heuristic: treat the words after the organism as a biosample hint (e.g., "GM12878", "brain")
function detectBiosample(q, organism) {
  if (!organism) return null;
  const rx = new RegExp(organism.replace(/\s+/g, '\\s+') + '\\s+(.+)$', 'i');
  const m = String(q).match(rx);
  return m ? m[1].trim() : null;
}

// Build a query URL against either /search or /experiments/@@listing
function buildUrl(parts, useListing) {
  const base = useListing
    ? 'https://www.encodeproject.org/experiments/%40%40listing'
    : 'https://www.encodeproject.org/search/';
  const p = new URLSearchParams({ format: 'json', frame: 'object', limit: '100' });
  if (!useListing) p.set('type', 'Experiment');
  if (parts.assay) p.set('assay_term_name', parts.assay);
  if (parts.organism) p.set('replicates.library.biosample.organism.scientific_name', parts.organism);
  if (parts.biosample) {
    // Try exact ontology term name first; fall back to searchTerm if needed
    if (parts.useSearchTerm) p.set('searchTerm', parts.biosample);
    else p.set('biosample_ontology.term_name', parts.biosample);
  }
  return base + '?' + p.toString();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Non-JSON response (HTTP ${res.status}).`); }
  const total = data.total || (Array.isArray(data['@graph']) ? data['@graph'].length : 0);
  const empty = !total;
  return { status: res.status, url, data, total, empty };
}

(async () => {
  try {
    const q = process.argv.slice(2).join(' ').trim();
    if (!q) {
      console.error('Usage: node scripts/test_encode.cjs "<assay> in <organism> <biosample?>"');
      process.exit(64);
    }

    const assay = detectAssay(q);
    const organism = detectOrganism(q) || 'Homo sapiens';
    const biosample = detectBiosample(q, organism);

    const tries = [
      { assay, organism, biosample },
      { assay, organism },
      { organism, biosample },
      { assay },
      { organism },
      {},
    ];
    const bases = [false, true]; // false => /search, true => /experiments/@@listing

    let best = null;
    for (const useListing of bases) {
      for (const parts of tries) {
        let r = await fetchJson(buildUrl(parts, useListing));
        if (!best) best = r;
        if (!r.empty && r.status === 200) { best = r; break; }
        // If biosample is too strict, retry once using the "searchTerm" param
        if (parts.biosample && !parts.useSearchTerm && r.empty) {
          const r2 = await fetchJson(buildUrl({ ...parts, useSearchTerm: true }, useListing));
          if (!best) best = r2;
          if (!r2.empty && r2.status === 200) { best = r2; break; }
        }
      }
      if (best && !best.empty && best.status === 200) break;
    }

    console.log('Query :', q);
    console.log('Assay :', assay || '(any)');
    console.log('Organ :', organism || '(any)');
    console.log('BioSm :', biosample || '(any)');
    console.log('URL   :', best.url);
    console.log('HTTP  :', best.status);
    console.log('Total :', best.total);

    if (best.empty) {
      console.error('No results — try adjusting assay/organism/biosample (GM12878, K562, brain, etc.).');
      process.exit(2);
    }

    const rows = best.data['@graph'].slice(0, 10);
    for (const expt of rows) {
      const acc = expt.accession || expt['@id'];
      const assayName = expt.assay_term_name || expt.assay_title;
      const biosum = expt.biosample_summary;
      const target = expt.target && (expt.target.label || expt.target.title);
      console.log(`- ${acc} | ${assayName}${target ? ' | target: ' + target : ''} | ${biosum}`);
    }
  } catch (err) {
    console.error('ENCODE fetch failed:', err.message || err);
    process.exit(1);
  }
})();
