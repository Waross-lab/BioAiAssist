/**
 * evidence_report.mjs
 *
 * Entry point for generating a PDF report from an EvidenceBundle.  This script
 * accepts a free text question, constructs an EvidenceBundle via the
 * `buildEvidenceBundle` function from planner_normalizer_with_chembl.cjs, then
 * synthesizes a short summary and renders a polished HTML report.  Finally
 * puppeteer is used to print the HTML to a PDF.  Usage:
 *
 *    node evidence_report.mjs "What percent of MGMT promoter methylation ..." --pdf=out.pdf
 *
 * If the --pdf flag is omitted the report is saved as "report.pdf" in the
 * current working directory.  Temporary HTML files are written to the OS
 * temp directory and cleaned up automatically by the OS on exit.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Dynamically import the CommonJS EvidenceBundle builder.  Node will wrap
// planner_normalizer_with_chembl.cjs and expose its exports on the default
// export.  We destructure buildEvidenceBundle so downstream code can call it
// directly.
const { default: cjsModule } = await import('./planner_normalizer_with_chembl.cjs');
const { buildEvidenceBundle } = cjsModule;

/**
 * Escape HTML special characters in user-provided strings.  Without this
 * sanitization the report could be corrupted or become unsafe if the input
 * contains markup.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}

/**
 * Generate a terse summary of the bundle contents.  This heuristic touches
 * genes, drugs, publication and trial counts.  In the future this function
 * could be replaced by a call to a large language model to produce a more
 * nuanced narrative.
 */
function summarizeBundle(bundle) {
  const parts = [];
  const genes = Object.values(bundle?.gene_info || {}).map(g => g?.geneName || g?.accession).filter(Boolean);
  if (genes.length) parts.push(`Genes detected: ${genes.join(', ')}.`);
  const drugs = Object.keys(bundle?.compound_info || {});
  if (drugs.length) parts.push(`Drugs detected: ${drugs.join(', ')}.`);
  parts.push(`Found ${bundle?.literature?.length || 0} publications and ${bundle?.trials?.length || 0} clinical trials relevant to the query.`);
  return parts.join(' ');
}

/**
 * Render an HTML report from the EvidenceBundle and summary.  The markup uses
 * plain tables and a minimal neutral colour palette inspired by the smoke
 * report.  Additional styling or layout improvements can be made here without
 * affecting the PDF generation logic.
 */
