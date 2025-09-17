/**
 * MCP Bio Tools Connector (Starter)
 * ---------------------------------
 * Adds BLAST (NCBI URL API), Ensembl REST, and literature search tools (OpenAlex, Europe PMC, Crossref)
 * to the JSON-RPC MCP server.
 *
 * HOW TO USE
 * 1) `npm init -y`
 * 2) `npm install express body-parser cors node-fetch@3 zod`
 * 3) Save as `bio-mcp.ts`, run `npx ts-node bio-mcp.ts` (or transpile with tsc)
 * 4) Set env vars (optional but recommended):
 *    - EMAIL=ross416@marshall.edu  (for polite API usage headers)
 *    - USER_AGENT="BioMCP/0.1 (ross416@marshall.edu)"
 * 5) ChatGPT → Settings → Connectors → Add → Developer Mode → Base URL: http://<host>:8788/mcp
 */

import { registerGetWrapper } from './registerGetWrapper.js';
import { HypothesisRun, hypothesisRun } from './hypothesis_orchestrator.js';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { z } from 'zod';
import { ResearchRun, researchRun } from './research_orchestrator.js';
import { NormalizeEntitiesInput, normalizeEntities } from './stage2_normalization.js';
import { searchTrialsCtgov } from "./src/openqa/clients/ctgov_client.js";

// Optional: polyfill fetch on Node < 18 using undici
try {
  // @ts-ignore
  if (typeof (globalThis as any).fetch === 'undefined') {
    // Dynamically import to avoid hard dependency if not needed
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const undici = require('undici');
    (globalThis as any).fetch = undici.fetch;
    (globalThis as any).Headers = undici.Headers;
    (globalThis as any).Request = undici.Request;
    (globalThis as any).Response = undici.Response;
  }
} catch {}
// -------- Config --------
const PORT = Number(process.env.PORT || 8788);
const EMAIL = process.env.EMAIL || 'student@example.edu';
const USER_AGENT = process.env.USER_AGENT || `mcp-bio-tools/0.1 (${EMAIL})`;

// Shared fetch options respecting API etiquette
function headers(extra: Record<string,string> = {}) {
  return { 'User-Agent': USER_AGENT, 'Accept': 'application/json', ...extra };
}

// -------- JSON-RPC helpers --------
function ok(id: any, result: any) { return { jsonrpc: '2.0', id, result }; }
function err(id: any, code: number, message: string, data?: any) { return { jsonrpc: '2.0', id, error: { code, message, data } }; }

// ---------- Math helpers for stats ----------
function mean(a: number[]) { return a.reduce((s,x)=>s+x,0)/a.length; }
function variance(a: number[], m = mean(a)) {
  const n = a.length; return a.reduce((s,x)=>s+(x-m)*(x-m),0)/(n-1);
}
function stddev(a: number[]) { return Math.sqrt(variance(a)); }
function cov(x: number[], y: number[], mx = mean(x), my = mean(y)) {
  const n = x.length; let s = 0;
  for (let i=0;i<n;i++) s += (x[i]-mx)*(y[i]-my);
  return s/(n-1);
}
function pearsonR(x: number[], y: number[]) {
  if (x.length !== y.length) throw new Error('x and y must have same length');
  if (x.length < 3) throw new Error('need at least 3 points for Pearson r');
  const sx = stddev(x), sy = stddev(y);
  if (sx === 0 || sy === 0) return { r: 0, undefinedVariance: true };
  const r = cov(x,y)/ (sx*sy);
  return { r };
}
// Average ranks with tie-handling
function ranks(a: number[]) {
  const n = a.length;
  const idx = a.map((v,i)=>({v,i})).sort((A,B)=>A.v-B.v);
  const r = Array(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i+1;
    while (j < n && idx[j].v === idx[i].v) j++;
    const rank = (i + j - 1)/2 + 1; // average rank (1-based)
    for (let k=i;k<j;k++) r[idx[k].i] = rank;
    i = j;
  }
  return r;
}
function spearmanRho(x: number[], y: number[]) {
  if (x.length !== y.length) throw new Error('x and y must have same length');
  const rx = ranks(x), ry = ranks(y);
  return pearsonR(rx, ry).r;
}
// Normal CDF via erf approximation
function erf(z: number) {
  // Abramowitz-Stegun approximation
  const t = 1/(1+0.5*Math.abs(z));
  const tau = t*Math.exp(-z*z -1.26551223 + 1.00002368*t + 0.37409196*t*t + 0.09678418*t**3
    -0.18628806*t**4 + 0.27886807*t**5 -1.13520398*t**6 + 1.48851587*t**7 -0.82215223*t**8 + 0.17087277*t**9);
  return z>=0 ? 1 - tau : tau - 1;
}
function normalCDF(z: number) { return 0.5*(1+erf(z/Math.SQRT2)); }
// Two-tailed p from Fisher z-transform (approx, good for n ≥ ~10)
function pvalFromR(r: number, n: number) {
  if (n < 4 || Math.abs(r)>=1) return NaN;
  const z = 0.5*Math.log((1+r)/(1-r)) * Math.sqrt(n-3);
  const p = 2*(1 - normalCDF(Math.abs(z)));
  return p;
}
// Simple OLS y = a + b x
function ols(x: number[], y: number[]) {
  if (x.length !== y.length) throw new Error('x and y must have same length');
  const n = x.length; if (n < 2) throw new Error('need at least 2 points');
  const mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0;
  for (let i=0;i<n;i++) { sxx += (x[i]-mx)*(x[i]-mx); sxy += (x[i]-mx)*(y[i]-my); }
  const b = sxy/sxx;
  const a = my - b*mx;
  // r and R^2
  const sdX = stddev(x), sdY = stddev(y);
  const r = (sdX===0 || sdY===0) ? 0 : sxy/((n-1)*sdX*sdY);
  const r2 = r*r;
  return { intercept: a, slope: b, r, r2 };
}

// -------- Schemas --------
// ---- New env (top of file, with the other consts) ----
const DRUGBANK_BASE = process.env.DRUGBANK_BASE || 'https://api.drugbank.com/v1';
const DRUGBANK_API_KEY = process.env.DRUGBANK_API_KEY || '';

