/*
 * planner_normalizer_with_chembl.js
 *
 * This script extends the planner/normalizer example by integrating ChEMBL
 * queries for each detected drug.  It detects genes and drug names in
 * the question, calls UniProt, PubChem, Europe PMC and ClinicalTrials.gov
 * via your MCP server, and additionally queries ChEMBL (a public drug
 * data bank) via the MCP server to enrich each drug.  No API key is
 * required for ChEMBL.
 *
 * Usage: run with Node.js (v18+) while your MCP server is running at
 * http://localhost:8788/mcp.
 *
 * Example:
 *   $ node planner_normalizer_with_chembl.js "MGMT methylation and temozolomide"
 */

/* eslint-disable no-console */

const getFetch = async () => {
  if (typeof fetch !== 'undefined') {
    return fetch;
  }
  const mod = await import('node-fetch');
  return mod.default;
};

function detectGenes(question) {
  const genes = [];
  const tokens = question.split(/\W+/);
  for (const token of tokens) {
    if (token.length >= 3 && token.length <= 6 && /^[A-Z0-9]+$/.test(token)) {
      genes.push(token);
    }
  }
  return [...new Set(genes)];
}

function detectDrugs(question) {
  const drugs = [];
  const patterns = [
    /temozolomide/i,
    /temodar/i,
    /tmz/i,
  ];
  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (match) {
      drugs.push(match[0].toLowerCase());
    }
  }
  return [...new Set(drugs)];
}

async function fetchGeneInfo(fetchFn, gene) {
  const url = new URL('http://localhost:8788/mcp/uniprot.search');
  url.searchParams.set('query', gene);
  url.searchParams.set('size', '1');
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`uniprot.search failed: ${res.status}`);
  const data = await res.json();
  const item = data && data.results && data.results.length > 0 ? data.results[0] : null;
  if (!item) return null;
  return {
    accession: item.primaryAccession || item.accession,
    geneName: item.primaryGene ? item.primaryGene.value : gene,
    proteinName: item.proteinDescription ? item.proteinDescription.recommendedName?.fullName?.value : undefined,
    organism: item.organism?.scientificName,
    length: item.sequenceLength,
    entryType: item.entryType,
    links: {
      uniprot: item.primaryAccession ? `https://www.uniprot.org/uniprotkb/${item.primaryAccession}` : undefined,
    },
    source: 'UniProt',
  };
}

async function fetchCompoundInfo(fetchFn, drug) {
  const searchUrl = new URL('http://localhost:8788/mcp/pubchem.compound.search');
  searchUrl.searchParams.set('namespace', 'name');
  searchUrl.searchParams.set('identifier', drug);
  searchUrl.searchParams.set('max', '1');
  const searchRes = await fetchFn(searchUrl);
  if (!searchRes.ok) throw new Error(`pubchem.compound.search failed: ${searchRes.status}`);
  const searchData = await searchRes.json();
  const first = searchData && searchData.identifierList && searchData.identifierList.CID && searchData.identifierList.CID.length > 0
    ? searchData.identifierList.CID[0]
    : null;
  if (!first) return null;
  const cid = first;
  const propsUrl = new URL('http://localhost:8788/mcp/pubchem.compound.props');
  propsUrl.searchParams.set('cids', cid.toString());
  const propsRes = await fetchFn(propsUrl);
  const propsData = propsRes.ok ? await propsRes.json() : {};
  const synUrl = new URL('http://localhost:8788/mcp/pubchem.compound.synonyms');
  synUrl.searchParams.set('cid', cid.toString());
  synUrl.searchParams.set('max', '10');
  const synRes = await fetchFn(synUrl);
  const synData = synRes.ok ? await synRes.json() : {};
  return {
    cid,
    name: drug,
    synonyms: synData && synData.InformationList && synData.InformationList.Information && synData.InformationList.Information[0] && synData.InformationList.Information[0].Synonym || [],
    properties: propsData && propsData.PropertyTable && propsData.PropertyTable.Properties ? propsData.PropertyTable.Properties[0] : {},
    links: {
      pubchem: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`,
    },
    source: 'PubChem',
  };
}

async function fetchChemblInfo(fetchFn, drug) {
  const url = new URL('http://localhost:8788/mcp/chembl.molecule.search');
  url.searchParams.set('q', drug);
  url.searchParams.set('limit', '1');
  url.searchParams.set('offset', '0');
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`chembl.molecule.search failed: ${res.status}`);
  const data = await res.json();
  // data is an array of molecule records
  const first = Array.isArray(data) && data.length > 0 ? data[0] : null;
  if (!first) return null;
  return {
    molecule_chembl_id: first.molecule_chembl_id,
    pref_name: first.pref_name,
    synonyms: first.molecule_synonyms || [],
    properties: first.molecule_properties || {},
    max_phase: first.max_phase,
    links: {
      chembl: `https://www.ebi.ac.uk/chembl/compound_report_card/${first.molecule_chembl_id}`,
    },
    source: 'ChEMBL',
  };
}

