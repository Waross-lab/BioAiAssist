// stage2_normalization.ts
// Drop-in scaffolding for Stage 2: normalization & entity resolution.
// You can import the functions below into bio-mcp.ts, or paste the tool blocks directly.
// Assumes Node 18+ (global fetch).

import { z } from 'zod';

/* =========================
 * Zod Schemas (Normalized)
 * ========================= */

export const NormCompound = z.object({
  compound_id: z.string(),          // stable key: stdInChIKey (full)
  inchikey: z.string(),
  inchikey14: z.string(),           // connectivity layer for grouping
  cid: z.string().optional(),
  chembl_molecule_id: z.string().optional(),
  name: z.string().optional(),
  smiles: z.string().optional(),
  formula: z.string().optional(),
  mw: z.number().optional(),
  xlogp: z.number().optional(),
  tpsa: z.number().optional()
});

export type NormCompoundT = z.infer<typeof NormCompound>;

export const NormTarget = z.object({
  target_id: z.string(),            // UniProt accession preferred
  uniprot: z.string().optional(),
  chembl_target_id: z.string().optional(),
  symbol: z.string().optional(),
  pref_name: z.string().optional(),
  organism_taxid: z.number().optional(),
  organism_name: z.string().optional()
});

export type NormTargetT = z.infer<typeof NormTarget>;

export const NormOrganism = z.object({
  taxid: z.number(),
  scientific_name: z.string().optional(),
  common_name: z.string().optional()
});

export type NormOrganismT = z.infer<typeof NormOrganism>;

export const NormAssay = z.object({
  assay_id: z.string(),                 // e.g., CHEMBL assay id
  source: z.string(),
  target_id: z.string().optional(),     // normalized target (UniProt) if resolvable
  chembl_target_id: z.string().optional(),
  organism_taxid: z.number().optional(),
  standard_type: z.string().optional(),
  standard_value: z.union([z.string(), z.number()]).optional(),
  standard_units: z.string().optional(),
  pchembl_value: z.union([z.string(), z.number()]).optional(),
  molecule_chembl_id: z.string().optional(),
  compound_inchikey: z.string().optional()
});

export type NormAssayT = z.infer<typeof NormAssay>;

export const NormLit = z.object({
  key: z.string(),                   // PMID or DOI
  pmid: z.string().optional(),
  doi: z.string().optional(),
  title: z.string().optional(),
  year: z.number().optional(),
  source: z.string()                 // 'pubmed' | 'europepmc' | 'openalex' | 'crossref'
});

export type NormLitT = z.infer<typeof NormLit>;

/* =========================
 * Utilities
 * ========================= */