// ---------- Stats schemas ----------
const StatsArrayPair = z.object({
  x: z.array(z.number()),
  y: z.array(z.number())
});
const StatsDescribe = z.object({
  x: z.array(z.number())
});

// ---- UniProt schemas ----
const UniProtSearch = z.object({
  query: z.string(),                    // UniProtKB query syntax, e.g. "gene:gyrA AND organism_id:287"
  size: z.number().int().min(1).max(500).default(25),
  fields: z.string().optional(),        // comma-separated e.g. "accession,protein_name,organism_name,length"
});

const UniProtGet = z.object({
  accession: z.string(),                // e.g. "P0AES9"
  fields: z.string().optional(),
});

// ---- DrugBank schemas (requires API key) ----
const DrugBankSearch = z.object({
  query: z.string(),                    // free-text, e.g. "ciprofloxacin" or "DNA gyrase"
  page: z.number().int().min(1).max(50).default(1),
  per_page: z.number().int().min(1).max(100).default(25),
});

const DrugBankGet = z.object({
  id: z.string(),                       // DrugBank ID, e.g. "DB00537"
});


const BlastSubmit = z.object({
  program: z.enum(['blastn','blastp','blastx','tblastn','tblastx']).default('blastn'),
  db: z.string().default('nt'),
  sequence: z.string().min(6),
  entrez_query: z.string().optional(), // e.g., txid9606[ORGN] to restrict to human
});

const BlastPoll = z.object({ rid: z.string() });

const BlastFetch = z.object({
  rid: z.string(),
  format: z.enum(['JSON2_S','XML','HTML']).default('JSON2_S'),
});

const EnsemblOverlap = z.object({
  species: z.string().default('human'),
  region: z.string(), // e.g., 7:55019017-55020017
  feature: z.enum(['gene','transcript','regulatory']).default('gene')
});

const EnsemblXrefs = z.object({ species: z.string().default('human'), id: z.string() });

const EuropePmcSearch = z.object({
  query: z.string(), // e.g., "sickle cell AND hydroxyurea"
  pageSize: z.number().int().min(1).max(100).default(25),
});

const OpenAlexWorks = z.object({
  search: z.string().optional(), // free-text
  filter: z.string().optional(), // e.g., "from_publication_date:2020-01-01,primary_location.source.host_organization_name:bioRxiv"
  per_page: z.number().int().min(1).max(200).default(25),
});

const CrossrefWorks = z.object({
  query: z.string().optional(),
  rows: z.number().int().min(1).max(100).default(25),
  filter: z.string().optional(), // e.g., 'from-pub-date:2020-01-01,has-full-text:true'
});

// -------- Tool implementations --------
const tools: any[] = [];

// --- Typed JSON helper to avoid 'unknown' from fetch().json() under strict TS ---
async function jsonAny(res: Response): Promise<any> {
  return (await res.json()) as any;
}

// 1) NCBI BLAST (URL API)
// Submit
tools.push({
  name: 'blast.submit',
  description: 'Submit a BLAST job to NCBI URLAPI',
  inputSchema: BlastSubmit,
  handler: async (input: any) => {
    const p = BlastSubmit.parse(input);
    const params = new URLSearchParams({
      CMD: 'Put',
      PROGRAM: p.program,
      DATABASE: p.db,
      QUERY: p.sequence,
    });
    if (p.entrez_query) params.set('ENTREZ_QUERY', p.entrez_query);
    const r = await fetch('https://blast.ncbi.nlm.nih.gov/Blast.cgi', { method: 'POST', body: params, headers: headers({'Accept':'text/plain'}) });
    const txt = await r.text();
    const rid = /RID = (\S+)/.exec(txt)?.[1];
    const rtoe = /RTOE = (\d+)/.exec(txt)?.[1];
    if (!rid) throw new Error('BLAST submit failed: no RID in response');
    return { rid, rtoe: rtoe ? Number(rtoe) : undefined };
  }
});

// Poll
tools.push({
  name: 'blast.poll',
  description: 'Check BLAST job status',
  inputSchema: BlastPoll,
  handler: async (input: any) => {
    const p = BlastPoll.parse(input);
    const url = new URL('https://blast.ncbi.nlm.nih.gov/Blast.cgi');
    url.searchParams.set('CMD','Get');
    url.searchParams.set('RID', p.rid);
    url.searchParams.set('FORMAT_OBJECT', 'SearchInfo');
    const r = await fetch(url.toString(), { headers: headers({'Accept':'text/plain'}) });
    const txt = await r.text();
    if (/Status=WAITING/.test(txt)) return { status: 'WAITING' };
    if (/Status=FAILED/.test(txt)) return { status: 'FAILED' };
    if (/Status=UNKNOWN/.test(txt)) return { status: 'UNKNOWN' };
    if (/Status=READY/.test(txt)) return { status: 'READY', has_hits: /ThereAreHits=yes/.test(txt) };
    return { status: 'UNKNOWN', raw: txt };
  }
});

// Fetch
tools.push({
  name: 'blast.fetch',
  description: 'Fetch BLAST results when READY',
  inputSchema: BlastFetch,
  handler: async (input: any) => {
    const p = BlastFetch.parse(input);
    const url = new URL('https://blast.ncbi.nlm.nih.gov/Blast.cgi');
    url.searchParams.set('CMD','Get');
    url.searchParams.set('RID', p.rid);
    if (p.format === 'JSON2_S') { // structured JSON summary
      url.searchParams.set('FORMAT_OBJECT', 'Alignment');
      url.searchParams.set('ALIGNMENT_VIEW', 'Pairwise');
      url.searchParams.set('FORMAT_TYPE', 'JSON2_S');
    } else if (p.format === 'XML') {
      url.searchParams.set('FORMAT_TYPE', 'XML');
    } else {
      url.searchParams.set('FORMAT_TYPE', 'HTML');
    }
    const r = await fetch(url.toString(), { headers: headers() });
    const ct = r.headers.get('content-type')||'';
    if (ct.includes('json')) return await r.json();
    const text = await r.text();
    return { raw: text, contentType: ct };
  }
});