function renderEvidenceHTML(bundle, summary) {
  const geneRows = Object.values(bundle?.gene_info || {}).map(g => `
    <tr>
      <td>${escapeHtml(g.accession)}</td>
      <td>${escapeHtml(g.geneName)}</td>
      <td>${escapeHtml(g.proteinName || '')}</td>
      <td>${escapeHtml(g.organism || '')}</td>
      <td>${escapeHtml(String(g.length ?? ''))}</td>
      <td>${escapeHtml(g.entryType || '')}</td>
    </tr>`).join('');
  const drugRows = Object.entries(bundle?.compound_info || {}).map(([drugKey, info]) => {
    const syns = (info?.synonyms || []).filter(Boolean).slice(0, 8).join(', ');
    const props = info?.properties || {};
    const molFormula = props?.MolecularFormula || props?.MOLFORMULA || props?.Formula || '';
    const molWeight = props?.MolecularWeight || props?.MOLWEIGHT || props?.ExactMass || '';
    const chemblId = info?.chembl?.molecule_chembl_id || '';
    return `
      <tr>
        <td>${escapeHtml(info?.name || drugKey)}</td>
        <td>${escapeHtml(syns)}</td>
        <td>${escapeHtml(molFormula)}</td>
        <td>${escapeHtml(molWeight)}</td>
        <td>${escapeHtml(chemblId)}</td>
      </tr>`;
  }).join('');
  const pubRows = (bundle?.literature || []).slice(0, 20).map(p => `
    <tr>
      <td>${escapeHtml(p.title || '')}</td>
      <td>${escapeHtml(String(p.year ?? ''))}</td>
      <td>${escapeHtml(p.journal || '')}</td>
      <td>${escapeHtml(p.pmid || '')}</td>
      <td>${escapeHtml(p.authors || '')}</td>
    </tr>`).join('');
  const trialRows = (bundle?.trials || []).slice(0, 15).map(t => `
    <tr>
      <td>${escapeHtml(t.nctId || '')}</td>
      <td>${escapeHtml(t.title || '')}</td>
      <td>${escapeHtml(String(t.phase ?? ''))}</td>
      <td>${escapeHtml(t.status || '')}</td>
      <td>${escapeHtml((t.conditions || t.condition || []).join('; '))}</td>
    </tr>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Evidence Report</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 28px; color: #111; }
    h1 { margin: 0 0 8px; }
    h2 { margin: 24px 0 8px; }
    p { margin: 8px 0; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; vertical-align: top; }
    th { background: #f8fafc; text-align: left; }
  </style>
</head>
<body>
  <h1>Evidence Report</h1>
  <p><strong>Question:</strong> ${escapeHtml(bundle?.question || '')}</p>
  <p>${escapeHtml(summary)}</p>
  <h2>Genes</h2>
  <table>
    <tr><th>Accession</th><th>Gene Name</th><th>Protein</th><th>Organism</th><th>Length</th><th>Entry Type</th></tr>
    ${geneRows || '<tr><td colspan="6">No genes found.</td></tr>'}
  </table>
  <h2>Drugs</h2>
  <table>
    <tr><th>Name</th><th>Synonyms</th><th>Molecular Formula</th><th>Molecular Weight</th><th>ChEMBL ID</th></tr>
    ${drugRows || '<tr><td colspan="5">No drugs found.</td></tr>'}
  </table>
  <h2>Publications</h2>
  <table>
    <tr><th>Title</th><th>Year</th><th>Journal</th><th>PMID</th><th>Authors</th></tr>
    ${pubRows || '<tr><td colspan="5">No publications found.</td></tr>'}
  </table>
  <h2>Clinical Trials</h2>
  <table>
    <tr><th>NCT ID</th><th>Title</th><th>Phase</th><th>Status</th><th>Condition(s)</th></tr>
    ${trialRows || '<tr><td colspan="5">No trials found.</td></tr>'}
  </table>
</body>
</html>`;
}

/**
 * Convert an HTML file into a PDF using puppeteer.  The PDF will be saved
 * at the specified absolute path.  Pages are rendered on A4 with default
 * margins; adjust puppeteer options here if a different layout is desired.
 */
async function printHtmlToPdf(htmlPath, pdfPath) {
  // Use a headless Chromium/Chrome to print the HTML to PDF.  Puppeteer is
  // intentionally avoided here because it is not available in this environment.
  // The command line arguments mirror those used in the smoke_openqa script.
  const candidates = [
    'chromium',
    'chrome',
    'google-chrome',
    'msedge',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const bin of candidates) {
    try {
      await execOnce(bin, ['--headless=new', '--disable-gpu', `--print-to-pdf=${pdfPath}`, htmlPath], 20000);
      return;
    } catch {
      // try next candidate
    }
  }
  throw new Error('No suitable headless browser found for PDF generation');
}

function execOnce(bin, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
    const to = setTimeout(() => { p.kill(); reject(new Error('timeout')); }, timeoutMs);
    p.on('exit', code => {
      clearTimeout(to);
      code === 0 ? resolve() : reject(new Error(`exit ${code}`));
    });
    p.on('error', err => {
      clearTimeout(to);
      reject(err);
    });
  });
}

/**
 * Main entry point.  Parses CLI flags, builds the EvidenceBundle, renders
 * the report and invokes PDF printing.  Errors are logged to stderr and
 * propagated to the Node process so CI scripts can detect failures.
 */
async function main() {
  const argv = process.argv.slice(2);
  const pdfArg = argv.find(a => a.startsWith('--pdf'));
  const pdfPath = pdfArg
    ? (pdfArg.includes('=') ? pdfArg.split('=')[1] : 'report.pdf')
    : 'report.pdf';
  const question = argv.filter(a => !a.startsWith('--pdf')).join(' ') || 'MGMT promoter methylation and temozolomide';
  const bundle = await buildEvidenceBundle(question);
  const summary = summarizeBundle(bundle);
  const html = renderEvidenceHTML(bundle, summary);
  // Write HTML to a temporary file in the OS tmpdir
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-report-'));
  const htmlFile = path.join(outDir, `report-${Date.now()}.html`);
  await fs.writeFile(htmlFile, html, 'utf8');
  const absolutePdf = path.isAbsolute(pdfPath) ? pdfPath : path.join(process.cwd(), pdfPath);
  await printHtmlToPdf(htmlFile, absolutePdf);
  console.log(`✅ PDF saved to: ${absolutePdf}`);
}

// Execute main immediately when this script is run directly.  When imported
// as a module the caller can invoke main() manually.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}