function safeNum(x: any): number | undefined {
  if (x === null || x === undefined) return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function first<T>(a: T[] | undefined): T | undefined {
  return Array.isArray(a) && a.length ? a[0] : undefined;
}

export function inchikey14(ik: string | undefined): string {
  if (!ik) return '';
  // std InChIKey looks like: XXXXXXXXXXXXXX-YYYYYYYYSA-N
  const m = ik.match(/^([A-Z]{14})/);
  return m ? m[1] : '';
}

/* =========================
 * PubChem identity helpers
 * ========================= */

// Resolve name/SMILES/CID/InChIKey to standard InChIKey and CID using PubChem PUG REST
export async function resolveCompoundIdentity(q: { name?: string, smiles?: string, cid?: string, inchikey?: string }): Promise<{ inchikey?: string, cid?: string, canonicalSmiles?: string } | null> {
  const base = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
  let path = '';
  if (q.inchikey) path = `/compound/inchikey/${encodeURIComponent(q.inchikey)}/property/InChIKey,CanonicalSMILES/JSON`;
  else if (q.cid) path = `/compound/cid/${encodeURIComponent(q.cid)}/property/InChIKey,CanonicalSMILES/JSON`;
  else if (q.smiles) path = `/compound/smiles/${encodeURIComponent(q.smiles)}/property/InChIKey,CanonicalSMILES/JSON`;
  else if (q.name) path = `/compound/name/${encodeURIComponent(q.name)}/property/InChIKey,CanonicalSMILES/JSON`;
  else return null;

  const r = await fetch(`${base}${path}`);
  if (!r.ok) return null;
  const j: any = await r.json();
  const prop: any = first(j?.PropertyTable?.Properties);
  if (!prop) return null;

  // Also fetch CID from name/smiles if needed
  let cid = q.cid;
  if (!cid) {
    try {
      const rr = await fetch(`${base}/compound/inchikey/${encodeURIComponent(prop.InChIKey)}/cids/JSON`);
      if (rr.ok) {
        const jj: any = await rr.json();
        const cid0 = first(jj?.IdentifierList?.CID);
        cid = cid0 ? String(cid0) : undefined;
      }
    } catch {}
  }

  return { inchikey: prop.InChIKey, cid, canonicalSmiles: prop.CanonicalSMILES };
}

/* =========================
 * ChEMBL mapping helpers
 * ========================= */

// Map ChEMBL target entry to UniProt accession if present via target components
export function chemblTargetToUniProt(target: any): { uniprot?: string, organism_name?: string } {
  // Expecting shape similar to ChEMBL API: target_components: [{ target_component: ..., target_component_synonyms: ..., accession }]
  const comp: any = first(target?.target_components) || first(target?.components);
  const acc = comp?.accession || comp?.uniprot_accession || comp?.component_accession;
  const organism = target?.organism || comp?.organism;
  return { uniprot: acc, organism_name: organism };
}

/* =========================
 * Normalizers
 * ========================= */

export function normalizePubChemProps(input: any[], nameHint?: string): NormCompoundT[] {
  const out: NormCompoundT[] = [];
  for (const r of (input || [])) {
    const inchikey = (r.InChIKey || r.inchikey || undefined) as string | undefined;
    const ik14 = inchikey14(inchikey);
    out.push({
      compound_id: inchikey || (r.CID ? String(r.CID) : (nameHint || 'compound')),
      inchikey: inchikey || '',
      inchikey14: ik14,
      cid: r.CID ? String(r.CID) : undefined,
      name: nameHint,
      smiles: (r.CanonicalSMILES || r.SMILES) as string | undefined,
      formula: (r.MolecularFormula || r.Formula) as string | undefined,
      mw: safeNum(r.MolecularWeight),
      xlogp: safeNum(r.XLogP),
      tpsa: safeNum(r.TPSA)
    });
  }
  return out;
}

export function normalizeChemblTargets(rows: any[]): NormTargetT[] {
  const out: NormTargetT[] = [];
  for (const t of (rows || [])) {
    const map = chemblTargetToUniProt(t);
    out.push({
      target_id: map.uniprot || (t.target_chembl_id ? String(t.target_chembl_id) : 'target'),
      uniprot: map.uniprot,
      chembl_target_id: t.target_chembl_id ? String(t.target_chembl_id) : undefined,
      pref_name: t.pref_name,
      organism_name: t.organism
    });
  }
  return out;
}

export function normalizeChemblActivities(rows: any[], targetLookup?: Record<string, string>): NormAssayT[] {
  const out: NormAssayT[] = [];
  for (const a of (rows || [])) {
    const tchembl = a.target_chembl_id ? String(a.target_chembl_id) : undefined;
    const uni = tchembl && targetLookup ? targetLookup[tchembl] : undefined;
    out.push({
      assay_id: String(a.assay_chembl_id || a.activity_id || ''),
      source: 'chembl',
      target_id: uni,
      chembl_target_id: tchembl,
      standard_type: a.standard_type,
      standard_value: a.standard_value,
      standard_units: a.standard_units,
      pchembl_value: a.pchembl_value,
      molecule_chembl_id: a.molecule_chembl_id
    });
  }
  return out;
}

export function normalizeUniProtSearch(rows: any[]): NormTargetT[] {
  const out: NormTargetT[] = [];
  for (const r of (rows || [])) {
    out.push({
      target_id: r.primaryAccession,
      uniprot: r.primaryAccession,
      pref_name: r?.proteinDescription?.recommendedName?.fullName?.value,
      organism_name: r?.organism?.scientificName
    });
  }
  return out;
}

export function normalizeLiteratureEntries(pubmedEsearch: any, europepmc?: any, openalex?: any): NormLitT[] {
  const out: NormLitT[] = [];
  // PubMed
  const es = pubmedEsearch?.esearchresult || pubmedEsearch;
  const pmids: string[] = (es?.idlist || es?.idList || []).map((x: any) => String(x));
  for (const pmid of pmids) out.push({ key: `PMID:${pmid}`, pmid, source: 'pubmed' });
  // EuropePMC
  const ep = europepmc?.resultList?.result || [];
  for (const r of ep) {
    const pmid = r?.pmid ? String(r.pmid) : undefined;
    const doi = r?.doi ? String(r.doi) : undefined;
    const key = pmid ? `PMID:${pmid}` : (doi ? `DOI:${doi}` : r?.id || 'epmc');
    out.push({ key, pmid, doi, title: r?.title, year: safeNum(r?.pubYear), source: 'europepmc' });
  }
  // OpenAlex
  const oa = openalex?.results || openalex?.data || [];
  for (const w of oa) {
    const doi = (w?.doi || '').replace(/^https?:\/\/doi.org\//, '') || undefined;
    const year = safeNum(w?.publication_year);
    const title = w?.title;
    const key = doi ? `DOI:${doi}` : (w?.id || 'openalex');
    out.push({ key, doi, title, year, source: 'openalex' });
  }
  // Dedup by key (prefer entries that have more fields)
  const dedup: Record<string, NormLitT> = {};
  for (const r of out) {
    const prev = dedup[r.key];
    if (!prev) dedup[r.key] = r;
    else {
      // merge fields
      dedup[r.key] = { ...prev, ...r };
    }
  }
  return Object.values(dedup);
}


async function fetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Fetch ChEMBL target detail to extract UniProt accessions
async function augmentChemblTargetsWithUniProt(targets: NormTargetT[]): Promise<NormTargetT[]> {
  const out: NormTargetT[] = [...targets];
  const missing = out.filter(t => !t.uniprot && t.chembl_target_id).map(t => String(t.chembl_target_id));
  const uniqueMissing = Array.from(new Set(missing)).slice(0, 25); // safety cap
  for (const id of uniqueMissing) {
    const url = `https://www.ebi.ac.uk/chembl/api/data/target/${encodeURIComponent(id)}.json`;
    const j: any = await fetchJson(url);
    const comp: any = first<any>(j?.target_components) || first<any>(j?.components);
    const acc: string | undefined = comp?.accession || comp?.uniprot_accession || comp?.component_accession;
    if (acc) {
      for (const t of out) {
        if (String(t.chembl_target_id) === id) {
          t.uniprot = t.uniprot || acc;
          t.target_id = t.target_id || acc;
        }
      }
    }
  }
  return out;
}

async function enrichCompoundsIdentity(compounds: NormCompoundT[]): Promise<NormCompoundT[]> {
  const out: NormCompoundT[] = [...compounds];
  for (const c of out) {
    if (!c.inchikey && c.cid) {
      const ident = await resolveCompoundIdentity({ cid: c.cid });
      if (ident?.inchikey) {
        c.inchikey = ident.inchikey;
        c.inchikey14 = inchikey14(ident.inchikey);
      }
      if (ident?.canonicalSmiles && !c.smiles) {
        c.smiles = ident.canonicalSmiles;
      }
    }
  }
  return out;
}

/* =========================
 * Tool: normalize.entities
 * ========================= */

export const NormalizeEntitiesInput = z.object({
  // Raw payloads from your existing tools (as returned by tools/call content)
  pubchem_props: z.array(z.any()).optional(),
  chembl_targets: z.array(z.any()).optional(),
  chembl_activities: z.array(z.any()).optional(),
  uniprot_results: z.object({ results: z.array(z.any()) }).optional(),
  pubmed_esearch: z.any().optional(),
  europepmc_search: z.any().optional(),
  openalex_works: z.any().optional()
});

export type NormalizeEntitiesInputT = z.infer<typeof NormalizeEntitiesInput>;

export async function normalizeEntities(input: NormalizeEntitiesInputT) {
  let compounds = normalizePubChemProps(input.pubchem_props || []);
  let targetsFromChembl = normalizeChemblTargets(input.chembl_targets || []);
  const targetsFromUniProt = normalizeUniProtSearch(input.uniprot_results?.results || []);
  let targets = [...targetsFromChembl, ...targetsFromUniProt];

  // Enrich compounds identity if missing InChIKey
  compounds = await enrichCompoundsIdentity(compounds);

  // Attempt to augment ChEMBL targets with UniProt accessions via target/{id}.json
  targets = await augmentChemblTargetsWithUniProt(targets);

  // Build lookup: ChEMBL target id -> UniProt (after augmentation)
  const tLookup: Record<string, string> = {};
  for (const t of targets) {
    if (t.chembl_target_id && t.uniprot) tLookup[t.chembl_target_id] = t.uniprot;
  }

  const assays = normalizeChemblActivities(input.chembl_activities || [], tLookup);
  const literature = normalizeLiteratureEntries(input.pubmed_esearch, input.europepmc_search, input.openalex_works);

  return { compounds, targets, assays, literature };
}