// ---- Helper: summarize BLAST JSON2_S into Top-Taxa table ----
function summarizeBlastJson(json: any, top_n = 15) {
  try {
    const hits = json?.BlastOutput2?.[0]?.report?.results?.search?.hits || [];
    const rows = hits.map((hit: any) => {
      const d = hit?.description?.[0] || {};
      const h = hit?.hsps?.[0] || {};
      const align = Number(h?.align_len || 0);
      const ident = Number(h?.identity || 0);
      const pct = align > 0 ? Math.round((100 * ident / align) * 10) / 10 : 0;
      // description can be an object; keys vary slightly by format
      const accession = d.accession ?? d.accessionversion ?? d.accver ?? d.id ?? null;
      const title = d.title ?? d.def ?? d.definition ?? null;
      let taxon = d.sciname ?? d.organism ?? null;
      if (!taxon && typeof title === 'string' && title.includes('[')) {
        const m = title.match(/\[(.+?)\]\s*$/);
        if (m) taxon = m[1];
      }
      return { taxon: taxon || '(unknown)', accession, title, evalue: h?.evalue ?? null, identityP: pct };
    });

    // group by taxon and pick best-identity example
    const byTaxon: Record<string, { count: number; best: any }> = {};
    for (const r of rows) {
      const key = r.taxon;
      if (!byTaxon[key]) byTaxon[key] = { count: 0, best: r };
      byTaxon[key].count += 1;
      if ((r.identityP ?? 0) > (byTaxon[key].best.identityP ?? 0)) byTaxon[key].best = r;
    }

    const out = Object.entries(byTaxon)
      .map(([taxon, v]) => ({
        taxon,
        hitCount: v.count,
        bestIdentity: v.best.identityP ?? 0,
        bestEvalue: v.best.evalue ?? null,
        exampleAccession: v.best.accession ?? null,
      }))
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, top_n);

    return { topTaxa: out, totalHits: hits.length };
  } catch (e: any) {
    return { error: e?.message || 'Failed to summarize BLAST JSON' };
  }
}

// ---- Tool: blast.summarize_taxa ----
// NOTE: You already imported `z` from 'zod' at the top of the file.
const BlastSummarize = z.object({
  rid: z.string().optional(),        // Provide a BLAST RID to fetch + summarize
  json: z.any().optional(),          // OR pass raw JSON2_S (from blast.fetch)
  top_n: z.number().int().min(1).max(50).default(15),
});

tools.push({
  name: 'blast.summarize_taxa',
  description: 'Summarize BLAST JSON2_S into a Top-Taxa table; accepts a RID to fetch or raw JSON.',
  inputSchema: BlastSummarize,
  handler: async (input: any) => {
    const p = BlastSummarize.parse(input);
    let json = p.json;

    if (!json && p.rid) {
      // Fetch JSON2_S from NCBI by RID (same format as blast.fetch JSON path)
      const url = new URL('https://blast.ncbi.nlm.nih.gov/Blast.cgi');
      url.searchParams.set('CMD', 'Get');
      url.searchParams.set('RID', p.rid);
      url.searchParams.set('FORMAT_OBJECT', 'Alignment');
      url.searchParams.set('ALIGNMENT_VIEW', 'Pairwise');
      url.searchParams.set('FORMAT_TYPE', 'JSON2_S');

      const r = await fetch(url.toString(), { headers: headers() });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) {
        const raw = await r.text();
        return { note: 'Result is not JSON; cannot summarize', contentType: ct, raw: raw.slice(0, 500) };
      }
      json = await r.json();
    }

    if (!json) throw new Error('Provide either "rid" or "json".');
    return summarizeBlastJson(json, p.top_n);
  },
});

// ---- Helper: flatten BLAST hit row ----
function hitRow(hit: any) {
  const d = hit?.description?.[0] || {};
  const h = hit?.hsps?.[0] || {};
  const align = Number(h?.align_len || 0);
  const ident = Number(h?.identity || 0);
  const pct = align > 0 ? Math.round((100 * ident / align) * 10) / 10 : 0;
  return {
    accession: d.accession ?? d.accessionversion ?? d.accver ?? d.id ?? null,
    sciname: d.sciname ?? d.organism ?? null,
    title: d.title ?? d.def ?? d.definition ?? null,
    evalue: h?.evalue ?? null,
    identityP: pct,
    alignLen: align,
  };
}

const BlastTopHits = z.object({
  rid: z.string().optional(),
  json: z.any().optional(),
  top_n: z.number().int().min(1).max(500).default(50),
  organism_filter: z.string().optional(),
});

tools.push({
  name: 'blast.top_hits',
  description: 'Return a clean top-N hits table (accession, species, title, %identity, E-value, align length).',
  inputSchema: BlastTopHits,
  handler: async (input: any) => {
    const p = BlastTopHits.parse(input);

    let json: any = p.json;
    if (!json && p.rid) {
      const url = new URL('https://blast.ncbi.nlm.nih.gov/Blast.cgi');
      url.searchParams.set('CMD','Get');
      url.searchParams.set('RID', p.rid);
      url.searchParams.set('FORMAT_OBJECT','Alignment');
      url.searchParams.set('ALIGNMENT_VIEW','Pairwise');
      url.searchParams.set('FORMAT_TYPE','JSON2_S');
      const r = await fetch(url.toString(), { headers: headers() });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) return { error: 'Non-JSON response from NCBI' };
      json = await r.json();
    }
    if (!json) throw new Error('Provide either "rid" or "json".');

    const hits: any[] = json?.BlastOutput2?.[0]?.report?.results?.search?.hits || [];
    let rows: any[] = (hits as any[]).map((h: any) => hitRow(h));
    if (p.organism_filter) rows = rows.filter((r: any) => (r.sciname || '') === p.organism_filter);

    const out: any[] = rows
      .sort((a: any, b: any) =>
        (a.evalue ?? 1) - (b.evalue ?? 1) ||
        (b.identityP ?? 0) - (a.identityP ?? 0)
      )
      .slice(0, p.top_n);

    return { totalHits: rows.length, rows: out };
  },
});