async function fetchLiterature(fetchFn, query) {
  const url = new URL('http://localhost:8788/mcp/europepmc.search');
  url.searchParams.set('query', query);
  url.searchParams.set('pageSize', '25');
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`europepmc.search failed: ${res.status}`);
  const data = await res.json();
  const results = [];
  const list = data.resultList && data.resultList.result ? data.resultList.result : [];
  for (const item of list) {
    results.push({
      pmid: item.pmid || item.id || null,
      title: item.title,
      year: item.pubYear ? Number(item.pubYear) : null,
      journal: item.journalTitle,
      authors: item.authorString,
      abstract: item.abstractText,
      source: 'EuropePMC',
      links: {
        pubmed: item.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}` : undefined,
      },
    });
  }
  return results;
}

async function fetchTrials(fetchFn, expr) {
  const url = new URL('http://localhost:8788/mcp/search_trials');
  url.searchParams.set('expr', expr);
  url.searchParams.set('maxRank', '50');
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`search_trials failed: ${res.status}`);
  const data = await res.json();
  const studies = data && data.Studies && data.Studies.Study || [];
  const results = [];
  for (const study of studies) {
    results.push({
      nctId: study.NCTId,
      title: study.BriefTitle,
      phase: study.Phase || null,
      status: study.OverallStatus,
      conditions: study.Condition,
      interventions: study.Intervention ? study.Intervention.map(i => i.InterventionName) : [],
      links: {
        ctgov: `https://clinicaltrials.gov/study/${study.NCTId}`,
      },
      source: 'ClinicalTrials.gov',
    });
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const question = args.join(' ') || 'What percent of MGMT promoter methylation in GBM patients benefit from temozolomide (Temodar/TMZ)?';
  try {
    const bundle = await buildEvidenceBundle(question);
    console.log(JSON.stringify(bundle, null, 2));
  } catch (err) {
    console.error('Error building bundle:', err);
    process.exit(1);
  }
}

async function buildEvidenceBundle(question) {
  const fetchFn = await getFetch();
  const genes = detectGenes(question);
  const drugs = detectDrugs(question);
  const literatureQuery = '(glioblastoma OR GBM) AND (temozolomide OR Temodar OR TMZ) AND (MGMT AND (methyl* OR promoter) AND (cutoff OR threshold OR percent OR percentage))';
  const trialExpr = 'AREA[ConditionSearch] (glioblastoma OR GBM) AND AREA[InterventionName] (temozolomide OR Temodar OR TMZ) AND (randomized OR phase)';
  const genePromises = genes.map(g => fetchGeneInfo(fetchFn, g));
  const compoundPromises = drugs.map(d => fetchCompoundInfo(fetchFn, d));
  const chemblPromises = drugs.map(d => fetchChemblInfo(fetchFn, d));
  const litPromise = fetchLiterature(fetchFn, literatureQuery);
  const trialPromise = fetchTrials(fetchFn, trialExpr);
  const geneResults = await Promise.allSettled(genePromises);
  const compoundResults = await Promise.allSettled(compoundPromises);
  const chemblResults = await Promise.allSettled(chemblPromises);
  const [litResults, trialResults] = await Promise.all([litPromise, trialPromise]);
  const geneInfo = {};
  geneResults.forEach((res, idx) => {
    const gene = genes[idx];
    if (require.main === module) {
  main();
}
    if (res.status === 'fulfilled' && res.value) {
      geneInfo[gene] = res.value;
    }
  });
  const compoundInfo = {};
  compoundResults.forEach((res, idx) => {
    const drug = drugs[idx];
    if (res.status === 'fulfilled' && res.value) {
      compoundInfo[drug] = res.value;
    }
  });
  // Attach ChEMBL info
  chemblResults.forEach((res, idx) => {
    const drug = drugs[idx];
    if (compoundInfo[drug]) {
      compoundInfo[drug].chembl = res.status === 'fulfilled' ? res.value : null;
    }
  });
  return {
    question,
    gene_info: geneInfo,
    compound_info: compoundInfo,
    literature: litResults,
    trials: trialResults,
    searchLog: {
      literature_query: literatureQuery,
      trial_expr: trialExpr,
      executed_at: new Date().toISOString(),
    },
  };
}

if (require.main === module) {
  main();
}