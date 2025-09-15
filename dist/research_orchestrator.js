// research_orchestrator.ts — clean rebuild (generic, organism-scoped)
import { z } from 'zod';
import { normalizeEntities } from './stage2_normalization.js';
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok)
        throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.json();
}
// ---------- Schemas ----------
export const ResearchRun = z.object({
    compounds: z.array(z.object({
        name: z.string().optional(),
        inchikey: z.string().optional(),
        smiles: z.string().optional(),
    })).default([]),
    targets: z.array(z.object({
        query: z.string().optional(),
        symbol: z.string().optional(),
    })).default([]),
    organisms: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([]),
    sources: z.array(z.enum(['pubchem', 'chembl', 'uniprot', 'entrez', 'europepmc', 'openalex'])).default(['pubchem', 'chembl', 'uniprot', 'entrez', 'europepmc', 'openalex']),
    options: z.object({
        pchemblOnly: z.boolean().default(true),
        maxPerSource: z.number().int().positive().max(100).default(50),
        organism_contains: z.string().optional(),
        name_contains: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
    }).default({ pchemblOnly: true, maxPerSource: 50 })
});
// ---------- Helpers for sources ----------
// PubChem: very small helper to fetch props by compound name (best-effort)
async function pubchemPropsByName(name) {
    const base = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
    try {
        const j = await fetchJson(`${base}/compound/name/${encodeURIComponent(name)}/property/MolecularFormula,MolecularWeight,XLogP,TPSA,HBondDonorCount,HBondAcceptorCount,RotatableBondCount,InChIKey,CanonicalSMILES/JSON`);
        const props = j?.PropertyTable?.Properties ?? [];
        return props;
    }
    catch {
        return [];
    }
}
// ChEMBL target search
const CHEMBL_BASE = 'https://www.ebi.ac.uk/chembl/api/data';
async function chemblTargetSearch(q, limit = 25, organism, nameContains) {
    const params = new URLSearchParams({ format: 'json', limit: String(limit) });
    if (organism)
        params.set('organism__icontains', organism);
    // Prefer explicit query; otherwise fall back to name_contains if given
    if (q)
        params.set('target_synonym__icontains', q);
    if (nameContains)
        params.set('pref_name__icontains', nameContains);
    try {
        const j = await fetchJson(`${CHEMBL_BASE}/target.json?${params.toString()}`);
        return j?.targets ?? [];
    }
    catch {
        return [];
    }
}
async function chemblActivitiesByTarget(targetChemblId, limit = 50, pchemblOnly = true) {
    const params = new URLSearchParams({ format: 'json', limit: String(limit), target_chembl_id: targetChemblId });
    if (pchemblOnly)
        params.set('pchembl_value__isnull', 'false');
    try {
        const j = await fetchJson(`${CHEMBL_BASE}/activity.json?${params.toString()}`);
        return j?.activities ?? [];
    }
    catch {
        return [];
    }
}
// UniProt search (compact/Boolean + organism-aware)
const UNIPROT = 'https://rest.uniprot.org/uniprotkb/search';
function buildUniProtQuery(input, opts) {
    const toTok = (t) => (/\s/.test(t) ? `"${t}"` : t);
    const base = Array.isArray(input) ? `(${input.filter(Boolean).map(toTok).join(' OR ')})` : String(input || '').trim();
    const clauses = [];
    if (base)
        clauses.push(base);
    if (opts?.reviewed !== false)
        clauses.push('reviewed:true');
    if (opts?.organism)
        clauses.push(`organism_name:"${opts.organism}"`);
    return clauses.length ? clauses.join(' AND ') : 'reviewed:true';
}
async function uniprotSearch(query, limit = 25, opts) {
    const qStr = buildUniProtQuery(query, opts);
    const qs = new URLSearchParams({ query: qStr, size: String(limit), format: 'json' });
    return await fetchJson(`${UNIPROT}?${qs.toString()}`);
}
// Literature (best-effort compact queries)
function booleanFromKeywords(keywords, organisms) {
    const kw = keywords.length ? `(${keywords.map(k => `"${k}"`).join(' OR ')})` : '';
    const org = organisms.length ? `(${organisms.map(o => `"${o}"`).join(' OR ')})` : '';
    return [kw, org].filter(Boolean).join(' AND ') || keywords.slice(0, 6).join(' ');
}
async function entrezEsearch(q, retmax = 50) {
    try {
        const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
        const params = new URLSearchParams({ db: 'pubmed', term: q, retmode: 'json', retmax: String(retmax) });
        const j = await fetchJson(`${base}?${params.toString()}`);
        const ids = j?.esearchresult?.idlist ?? [];
        const count = Number(j?.esearchresult?.count ?? ids.length);
        return { count, ids };
    }
    catch {
        return { count: 0, ids: [] };
    }
}
async function europepmcSearch(q, pageSize = 50) {
    try {
        const j = await fetchJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&pageSize=${pageSize}&format=json`);
        return j?.resultList?.result ?? [];
    }
    catch {
        return [];
    }
}
async function openalexWorks(q, perPage = 50) {
    try {
        const j = await fetchJson(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${perPage}`);
        return j?.results ?? [];
    }
    catch {
        return [];
    }
}
// ---------- Metrics summarizer (local) ----------
function summarizeNormalization(normalized) {
    const C = normalized.compounds || [];
    const T = normalized.targets || [];
    const A = normalized.assays || [];
    const L = normalized.literature || [];
    const pct = (num, den) => den ? (100 * num / den) : 0;
    // Compounds
    const c_inchikey = C.filter((c) => c.InChIKey || c.inchikey).length;
    const c_props = C.filter((c) => c.MolecularWeight != null || c.MolecularFormula || c.CanonicalSMILES || c.canonicalSmiles).length;
    const inchikeys = C.map((c) => (c.InChIKey || c.inchikey || '').toString()).filter(Boolean);
    const dup_inchikeys = inchikeys.length - new Set(inchikeys).size;
    // Targets
    const t_uniprot = T.filter((t) => t.uniprot || t.uniprot_id || t.primaryAccession).length;
    const t_chembl = T.filter((t) => t.target_chembl_id || t.chembl_target_id).length;
    // Assays
    const a_pchembl = A.filter((a) => a.pchembl_value != null && a.pchembl_value !== '').length;
    const a_std_num = A.filter((a) => {
        const v = Number(a.standard_value);
        return Number.isFinite(v);
    }).length;
    const targetIds = new Set(T.map((t) => String(t.target_chembl_id || t.chembl_target_id || t.uniprot || t.uniprot_id || '')).filter(Boolean));
    const a_linked = A.filter((a) => {
        const id = String(a.target_chembl_id || a.target_id || a.uniprot || '');
        return id && targetIds.has(id);
    }).length;
    // Literature
    const Lkey = (l) => (l.doi ? `doi:${l.doi}` : '') + '|' + (l.pmid ? `pmid:${l.pmid}` : '') + '|' + (l.title || '');
    const uniqLit = new Set(L.map(Lkey));
    const l_pmid = L.filter((l) => !!l.pmid).length;
    const l_doi = L.filter((l) => !!l.doi).length;
    return {
        counts: {
            compounds: C.length,
            targets: T.length,
            assays: A.length,
            literature: L.length
        },
        metrics: {
            compounds_inchikey_cov: pct(c_inchikey, C.length),
            compounds_props_cov: pct(c_props, C.length),
            compounds_duplicates: dup_inchikeys,
            targets_uniprot_cov: pct(t_uniprot, T.length),
            targets_chembl_cov: pct(t_chembl, T.length),
            assays_pchembl_cov: pct(a_pchembl, A.length),
            assays_standard_numeric: pct(a_std_num, A.length),
            assays_target_linked: pct(a_linked, A.length),
            literature_unique_ratio: (L.length ? (uniqLit.size / L.length) : 1),
            literature_pmid_cov: pct(l_pmid, L.length),
            literature_doi_cov: pct(l_doi, L.length)
        },
        notes: []
    };
}
// ---------- Orchestration ----------
export async function researchRun(p_in) {
    // Parse & clone to ensure defaults
    const p = ResearchRun.parse(p_in);
    const prov = [];
    // Default organism to human unless explicitly given
    p.options.organism_contains = p.options.organism_contains || 'Homo sapiens';
    // Neutral term for provenance/debug
    const term = (p.keywords && p.keywords.length ? p.keywords.join(' ') : '') ||
        (p.targets.find(t => t.query)?.query) ||
        (p.targets.find(t => t.symbol)?.symbol) ||
        (p.compounds.find(c => c.name)?.name) ||
        '';
    // -------- PubChem props --------
    let pubchem_props = [];
    if (p.sources.includes('pubchem')) {
        const names = Array.from(new Set(p.compounds.map(c => c.name).filter(Boolean))).slice(0, p.options.maxPerSource);
        for (const n of names) {
            const props = await pubchemPropsByName(n);
            pubchem_props.push(...props);
            await sleep(40);
        }
        prov.push({ source: 'pubchem.compound.props', params: { n: pubchem_props.length }, n: pubchem_props.length });
    }
    // -------- ChEMBL targets & activities (scoped to organism) --------
    let chembl_targets = [];
    let chembl_activities = [];
    if (p.sources.includes('chembl')) {
        const queries = new Set();
        for (const t of p.targets) {
            if (t.query)
                queries.add(t.query);
            if (t.symbol)
                queries.add(t.symbol);
        }
        if (!queries.size && term)
            queries.add(term);
        for (const q of Array.from(queries)) {
            const ts = await chemblTargetSearch(q, Math.min(25, p.options.maxPerSource), p.options.organism_contains, p.options.name_contains);
            chembl_targets.push(...ts);
            prov.push({ source: 'chembl.target.search', params: { q, organism__icontains: p.options.organism_contains, pref_name__icontains: p.options.name_contains }, n: ts.length });
            await sleep(50);
        }
        const ids = Array.from(new Set(chembl_targets.map(t => t.target_chembl_id).filter(Boolean)));
        for (const id of ids.slice(0, Math.min(10, p.options.maxPerSource))) {
            const acts = await chemblActivitiesByTarget(String(id), Math.min(50, p.options.maxPerSource), p.options.pchemblOnly);
            chembl_activities.push(...acts);
            await sleep(50);
        }
        prov.push({ source: 'chembl.activities', params: { targets: ids.length }, n: chembl_activities.length });
    }
    // -------- UniProt (reviewed + organism-aware) --------
    let uniprot_results = { results: [] };
    if (p.sources.includes('uniprot')) {
        const tokens = Array.from(new Set([
            ...p.keywords,
            ...p.targets.map(t => (t.query || t.symbol)).filter(Boolean),
        ])).slice(0, 12);
        const uni = await uniprotSearch(tokens.length ? tokens : 'protein', Math.min(25, p.options.maxPerSource), { organism: p.options.organism_contains, reviewed: true });
        uniprot_results = uni || { results: [] };
        prov.push({ source: 'uniprot.search', params: { tokens, organism: p.options.organism_contains }, n: uniprot_results?.results?.length || 0 });
    }
    // -------- Literature (compact boolean) --------
    let pubmed_esearch = { count: 0, ids: [] };
    let europepmc_search = [];
    let openalex_works = [];
    const litQ = booleanFromKeywords(p.keywords, p.organisms.length ? p.organisms : [p.options.organism_contains || '']);
    if (p.sources.includes('entrez')) {
        pubmed_esearch = await entrezEsearch(litQ, Math.min(50, p.options.maxPerSource));
        prov.push({ source: 'entrez.esearch', params: { q: litQ }, n: pubmed_esearch.ids.length, total: pubmed_esearch.count });
    }
    if (p.sources.includes('europepmc')) {
        europepmc_search = await europepmcSearch(litQ, Math.min(50, p.options.maxPerSource));
        prov.push({ source: 'europepmc.search', params: { q: litQ }, n: europepmc_search.length });
    }
    if (p.sources.includes('openalex')) {
        openalex_works = await openalexWorks(litQ, Math.min(50, p.options.maxPerSource));
        prov.push({ source: 'openalex.works', params: { q: litQ }, n: openalex_works.length });
    }
    // ----- Final organism gating before normalization -----
    {
        const _org = (p.options?.organism_contains || '').toLowerCase();
        const _incl = (s) => !_org || (s || '').toLowerCase().includes(_org);
        chembl_targets = (chembl_targets || []).filter((t) => _incl(String(t.organism || '')));
        if (uniprot_results && Array.isArray(uniprot_results.results)) {
            uniprot_results.results = uniprot_results.results.filter((r) => {
                const sci = r?.organism?.scientificName || r?.organism?.commonName || '';
                return _incl(String(sci));
            });
        }
    }
    // -------- Normalize & summarize --------
    const normInput = {
        pubchem_props,
        chembl_targets,
        chembl_activities,
        uniprot_results,
        pubmed_esearch,
        europepmc_search,
        openalex_works
    };
    const normalized = await normalizeEntities(normInput);
    const metrics = summarizeNormalization(normalized);
    // -------- Return with stamp --------
    const run_id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
    const spec_echo = JSON.parse(JSON.stringify(p));
    return {
        ok: true,
        run_id,
        term,
        normalized,
        metrics,
        provenance: prov,
        spec_echo
    };
}