// 2) Ensembl REST (overlaps & xrefs)
tools.push({
  name: 'ensembl.overlap',
  description: 'Ensembl overlap region → features (genes/transcripts/regulatory)',
  inputSchema: EnsemblOverlap,
  handler: async (input: any) => {
    const p = EnsemblOverlap.parse(input);
    const url = `https://rest.ensembl.org/overlap/region/${encodeURIComponent(p.species)}/${encodeURIComponent(p.region)}?feature=${p.feature};content-type=application/json`;
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) throw new Error(`Ensembl overlap error ${r.status}`);
    return await r.json();
  }
});

tools.push({
  name: 'ensembl.xrefs',
  description: 'Ensembl xrefs for an Ensembl ID',
  inputSchema: EnsemblXrefs,
  handler: async (input: any) => {
    const p = EnsemblXrefs.parse(input);
    const url = `https://rest.ensembl.org/xrefs/id/${encodeURIComponent(p.id)}?content-type=application/json`;
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) throw new Error(`Ensembl xrefs error ${r.status}`);
    return await r.json();
  }
});

// 3) Literature search: Europe PMC, OpenAlex, Crossref
tools.push({
  name: 'europepmc.search',
  description: 'Europe PMC Articles search (open/full-text where available)',
  inputSchema: EuropePmcSearch,
  handler: async (input: any) => {
    const p = EuropePmcSearch.parse(input);
    const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
    url.searchParams.set('query', p.query);
    url.searchParams.set('pageSize', String(p.pageSize));
    url.searchParams.set('format', 'json');
    const r = await fetch(url.toString(), { headers: headers() });
    if (!r.ok) throw new Error(`EuropePMC error ${r.status}`);
    return await r.json();
  }
});

tools.push({
  name: 'openalex.works',
  description: 'OpenAlex works search (scholarly metadata graph)',
  inputSchema: OpenAlexWorks,
  handler: async (input: any) => {
    const p = OpenAlexWorks.parse(input);
    const url = new URL('https://api.openalex.org/works');
    if (p.search) url.searchParams.set('search', p.search);
    if (p.filter) url.searchParams.set('filter', p.filter);
    url.searchParams.set('per-page', String(p.per_page));
    const r = await fetch(url.toString(), { headers: headers() });
    if (!r.ok) throw new Error(`OpenAlex error ${r.status}`);
    return await r.json();
  }
});

tools.push({
  name: 'crossref.works',
  description: 'Crossref works search (DOIs, funding, licenses, links)',
  inputSchema: CrossrefWorks,
  handler: async (input: any) => {
    const p = CrossrefWorks.parse(input);
    const url = new URL('https://api.crossref.org/works');
    if (p.query) url.searchParams.set('query', p.query);
    if (p.filter) url.searchParams.set('filter', p.filter);
    url.searchParams.set('rows', String(p.rows));
    const r = await fetch(url.toString(), { headers: headers({ 'mailto': EMAIL }) });
    if (!r.ok) throw new Error(`Crossref error ${r.status}`);
    return await r.json();
  }
});

// 4) NCBI Entrez (PubMed quick search via E-utilities)
const EntrezSearch = z.object({ db: z.enum(['pubmed','gene','nuccore','protein']).default('pubmed'), term: z.string(), retmax: z.number().int().min(1).max(200).default(20) });
const EntrezFetch = z.object({ db: z.enum(['pubmed','gene','nuccore','protein']).default('pubmed'), id: z.string(), rettype: z.string().default('abstract'), retmode: z.enum(['json','xml','text']).default('json') });

tools.push({
  name: 'entrez.esearch',
  description: 'NCBI E-utilities esearch (PubMed/Gene/etc.)',
  inputSchema: EntrezSearch,
  handler: async (input: any) => {
    const p = EntrezSearch.parse(input);
    const url = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
    url.searchParams.set('db', p.db);
    url.searchParams.set('term', p.term);
    url.searchParams.set('retmax', String(p.retmax));
    url.searchParams.set('retmode', 'json');
    const r = await fetch(url.toString(), { headers: headers() });
    if (!r.ok) throw new Error(`Esearch error ${r.status}`);
    return await r.json();
  }
});

tools.push({
  name: 'entrez.efetch',
  description: 'NCBI E-utilities efetch (PubMed abstracts, etc.)',
  inputSchema: EntrezFetch,
  handler: async (input: any) => {
    const p = EntrezFetch.parse(input);
    const url = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi');
    url.searchParams.set('db', p.db);
    url.searchParams.set('id', p.id);
    url.searchParams.set('rettype', p.rettype);
    url.searchParams.set('retmode', p.retmode);
    const r = await fetch(url.toString(), { headers: headers() });
    const ct = r.headers.get('content-type')||'';
    if (ct.includes('json')) return await r.json();
    const text = await r.text();
    return { raw: text, contentType: ct };
  }
});

const BlastSubjectRegions = z.object({
  rid: z.string(),
  organism_filter: z.string().optional(),
  max_hits: z.number().int().min(1).max(100).default(10),
  flank: z.number().int().min(0).max(500).default(50),
});

async function efetchNuccoreFastaSeq(idOrAcc: string) {
  const url = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi');
  url.searchParams.set('db','nuccore');
  url.searchParams.set('id', idOrAcc);
  url.searchParams.set('rettype','fasta');
  url.searchParams.set('retmode','text');
  const r = await fetch(url.toString(), { headers: headers() });
  const txt = await r.text();
  const seq = txt.split('\n').filter(l => !l.startsWith('>')).join('').trim().toUpperCase();
  return seq;
}

