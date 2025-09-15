// hypothesis_orchestrator.ts — domain-agnostic hypothesis runner
import { z } from 'zod';
import { ResearchRun, researchRun } from './research_orchestrator.js';
const s = (x) => (x == null ? '' : String(x));
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : undefined; };
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
const median = (xs) => {
    if (!xs.length)
        return undefined;
    const a = [...xs].sort((x, y) => x - y);
    return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const qtile = (xs, q) => {
    if (!xs.length)
        return undefined;
    const a = [...xs].sort((x, y) => x - y);
    const i = Math.max(0, Math.min(a.length - 1, Math.floor(q * (a.length - 1))));
    return a[i];
};
export const HypothesisRun = z.object({
    hypothesis: z.string().min(5, 'Please provide a descriptive hypothesis/question.'),
    research: ResearchRun.default({
        compounds: [], targets: [], organisms: [], keywords: [],
        sources: ['pubchem', 'chembl', 'uniprot', 'entrez', 'europepmc', 'openalex'],
        options: { pchemblOnly: true, maxPerSource: 50 }
    })
});
/* ----------------------------
 * 1) Hypothesis → auto scope
 *    (generic, data-driven)
 * ---------------------------- */
const STOP = new Set(['the', 'and', 'for', 'with', 'without', 'across', 'into', 'from', 'that', 'this', 'to', 'of', 'in', 'on', 'by', 'vs', 'than', 'are', 'is', 'be', 'as', 'an', 'or', 'do', 'does', 'show', 'shows', 'more', 'less']);
function tokenize(h) {
    return h
        .replace(/[“”"(),;:/\\]+/g, ' ')
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length >= 3 && !STOP.has(t.toLowerCase()));
}
// tiny helper to fetch json safely
async function jget(url) {
    try {
        const r = await fetch(url);
        if (!r.ok)
            return null;
        return await r.json();
    }
    catch {
        return null;
    }
}
// Discovery: try UniProt for targets based on tokens (kept small & cheap)
async function discoverTargets(tokens, limit = 8) {
    const q = tokens.slice(0, 6).join(' ');
    if (!q)
        return [];
    const url = `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(q)}&size=${Math.min(limit, 25)}&format=json`;
    const j = await jget(url);
    const arr = (j?.results ?? []).map((r) => ({
        query: r?.primaryAccession || r?.uniProtkbId || r?.proteinDescription?.recommendedName?.fullName?.value || '',
        label: r?.proteinDescription?.recommendedName?.fullName?.value || r?.uniProtkbId || r?.primaryAccession || ''
    })).filter((x) => x.query).slice(0, limit);
    return arr;
}
// Discovery: try PubChem for compounds from tokens (best-effort)
async function discoverCompounds(tokens, limit = 6) {
    const base = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
    const out = [];
    for (const t of tokens.slice(0, 12)) {
        // name→CID (fast head check)
        const j = await jget(`${base}/compound/name/${encodeURIComponent(t)}/cids/JSON`);
        if (j?.IdentifierList?.CID?.length)
            out.push({ name: t });
        if (out.length >= limit)
            break;
        await new Promise(r => setTimeout(r, 40));
    }
    return out;
}
// Discovery: organisms & techniques from text (generic cues)
function detectContextCues(h) {
    const H = h.toLowerCase();
    const organisms = [];
    if (/\bhuman\b|homo sapiens/i.test(H))
        organisms.push('Homo sapiens');
    if (/\bmouse\b|mus musculus/i.test(H))
        organisms.push('Mus musculus');
    if (/\brate\b|rattus norvegicus/i.test(H))
        organisms.push('Rattus norvegicus');
    const binomial = /([A-Z][a-z]+)\s([a-z]{3,})/g; // crude binomial detector
    let m;
    while ((m = binomial.exec(h)) !== null) {
        organisms.push(`${m[1]} ${m[2]}`);
    }
    const techniques = [];
    if (/TRAP assay|telomerase repeat amplification/i.test(h))
        techniques.push('TRAP');
    if (/\bMIC\b/i.test(h))
        techniques.push('MIC');
    if (/\bqPCR\b/i.test(h))
        techniques.push('qPCR');
    if (/western blot/i.test(h))
        techniques.push('Western blot');
    if (/ELISA/i.test(h))
        techniques.push('ELISA');
    if (/CRISPR/i.test(h))
        techniques.push('CRISPR');
    const intents = {
        activation: /\bactivate|agonis|upregulat/i.test(h),
        inhibition: /\binhibit|antagonis|downregulat/i.test(h)
    };
    return { organisms: Array.from(new Set(organisms)).slice(0, 3), techniques, intents };
}
// Build boolean literature query from compact keywords
function booleanQuery(compoundNames, keywords, organisms) {
    const comp = compoundNames.length ? `(${compoundNames.map(k => `"${k}"`).join(' OR ')})` : '';
    const org = organisms.length ? `(${organisms.map(k => `"${k}"`).join(' OR ')})` : '';
    const kw = keywords.length ? `(${keywords.map(k => `"${k}"`).join(' OR ')})` : '';
    return [comp, kw, org].filter(Boolean).join(' AND ') || keywords.slice(0, 5).join(' ');
}
async function autoscope(hypothesis, spec) {
    // 1) Tokenize & seed keywords
    const tokens = tokenize(hypothesis);
    const kws = new Set(tokens.slice(0, 12));
    // 2) Context cues → adjust options generically
    const cues = detectContextCues(hypothesis);
    const options = { ...(spec.options || {}) };
    if (!options.organism_contains && cues.organisms[0])
        options.organism_contains = cues.organisms[0];
    // Activation/agonism → allow non-pChEMBL; inhibition often has pChEMBL
    if (cues.intents.activation && options.pchemblOnly !== false)
        options.pchemblOnly = false;
    // 3) Discover likely targets/compounds (best-effort, small)
    const [tHits, cHits] = await Promise.all([
        discoverTargets(tokens, 6),
        discoverCompounds(tokens, 4)
    ]);
    // 4) Build compact keyword set with labels from discovery (no long sentences)
    for (const t of tHits)
        if (t.label)
            kws.add(t.label);
    for (const c of cHits)
        if (c.name)
            kws.add(c.name);
    cues.techniques.forEach(t => kws.add(t));
    if (cues.intents.activation)
        kws.add('activation');
    if (cues.intents.inhibition)
        kws.add('inhibition');
    const compactKeywords = Array.from(kws).slice(0, 12);
    // 5) Build targets list & compounds list (only if empty or underspecified)
    const targets = (spec.targets && spec.targets.length) ? spec.targets
        : tHits.map(t => ({ query: t.query })).slice(0, 6);
    const compounds = (spec.compounds && spec.compounds.length) ? spec.compounds
        : cHits.map(c => ({ name: c.name }));
    // 6) Build a boolean query string for literature
    const litQ = booleanQuery(compounds.map(c => c.name || '').filter(Boolean), compactKeywords, cues.organisms);
    return {
        ...spec,
        keywords: compactKeywords,
        targets,
        compounds,
        options,
        // pass the boolean string in keywords as well so orchestrator uses it for EPMC/OpenAlex
        // (your research_orchestrator builds the actual calls)
        // we keep sources as provided
    };
}
/* ----------------------------
 * 2) Analysis (generic + adaptive to cues)
 * ---------------------------- */
function analyzeGeneric(normalized) {
    const C = normalized.compounds || [], T = normalized.targets || [], A = normalized.assays || [], L = normalized.literature || [];
    // Per-target potency (pChEMBL)
    const byT = {};
    for (const a of A) {
        const tid = s(a.target_id || a.chembl_target_id || a.target);
        const p = num(a.pchembl_value);
        if (!tid || p == null)
            continue;
        (byT[tid] || (byT[tid] = [])).push(p);
    }
    const targetStats = Object.entries(byT).map(([t, arr]) => ({
        target_id: t, n: arr.length, pchembl_mean: mean(arr), pchembl_median: median(arr),
        pchembl_q1: qtile(arr, 0.25), pchembl_q3: qtile(arr, 0.75)
    })).sort((a, b) => (b.pchembl_mean ?? 0) - (a.pchembl_mean ?? 0)).slice(0, 12);
    // Organisms
    const byOrg = {};
    for (const t of T) {
        const org = s(t.organism || t.organism_name);
        if (org)
            byOrg[org] = (byOrg[org] || 0) + 1;
    }
    const topOrganisms = Object.entries(byOrg).map(([organism, count]) => ({ organism, count })).sort((a, b) => b.count - a.count).slice(0, 8);
    // Compound physchem
    const pick = (k) => C.map((c) => num(c[k] ?? c[k?.toUpperCase?.()] ?? c[k?.toLowerCase?.()])).filter((x) => x != null);
    const mw = pick('MolecularWeight').concat(pick('mw')), tpsa = pick('TPSA').concat(pick('tpsa')), xlogp = pick('XLogP').concat(pick('xlogp'));
    const compSummary = { n: C.length, mw: { n: mw.length, mean: mean(mw), median: median(mw) }, tpsa: { n: tpsa.length, mean: mean(tpsa), median: median(tpsa) }, xlogp: { n: xlogp.length, mean: mean(xlogp), median: median(xlogp) } };
    // Literature highlights (prefer DOI + recency)
    const topLit = [...L].sort((a, b) => {
        const ay = Number(a.year || a.pubYear || a.publication_year || 0), by = Number(b.year || b.pubYear || b.publication_year || 0);
        const ad = s(a.doi) ? 1 : 0, bd = s(b.doi) ? 1 : 0;
        return (bd - ad) || (by - ay);
    }).slice(0, 10).map((l) => ({ title: s(l.title || l.display_name), year: s(l.year || l.pubYear || l.publication_year), doi: s(l.doi), pmid: s(l.pmid) }));
    return { targetStats, topOrganisms, compSummary, topLit };
}
// Technique-specific sidebars (activated only if cues found)
function analyzeTechniques(normalized, cues) {
    const A = normalized.assays || [], L = normalized.literature || [];
    const out = {};
    if (cues.techniques.includes('TRAP')) {
        const trapRx = /(TRAP assay|telomerase repeat amplification)/i;
        const trapL = L.filter((x) => trapRx.test(s(x.title)));
        out.trap = { mentions: trapL.length, examples: trapL.slice(0, 5).map((l) => ({ title: s(l.title), year: s(l.year || l.pubYear || l.publication_year), doi: s(l.doi) })) };
    }
    if (cues.techniques.includes('MIC')) {
        const micA = A.filter((a) => /MIC/i.test(s(a.standard_type)));
        const vals = micA.map((a) => num(a.standard_value)).filter((x) => x != null);
        out.mic = { n: micA.length, median: median(vals), q1: qtile(vals, 0.25), q3: qtile(vals, 0.75) };
    }
    return out;
}
/* ----------------------------
 * 3) Narrative (adapts to cues)
 * ---------------------------- */
function renderMD(hyp, metrics, core, tech) {
    const m = metrics || {};
    let md = `# Research Report
**Hypothesis:** ${hyp}

## Data Coverage
- Compounds: ${m.counts?.compounds ?? 0} (InChIKey ${Number(m.metrics?.compounds_inchikey_cov || 0).toFixed(1)}%)
- Targets: ${m.counts?.targets ?? 0} (UniProt ${Number(m.metrics?.targets_uniprot_cov || 0).toFixed(1)}%)
- Assays: ${m.counts?.assays ?? 0} (linked ${Number(m.metrics?.assays_target_linked || 0).toFixed(1)}%)
- Literature: ${m.counts?.literature ?? 0} (DOI ${Number(m.metrics?.literature_doi_cov || 0).toFixed(1)}%)

## Key Findings
`;
    if (tech.trap) {
        md += `### TRAP (Telomerase) Signals
- Mentions in literature: ${tech.trap.mentions}
${(tech.trap.examples || []).map((e) => `- ${e.year || 'n.d.'} — ${e.title}${e.doi ? ` (DOI: ${e.doi})` : ''}`).join('\n')}\n\n`;
    }
    if (tech.mic) {
        md += `### Antibacterial MIC Summary
- n=${tech.mic.n}, median=${tech.mic.median ?? 'n/a'} (Q1=${tech.mic.q1 ?? 'n/a'}, Q3=${tech.mic.q3 ?? 'n/a'})\n\n`;
    }
    md += `### Assay Potency by Target (Top)
${core.targetStats.map((t) => `- ${t.target_id}: mean pChEMBL ${t.pchembl_mean?.toFixed(2) ?? 'n/a'} (n=${t.n})`).join('\n') || '- n/a'}

### Organisms (Top)
${core.topOrganisms.map((o) => `- ${o.organism}: ${o.count}`).join('\n') || '- n/a'}

### Compound Properties
- n=${core.compSummary.n}; MW mean=${core.compSummary.mw.mean?.toFixed(1) ?? 'n/a'}, TPSA mean=${core.compSummary.tpsa.mean?.toFixed(1) ?? 'n/a'}, XLogP mean=${core.compSummary.xlogp.mean?.toFixed(2) ?? 'n/a'}

### Literature Highlights
${core.topLit.map((l) => `- ${l.year || 'n.d.'} — ${l.title}${l.doi ? ` (DOI: ${l.doi})` : ''}${l.pmid ? ` [PMID:${l.pmid}]` : ''}`).join('\n') || '- n/a'}

## Interpretation (Tailored)
- Findings are scoped from your hypothesis via automatic target/compound discovery and context cues (organisms, techniques). Signals should be read as **screening-level** evidence pending assay comparability checks.
- Where technique cues were detected (e.g., TRAP, MIC), summaries above highlight **direct** and **indirect** evidence.
- Low coverage in any section suggests either scarce public data or mismatched terminology—consider broadening synonyms on a follow-up run.

## Next Steps
- Refine the hypothesis phrasing or add synonyms (e.g., alternative assay names) to increase coverage.
- If activation (not inhibition) was implied, consider relaxing strict potency filters in follow-ups (already applied when detected).
`;
    return md;
}
function mdToHtml(md) {
    const esc = (t) => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const lines = md.split(/\r?\n/);
    const out = [];
    for (const line of lines) {
        if (line.startsWith('### '))
            out.push(`<h3>${esc(line.slice(4))}</h3>`);
        else if (line.startsWith('## '))
            out.push(`<h2>${esc(line.slice(3))}</h2>`);
        else if (line.startsWith('# '))
            out.push(`<h1>${esc(line.slice(2))}</h1>`);
        else if (line.startsWith('- '))
            out.push(`<li>${esc(line.slice(2))}</li>`);
        else if (line.trim() === '')
            out.push('');
        else
            out.push(`<p>${esc(line)}</p>`);
    }
    const joined = out.join('\n').replace(/(?:^|\n)(<li>[\s\S]*?<\/li>(?:\n<li>[\s\S]*?<\/li>)*)/g, m => `<ul>\n${m}\n</ul>`);
    return `<!doctype html><html><head><meta charset="utf-8"/>
<title>Research Report</title>
<style>
body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:36px;line-height:1.5}
h1{font-size:24px;margin:0 0 12px} h2{font-size:18px;margin:20px 0 8px} h3{font-size:16px;margin:16px 0 6px}
p{margin:6px 0} ul{margin:6px 0 12px 24px} li{margin:3px 0}
</style></head><body>${joined}</body></html>`;
}
/* ----------------------------
 * 4) Main entry
 * ---------------------------- */
export async function hypothesisRun(input) {
    // Build a scoped spec from the hypothesis (generic, no hardcoded biology)
    const baseSpec = ResearchRun.parse(input.research);
    const scoped = await autoscope(input.hypothesis, baseSpec);
    // Run Stage-3 orchestration
    const rr = await researchRun(scoped);
    // Rebuild cues from final keywords to choose sidebars
    const cues = detectContextCues([input.hypothesis, ...(scoped.keywords || [])].join(' '));
    // Analysis: generic + technique-specific
    const core = analyzeGeneric(rr.normalized);
    const tech = analyzeTechniques(rr.normalized, cues);
    // Narrative
    const md = renderMD(input.hypothesis, rr.metrics, core, tech);
    const html = mdToHtml(md);
    return {
        ok: true,
        hypothesis: input.hypothesis,
        scoped, // final spec used (for transparency)
        metrics: rr.metrics,
        normalized: rr.normalized,
        analysis: { core, tech },
        narrative_md: md,
        html
    };
}
/* =========================
 * Registration (you already did this)
 *
 * import { HypothesisRun, hypothesisRun } from './hypothesis_orchestrator.js';
 * tools.push({ name:'research.hypothesis.run', inputSchema: HypothesisRun, handler: async (i)=>hypothesisRun(HypothesisRun.parse(i)) });
 * ========================= */
