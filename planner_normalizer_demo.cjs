// planner_normalizer_demo.js
//
// This script demonstrates a simple “planner + normalizer” workflow using your local
// Bio MCP server. It inspects a free‑text question for gene and drug names,
// decides which MCP tools to call, fetches the data, and assembles a unified
// summary object.  It’s intentionally simple and heuristic‑based—you can
// enhance it with NLP or additional rules as you grow your BioAiAssist.
//
// Usage:
//   node planner_normalizer_demo.js "Your research question"
//
// It will print a JSON object containing gene_info, compound_info,
// literature, and trials.

const fetch = (global.fetch ? global.fetch.bind(global) : (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args)));

const MCP_BASE = process.env.MCP_BASE || 'http://localhost:8788/mcp';

// Very naive parser to extract gene names (all‑caps words) and drug names from a question.
function extractEntities(question) {
  const genes = [];
  const drugs = [];
  const geneRegex = /\b([A-Z]{2,5})\b/g;
  const drugRegex = /\b(temozolomide|temodar|tmz)\b/i;
  let m;
  while ((m = geneRegex.exec(question)) !== null) {
    const g = m[1];
    // Filter out generic acronyms like AND, OR, TMZ itself, etc.
    if (g !== 'AND' && g !== 'OR' && g !== 'TMZ' && genes.indexOf(g) < 0) {
      genes.push(g);
    }
  }
  const drugMatch = question.match(drugRegex);
  if (drugMatch) {
    drugs.push(drugMatch[1]);
  }
  return { genes, drugs };
}

async function callMcp(toolName, params) {
  const query = Object.entries(params)
    .map(([k, v]) => Array.isArray(v)
      ? v.map((vv) => `${encodeURIComponent(k)}=${encodeURIComponent(String(vv))}`).join('&')
      : `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${MCP_BASE}/${toolName}?${query}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${toolName} returned ${res.status}`);
  }
  return await res.json();
}

async function getGeneInfo(gene) {
  // Use uniprot.search to retrieve gene details.
  // We request only one result to keep it simple.
  try {
    const result = await callMcp('uniprot.search', { query: gene, size: 1 });
    const entry = result?.results?.[0];
    if (!entry) return null;
    return {
      query: gene,
      accession: entry?.primaryAccession,
      geneName: entry?.proteinName?.recommendedName?.fullName?.value || entry?.uniProtkbId || null,
      organism: entry?.organism?.scientificName || null,
    };
  } catch (err) {
    return null;
  }
}

async function getCompoundInfo(drug) {
  try {
    // Search for the compound by name
    const searchResult = await callMcp('pubchem.compound.search', { namespace: 'name', identifier: drug, max: 1 });
    const cid = Array.isArray(searchResult?.cids) ? searchResult.cids[0] : null;
    if (!cid) return null;
    // Fetch properties
    const propsResult = await callMcp('pubchem.compound.props', { cids: cid });
    const props = Array.isArray(propsResult) && propsResult.length > 0 ? propsResult[0] : {};
    // Fetch synonyms
    const synsResult = await callMcp('pubchem.compound.synonyms', { cid });
    const synonyms = Array.isArray(synsResult?.synonyms) ? synsResult.synonyms.slice(0, 10) : [];
    return {
      query: drug,
      cid,
      name: props?.CanonicalSMILES ? null : drug,
      formula: props?.MolecularFormula || null,
      weight: props?.MolecularWeight || null,
      xlogp: props?.XLogP || null,
      tpsa: props?.TPSA || null,
      hBondDonorCount: props?.HBondDonorCount || null,
      hBondAcceptorCount: props?.HBondAcceptorCount || null,
      rotatableBondCount: props?.RotatableBondCount || null,
      synonyms,
    };
  } catch (err) {
    return null;
  }
}

function buildLiteratureQuery(question) {
  return '(glioblastoma OR GBM) AND (temozolomide OR Temodar OR TMZ) AND (MGMT AND (methyl* OR promoter) AND (cutoff OR threshold OR percent OR percentage))';
}

function buildCtgovQuery(question) {
  return 'AREA[ConditionSearch] (glioblastoma OR GBM) AND AREA[InterventionName] (temozolomide OR Temodar OR TMZ) AND (randomized OR phase)';
}

function parseEuropePmcResult(res) {
  const pmid = res.pmid || res.id || '';
  const title = res.title || '';
  const year = res.pubYear ? Number(res.pubYear) : null;
  const journal = res.journalTitle || undefined;
  const links = {};
  if (pmid) {
    links.pubmed = `https://pubmed.ncbi.nlm.nih.gov/${pmid}`;
  }
  if (res.fullTextUrlList && res.fullTextUrlList.fullTextUrl) {
    const pdf = res.fullTextUrlList.fullTextUrl.find((u) => /pdf/i.test(u.availability));
    if (pdf) {
      links.pdf = pdf.url;
    }
  }
  return { pmid, title, year, journal, source: 'EuropePMC', links };
}

function parseCtgovResult(res) {
  const nct = res.nctId || '';
  const title = res.title || '';
  const phase = res.phase || undefined;
  const status = res.overallStatus || undefined;
  const condition = Array.isArray(res.conditions) ? res.conditions : undefined;
  const interventions = Array.isArray(res.interventions) ? res.interventions : undefined;
  const links = {};
  if (nct) {
    links.ctgov = `https://clinicaltrials.gov/study/${nct}`;
  }
  return { nct, title, phase, status, condition, interventions, links };
}

async function runPlannerNormalizer(question) {
  const { genes, drugs } = extractEntities(question);
  // Fetch gene and compound info in parallel
  const geneInfos = await Promise.all(genes.map((g) => getGeneInfo(g)));
  const compoundInfos = await Promise.all(drugs.map((d) => getCompoundInfo(d.toLowerCase())));

  // Fetch literature and trials
  const literatureQuery = buildLiteratureQuery(question);
  const ctgovQuery = buildCtgovQuery(question);
  let literature = [];
  let trials = [];
  try {
    const litRes = await callMcp('europepmc.search', { query: literatureQuery, pageSize: 50 });
    const results = litRes?.resultList?.result || [];
    literature = results.map(parseEuropePmcResult);
  } catch (err) {}

  try {
    const trialsRes = await callMcp('search_trials', { expr: ctgovQuery, maxRank: 50 });
    const rows = trialsRes?.rows || [];
    trials = rows.map(parseCtgovResult);
  } catch (err) {}

  return {
    question,
    gene_info: geneInfos.filter(Boolean),
    compound_info: compoundInfos.filter(Boolean),
    literature,
    trials,
  };
}

async function main() {
  const question = process.argv.slice(2).join(' ') || 'What percent of MGMT promoter methylation in GBM patients benefit from temozolomide?';
  const summary = await runPlannerNormalizer(question);
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}