tools.push({
  name: 'blast.subject_regions',
  description: 'For each BLAST hit, fetch subject sequence and return aligned region with ±flank context.',
  inputSchema: BlastSubjectRegions,
  handler: async (input: any) => {
    const p = BlastSubjectRegions.parse(input);

    // Fetch BLAST JSON2_S by RID
    const url = new URL('https://blast.ncbi.nlm.nih.gov/Blast.cgi');
    url.searchParams.set('CMD','Get');
    url.searchParams.set('RID', p.rid);
    url.searchParams.set('FORMAT_OBJECT','Alignment');
    url.searchParams.set('ALIGNMENT_VIEW','Pairwise');
    url.searchParams.set('FORMAT_TYPE','JSON2_S');
    const r = await fetch(url.toString(), { headers: headers() });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return { error: 'Non-JSON response from NCBI' };
    const json: any = await r.json(); // typed

    const hits: any[] = json?.BlastOutput2?.[0]?.report?.results?.search?.hits || [];
    let rows: any[] = hits.map((hit: any) => {
      const d = hit?.description?.[0] || {};
      const h = hit?.hsps?.[0] || {};
      const base = hitRow(hit);
      return {
        ...base,
        hit_from: Number(h?.hit_from ?? 0),
        hit_to: Number(h?.hit_to ?? 0),
        qseq: h?.qseq ?? null,
        hseq: h?.hseq ?? null,
        midline: h?.midline ?? null,
      };
    });

    if (p.organism_filter) rows = rows.filter((r: any) => (r.sciname || '') === p.organism_filter);
    rows = rows.slice(0, p.max_hits);

    const out: any[] = [];
    for (const row of rows) {
      const acc = row.accession;
      if (!acc) { out.push({ error: 'missing accession', row }); continue; }
      try {
        const subj = await efetchNuccoreFastaSeq(acc);
        const len = subj.length;
        const start0 = Math.max(0, Math.min(row.hit_from, row.hit_to) - 1 - p.flank);
        const end0 = Math.min(len, Math.max(row.hit_from, row.hit_to) + p.flank);
        const context = subj.slice(start0, end0);
        out.push({
          accession: acc,
          sciname: row.sciname,
          title: row.title,
          coords: `${row.hit_from}-${row.hit_to} of ${len}`,
          evalue: row.evalue,
          identityP: row.identityP,
          alignLen: row.alignLen,
          flank: p.flank,
          qseq: row.qseq,
          midline: row.midline,
          hseq: row.hseq,
          subject_context: context,
        });
      } catch (e: any) {
        out.push({ accession: acc, error: e?.message || 'efetch failed' });
      }
    }
    return { count: out.length, regions: out };
  },
});

const LiteratureTriage = z.object({
  queries: z.array(z.string()),
  per_query: z.number().int().min(1).max(25).default(5),
});

tools.push({
  name: 'literature.triage',
  description: 'Search Europe PMC for each query and return top papers (title, journal, year, link).',
  inputSchema: LiteratureTriage,
  handler: async (input: any) => {
    const p = LiteratureTriage.parse(input);
    const all: any[] = [];
    for (const q of p.queries) {
      const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
      url.searchParams.set('query', q);
      url.searchParams.set('pageSize', String(p.per_query));
      url.searchParams.set('format', 'json');
      const r = await fetch(url.toString(), { headers: headers() });
      const js: any = await r.json(); // typed
      const docs: any[] = js?.resultList?.result || [];
      all.push({
        query: q,
        results: docs.map((d: any) => ({
          title: d.title,
          journal: d.journalTitle,
          year: d.pubYear,
          authors: d.authorString,
          source: d.source,
          pmid: d.pmid,
          pmcid: d.pmcid,
          doi: d.doi,
          link: d.pmcid ? `https://europepmc.org/article/pmc/${d.pmcid}` :
                d.pmid ? `https://europepmc.org/abstract/MED/${d.pmid}` :
                d.doi  ? `https://doi.org/${d.doi}` : null,
        })),
      });
    }
    return { batches: all };
  },
});

// ========== UniProt (public REST) ==========
tools.push({
  name: 'uniprot.search',
  description: 'UniProtKB search (public REST). Returns JSON search results.',
  inputSchema: UniProtSearch,
  handler: async (input: any) => {
    const p = UniProtSearch.parse(input);
    const url = new URL('https://rest.uniprot.org/uniprotkb/search');
    url.searchParams.set('query', p.query);
    url.searchParams.set('size', String(p.size));
    url.searchParams.set('format', 'json');
    if (p.fields) url.searchParams.set('fields', p.fields);
    const r = await fetch(url.toString(), { headers: headers() });
    if (!r.ok) throw new Error(`UniProt search error ${r.status}`);
    return await r.json();
  }
});

tools.push({
  name: 'uniprot.get',
  description: 'UniProtKB entry by accession (public REST).',
  inputSchema: UniProtGet,
  handler: async (input: any) => {
    const p = UniProtGet.parse(input);
    const path = `https://rest.uniprot.org/uniprotkb/${encodeURIComponent(p.accession)}.json`;
    const url = new URL(path);
    if (p.fields) url.searchParams.set('fields', p.fields);
    const r = await fetch(url.toString(), { headers: headers() });
    if (!r.ok) throw new Error(`UniProt get error ${r.status}`);
    return await r.json();
  }
});

// ========== DrugBank (requires API key) ==========
// NOTE: DrugBank’s API is licensed. Set DRUGBANK_API_KEY (and DRUGBANK_BASE if your plan differs) before use.
tools.push({
  name: 'drugbank.search',
  description: 'DrugBank search (requires DRUGBANK_API_KEY). Returns paginated JSON if your plan allows.',
  inputSchema: DrugBankSearch,
  handler: async (input: any) => {
    const p = DrugBankSearch.parse(input);
    if (!DRUGBANK_API_KEY) throw new Error('Set DRUGBANK_API_KEY in environment to use DrugBank.');
    const url = new URL(`${DRUGBANK_BASE}/drugs`);
    // Many DrugBank deployments accept `query`, `page`, `per_page` (exact params can vary by plan/version)
    url.searchParams.set('query', p.query);
    url.searchParams.set('page', String(p.page));
    url.searchParams.set('per_page', String(p.per_page));

    const r = await fetch(url.toString(), {
      headers: headers({
        'Authorization': `Bearer ${DRUGBANK_API_KEY}`,
        'Accept': 'application/json'
      })
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`DrugBank search ${r.status}: ${txt.slice(0,300)}`);
    }
    return await r.json();
  }
});

tools.push({
  name: 'drugbank.get',
  description: 'DrugBank drug by ID (requires DRUGBANK_API_KEY).',
  inputSchema: DrugBankGet,
  handler: async (input: any) => {
    const p = DrugBankGet.parse(input);
    if (!DRUGBANK_API_KEY) throw new Error('Set DRUGBANK_API_KEY in environment to use DrugBank.');
    const url = new URL(`${DRUGBANK_BASE}/drugs/${encodeURIComponent(p.id)}`);
    const r = await fetch(url.toString(), {
      headers: headers({
        'Authorization': `Bearer ${DRUGBANK_API_KEY}`,
        'Accept': 'application/json'
      })
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`DrugBank get ${r.status}: ${txt.slice(0,300)}`);
    }
    return await r.json();
  }
});

