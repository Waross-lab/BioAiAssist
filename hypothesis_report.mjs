#!/usr/bin/env node
/**
 * hypothesis_report.mjs
 * Calls research.hypothesis.run and writes narrative.md + report.html + (optional) report.pdf via Puppeteer.
 *
 * Usage:
 *   node hypothesis_report.mjs [baseUrl] [outDir] "<hypothesis text>"
 */
const base = process.env.BASE_URL || process.argv[2] || 'http://localhost:8788/mcp';
const outDir = process.argv[3] || `hypothesis_out_${new Date().toISOString().replace(/[:.]/g,'-')}`;
const hypothesis = process.argv.slice(4).join(' ') || 'Working hypothesis';

import fs from 'fs';
import path from 'path';

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

async function main() {
  ensureDir(outDir);

  const spec = {
    hypothesis,
    research: {
      compounds: [{ name: 'ciprofloxacin' }, { name: 'levofloxacin' }],
      targets: [{ query: 'DNA gyrase' }, { query: 'topoisomerase' }],
      keywords: [hypothesis],
      sources: ['pubchem','chembl','uniprot','entrez','europepmc','openalex'],
      options: { pchemblOnly: true, maxPerSource: 50, organism_contains: 'Escherichia' }
    }
  };

  const res = await callTool('research.hypothesis.run', spec);

  fs.writeFileSync(path.join(outDir, 'narrative.md'), res.narrative_md);
  fs.writeFileSync(path.join(outDir, 'report.html'), res.html);

  // Optional PDF (install puppeteer if you want this)
  try {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    const htmlPath = 'file://' + path.resolve(path.join(outDir, 'report.html')).replace(/\\/g,'/');
    await page.goto(htmlPath, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: path.join(outDir, 'report.pdf'),
      format: 'Letter',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' }
    });
    await browser.close();
  } catch {
    fs.writeFileSync(path.join(outDir, 'PDF_INSTRUCTIONS.txt'),
`To generate a PDF, install Puppeteer in this project:
  npm i puppeteer
then re-run:
  node hypothesis_report.mjs ${base} ${outDir} "${hypothesis}"
`);
  }

  console.log(JSON.stringify({
    base, outDir, hypothesis,
    counts: {
      compounds: res.metrics?.counts?.compounds ?? 0,
      targets: res.metrics?.counts?.targets ?? 0,
      assays: res.metrics?.counts?.assays ?? 0,
      literature: res.metrics?.counts?.literature ?? 0,
    }
  }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