// 5) Small-molecule data: PubChem + ChEMBL
// ----------------------------------------

/**
 * PubChem PUG REST (no API key required)
 * Docs: https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest
 * We support:
 *  - pubchem.compound.search   (by name/smiles/inchikey/inchi/cid)
 *  - pubchem.compound.props    (properties for 1+ CIDs)
 *  - pubchem.compound.synonyms (synonyms for a CID)
 */

const PubChemSearch = z.object({
  namespace: z.enum(['name','smiles','inchikey','inchi','cid']).default('name'),
  identifier: z.string(),          // e.g. "ciprofloxacin"
  listkey: z.string().optional(),  // advanced (ignored for now)
  max: z.number().int().min(1).max(200).default(25),
});

const PubChemProps = z.object({
  cids: z.union([z.string(), z.array(z.string())]),   // "1234" or ["1234","2244"]
  // Pick a sane default property set
  properties: z.string().default('InChIKey,CanonicalSMILES,MolecularFormula,MolecularWeight,XLogP,TPSA,HBondDonorCount,HBondAcceptorCount,RotatableBondCount')
});

const PubChemSynonyms = z.object({
  cid: z.string()
});

tools.push({
  name: 'pubchem.compound.search',
  description: 'Search PubChem compounds by name/smiles/inchikey/inchi/cid; returns CIDs and basic props.',
  inputSchema: PubChemSearch,
  handler: async (input: any) => {
    const p = PubChemSearch.parse(input);

    // PubChem namespace path (allowed: name | smiles | inchikey | inchi | cid)
    const pathNs = p.namespace;
    const base = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';

    // 1) Find CIDs
    const url = `${base}/compound/${encodeURIComponent(pathNs)}/${encodeURIComponent(p.identifier)}/cids/JSON`;
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) throw new Error(`PubChem search error ${r.status}`);
    const j: any = await jsonAny(r);
    const ids: string[] = (j?.IdentifierList?.CID ?? []).map((x: any) => String(x));

    // 2) Fetch quick properties (if any CIDs)
    let props: any[] = [];
    if (ids.length > 0) {
      const take = ids.slice(0, p.max ?? 5);
      const propUrl = `${base}/compound/cid/${take.join(',')}/property/InChIKey,CanonicalSMILES,MolecularFormula,MolecularWeight,XLogP,TPSA,HBondDonorCount,HBondAcceptorCount,RotatableBondCount/JSON`;
      const pr = await fetch(propUrl, { headers: headers() });
      if (pr.ok) {
        const pj: any = await jsonAny(pr);
        props = (pj?.PropertyTable?.Properties ?? []) as any[];
      }
    }

    return {
      cids: ids.slice(0, p.max ?? 5),
      properties: props
    };
  }
});


tools.push({
  name: 'pubchem.compound.props',
  description: 'Fetch PubChem compound properties for one or more CIDs.',
  inputSchema: PubChemProps,
  handler: async (input: any) => {
    const p = PubChemProps.parse(input);
    const cids = Array.isArray(p.cids) ? p.cids : [p.cids];
    const base = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
    const url = `${base}/compound/cid/${cids.join(',')}/property/InChIKey,CanonicalSMILES,MolecularFormula,MolecularWeight,XLogP,TPSA,HBondDonorCount,HBondAcceptorCount,RotatableBondCount/JSON`;
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) throw new Error(`PubChem props error ${r.status}`);
    const js: any = await jsonAny(r);
    return js?.PropertyTable?.Properties ?? [];
  }
});

tools.push({
  name: 'pubchem.compound.synonyms',
  description: 'Fetch PubChem synonyms for a single CID.',
  inputSchema: PubChemSynonyms,
  handler: async (input: any) => {
    const p = PubChemSynonyms.parse(input);
    const base = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
    const url = `${base}/compound/cid/${encodeURIComponent(p.cid)}/synonyms/JSON`;
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) throw new Error(`PubChem synonyms error ${r.status}`);
    const js: any = await jsonAny(r);
    const syns = js?.InformationList?.Information?.[0]?.Synonym ?? [];
    return { cid: p.cid, synonyms: syns };
  }
});


/**
 * ChEMBL web services (no key required)
 * Docs: https://www.ebi.ac.uk/chembl/ws
 * JSON endpoints: https://www.ebi.ac.uk/chembl/api/data
 * We support:
 *  - chembl.molecule.search    (free-text search for molecules)
 *  - chembl.target.search      (free-text search for targets)
 *  - chembl.activities         (activities by target_chembl_id or molecule_chembl_id)
 */

const ChemblMolSearch = z.object({
  q: z.string(),                 // e.g. "ciprofloxacin"
  limit: z.number().int().min(1).max(200).default(25),
  offset: z.number().int().min(0).default(0),
});

const ChemblTargetSearch = z.object({
  q: z.string(),
  limit: z.number().int().min(1).max(200).default(25),
  offset: z.number().int().min(0).default(0),
  organism_contains: z.string().optional(),
  name_contains: z.string().optional()
});

const ChemblActivities = z.object({
  target_chembl_id: z.string().optional(),
  molecule_chembl_id: z.string().optional(),
  pchembl_only: z.boolean().default(false), // filter to activities with pChEMBL value
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

tools.push({
  name: 'chembl.molecule.search',
  description: 'ChEMBL molecule free-text search; returns basic molecule records.',
  inputSchema: ChemblMolSearch,
  handler: async (input: any) => {
    const p = ChemblMolSearch.parse(input);
    const url = new URL('https://www.ebi.ac.uk/chembl/api/data/molecule.json');
    url.searchParams.set('q', p.q);
    url.searchParams.set('limit', String(p.limit));
    url.searchParams.set('offset', String(p.offset));
    const r = await fetch(url.toString(), { headers: headers() });
    if (!r.ok) throw new Error(`ChEMBL molecule search error ${r.status}`);
    const js: any = await jsonAny(r);
    return js?.molecules ?? [];
  }
});

tools.push({
  name: 'chembl.target.search',
  description: 'ChEMBL target free-text search; find target_chembl_id for downstream activity queries.',
  inputSchema: ChemblTargetSearch,
  handler: async (input: any) => {
    const p = ChemblTargetSearch.parse(input);
    const url = new URL('https://www.ebi.ac.uk/chembl/api/data/target.json');
    url.searchParams.set('q', p.q);
    url.searchParams.set('limit', String(p.limit));
    url.searchParams.set('offset', String(p.offset));
    if (p.organism_contains) url.searchParams.set('organism__icontains', p.organism_contains);
    if (p.name_contains) url.searchParams.set('pref_name__icontains', p.name_contains);

    const r = await fetch(url.toString(), { headers: headers() });
    if (!r.ok) throw new Error(`ChEMBL target search error ${r.status}`);
    const js: any = await jsonAny(r);
    return js?.targets ?? [];
  }
});

tools.push({
  name: 'chembl.activities',
  description: 'ChEMBL bioactivities by target_chembl_id or molecule_chembl_id; supports pChEMBL filtering.',
  inputSchema: ChemblActivities,
  handler: async (input: any) => {
    const p = ChemblActivities.parse(input);
    const url = new URL('https://www.ebi.ac.uk/chembl/api/data/activity.json');
    if (p.target_chembl_id) url.searchParams.set('target_chembl_id', p.target_chembl_id);
    if (p.molecule_chembl_id) url.searchParams.set('molecule_chembl_id', p.molecule_chembl_id);
    if (p.pchembl_only) url.searchParams.set('pchembl_value__isnull', 'false');
    url.searchParams.set('limit', String(p.limit));
    url.searchParams.set('offset', String(p.offset));

    const r = await fetch(url.toString(), { headers: headers() });
    if (!r.ok) throw new Error(`ChEMBL activities error ${r.status}`);
    const js: any = await jsonAny(r);
    // Return just a tidy subset of fields commonly used
    const rows = (js?.activities ?? []).map((a: any) => ({
      activity_id: a.activity_id,
      molecule_chembl_id: a.molecule_chembl_id,
      target_chembl_id: a.target_chembl_id,
      assay_chembl_id: a.assay_chembl_id,
      standard_type: a.standard_type,
      standard_relation: a.standard_relation,
      standard_value: a.standard_value,
      standard_units: a.standard_units,
      pchembl_value: a.pchembl_value,
      confidence_score: a.confidence_score,
      doc_id: a.document_chembl_id,
    }));
    return rows;
  }
});

// --- ChEMBL: relaxed activity pulls ---
// Activities by assay keyword (broad search), optional standard_type
const ChemblActQuery = z.object({
  assay_query: z.string(),
  standard_type: z.string().optional(), // "IC50", "Ki", etc.
  limit: z.number().int().min(1).max(10000).default(1000),
});
tools.push({
  name: 'chembl.activities.by_assay_query',
  description: 'Return activities by free-text assay query (ChEMBL), optional standard_type (IC50, Ki...).',
  inputSchema: ChemblActQuery,
  handler: async (input: any) => {
    const p = ChemblActQuery.parse(input);
    const base = 'https://www.ebi.ac.uk/chembl/api/data/activity.json';
    const params = new URLSearchParams();
    params.set('q', p.assay_query);   // full text search over activity record
    params.set('limit', String(p.limit));
    if (p.standard_type) params.set('standard_type', p.standard_type);
    const url = `${base}?${params.toString()}`;
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) throw new Error(`ChEMBL by_assay_query error ${r.status}`);
    const js: any = await r.json().catch(() => ({}));
    return { activities: js?.activities ?? [] };
  }
});

// Activities by molecule_chembl_id (for named drugs), optional standard_type
const ChemblActByMol = z.object({
  molecule_chembl_id: z.string(),     // e.g., "CHEMBL521" (ciprofloxacin)
  standard_type: z.string().optional(),
  limit: z.number().int().min(1).max(10000).default(1000),
});
tools.push({
  name: 'chembl.activities.by_molecule',
  description: 'Return activities for a given molecule_chembl_id (e.g., CHEMBL521), optional standard_type.',
  inputSchema: ChemblActByMol,
  handler: async (input: any) => {
    const p = ChemblActByMol.parse(input);
    const base = 'https://www.ebi.ac.uk/chembl/api/data/activity.json';
    const params = new URLSearchParams();
    params.set('molecule_chembl_id', p.molecule_chembl_id);
    params.set('limit', String(p.limit));
    if (p.standard_type) params.set('standard_type', p.standard_type);
    const url = `${base}?${params.toString()}`;
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) throw new Error(`ChEMBL by_molecule error ${r.status}`);
    const js: any = await r.json().catch(() => ({}));
    return { activities: js?.activities ?? [] };
  }
});

// stats.describe — count, mean, sd, min, max
tools.push({
  name: 'stats.describe',
  description: 'Basic summary statistics for a numeric array.',
  inputSchema: StatsDescribe,
  handler: async (input: any) => {
    const p = StatsDescribe.parse(input);
    const x = p.x;
    if (x.length === 0) throw new Error('x is empty');
    const m = mean(x), sd = stddev(x), n = x.length;
    const mn = Math.min(...x), mx = Math.max(...x);
    return { n, mean: m, sd, min: mn, max: mx };
  }
});

// stats.pearson — r, p (approx), n
tools.push({
  name: 'stats.pearson',
  description: 'Pearson correlation r between two numeric arrays; also returns approx two-tailed p (Fisher z).',
  inputSchema: StatsArrayPair,
  handler: async (input: any) => {
    const p = StatsArrayPair.parse(input);
    const { r } = pearsonR(p.x, p.y);
    const n = p.x.length;
    const pTwo = pvalFromR(r, n);
    return { r, n, p_value_two_tailed: pTwo };
  }
});

// stats.spearman — rank correlation
tools.push({
  name: 'stats.spearman',
  description: 'Spearman rank correlation (rho) between two numeric arrays.',
  inputSchema: StatsArrayPair,
  handler: async (input: any) => {
    const p = StatsArrayPair.parse(input);
    const rho = spearmanRho(p.x, p.y);
    const n = p.x.length;
    return { rho, n };
  }
});

// stats.linear_regression — simple OLS y = a + b x
tools.push({
  name: 'stats.linear_regression',
  description: 'Simple linear regression (y = intercept + slope * x). Returns slope, intercept, r, r2.',
  inputSchema: StatsArrayPair,
  handler: async (input: any) => {
    const p = StatsArrayPair.parse(input);
    const fit = ols(p.x, p.y);
    return fit;
  }
});


// Stage 2: normalize.entities tool
tools.push({
  name: 'normalize.entities',
  description: 'Normalize & resolve entities across sources (compounds, targets, assays, literature)',
  inputSchema: NormalizeEntitiesInput,
  handler: async (input: any) => {
    const p = NormalizeEntitiesInput.parse(input);
    return await normalizeEntities(p);
  }
});

tools.push({
  name: 'research.run',
  description: 'Run a consolidated research task across sources (PubChem, ChEMBL, UniProt, PubMed, EuropePMC, OpenAlex) and return normalized tables + metrics.',
  inputSchema: ResearchRun,
  handler: async (input: any) => {
    const p = ResearchRun.parse(input);
    return await researchRun(p);
  }
});

tools.push({
  name: 'research.hypothesis.run',
  description: 'Pose a hypothesis, gather data across sources, run lightweight analysis, and return narrative + HTML for PDF.',
  inputSchema: HypothesisRun,
  handler: async (input: any) => {
    const p = HypothesisRun.parse(input);
    // Generic organism cue injection (server-side safety net)
    try {
      const h = (p.hypothesis || '').toLowerCase();
      const opts = (p.research as any).options = (p.research as any).options || {};
      if (!opts.organism_contains) {
        if (/(^|\b)(human|homo sapiens)(\b|$)/i.test(p.hypothesis)) opts.organism_contains = 'Homo sapiens';
        else if (/(mus musculus|mouse)/i.test(p.hypothesis)) opts.organism_contains = 'Mus musculus';
        else if (/(rattus norvegicus|rat)/i.test(p.hypothesis)) opts.organism_contains = 'Rattus norvegicus';
        else {
          // crude binomial detector: Genus species
          const m = p.hypothesis.match(/([A-Z][a-z]+\s+[a-z]{3,})/);
          if (m) opts.organism_contains = m[1];
        }
      }
    } catch {}
    return await hypothesisRun(p);
  }
});

tools.push({
  server: "ctgov",
  name: "search_trials",
  description: "Search ClinicalTrials.gov Study Fields API for trials",
  inputSchema: {
    type: "object",
    properties: {
      expr: { type: "string" },
      status: { type: "array", items: { type: "string" } },
      minRank: { type: "number" },
      maxRank: { type: "number" },
      fields: { type: "array", items: { type: "string" } }
    },
    required: ["expr"]
  },
  handler: async (args: any) => {
    const rows = await searchTrialsCtgov(args as any);
    // Return raw rows; your normalizer will convert to canonical records
    return { rows };
  }
});

// -------- JSON-RPC server --------
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));

app.post('/mcp', async (req, res) => {
  try {
    const { id, method, params } = req.body || {};
    if (!id || !method) return res.status(400).json(err(null, -32600, 'Invalid Request'));

    if (method === 'tools/list') {
      return res.json(ok(id, { tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: JSON.parse(JSON.stringify(t.inputSchema?.shape ? zodToJsonSchema(t.inputSchema) : t.inputSchema || {})),
      })) }));
    }

    if (method === 'tools/call') {
      const name = params?.name; const args = params?.arguments ?? params?.params ?? {};
      const tool = tools.find(t => t.name === name);
      if (!tool) return res.json(err(id, -32601, `Unknown tool: ${name}`));
      try { const result = await tool.handler(args); return res.json(ok(id, { content: result })); }
      catch (e: any) { return res.json(err(id, -32000, e?.message || 'Tool error')); }
    }

    return res.json(err(id, -32601, `Method not found: ${method}`));
  } catch (e: any) {
    return res.status(500).json(err(null, -32603, 'Internal error', { message: e?.message }));
  }
});
registerGetWrapper(app, tools);
// helper to convert Zod -> JSON Schema (simple inline)
function zodToJsonSchema(schema: any) {
  // minimal: rely on Zod's introspection
  // For richer schemas, use `zod-to-json-schema` package.
  return schema._def ? { type: 'object' } : schema; // fallback
}

// ---- HTTP GET wrapper for tools ----
// In addition to the JSON-RPC POST interface above, expose a REST-like GET API.
// Example usage:
//   /mcp/pubchem.compound.search?namespace=name&identifier=caffeine&max=10
// All query parameters are passed to the tool's input schema. Numeric strings are
// automatically converted to numbers; "true"/"false" to booleans; repeated parameters
// become arrays. Any schema validation errors are returned as 400.
app.get('/mcp/:toolName', async (req, res) => {
  const { toolName } = req.params;
  const tool = tools.find(t => t.name === toolName);
  if (!tool) {
    return res.status(404).json({ error: `Unknown tool: ${toolName}` });
  }
  // Build a raw argument object from the query string
  const rawArgs: any = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      // If multiple values for the same key, keep array of strings
      rawArgs[key] = value.map(v => {
        // Convert numeric-like strings in arrays
        if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) return Number(v);
        if (v === 'true') return true;
        if (v === 'false') return false;
        return v;
      });
    } else if (typeof value === 'string') {
      // Single value: attempt to coerce to number or boolean
      if (value !== '' && !isNaN(Number(value))) {
        rawArgs[key] = Number(value);
      } else if (value === 'true') {
        rawArgs[key] = true;
      } else if (value === 'false') {
        rawArgs[key] = false;
      } else {
        rawArgs[key] = value;
      }
    }
  }
  try {
    const args = tool.inputSchema ? tool.inputSchema.parse(rawArgs) : rawArgs;
    const result = await tool.handler(args);
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'Invalid input' });
  }
});

app.listen(PORT, () => console.log(`Bio MCP listening on http://localhost:${PORT}/mcp`));