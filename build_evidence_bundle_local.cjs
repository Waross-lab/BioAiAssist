// build_evidence_bundle_local.js
//
// This script queries your local Bio MCP server (running on http://localhost:8788/mcp)
// to build an EvidenceBundle for a given research question. It calls the
// europepmc.search and search_trials tools via the REST GET endpoints we added.
//
// Usage:
//   node build_evidence_bundle_local.js "Your research question here"
//
// Notes:
//   - Node 18+ has a built-in global fetch; if you're on Node <18, you'll need
//     to install node-fetch (npm install node-fetch) or rely on the dynamic import below.
//   - The script prints the EvidenceBundle as formatted JSON to stdout.

// Helper: fetch function that works in both modern Node and Node <18
const fetch = (global.fetch ? global.fetch.bind(global) : (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args)));

// Build a literature query from a free-text question. For now this is hard-coded
// to the MGMT/temozolomide query used in our pilot. In the future, you could
// derive keywords from the question using NLP or the BioAiAssist planner.
function buildLiteratureQuery(question) {
  return '(glioblastoma OR GBM) AND (temozolomide OR Temodar OR TMZ) AND (MGMT AND (methyl* OR promoter) AND (cutoff OR threshold OR percent OR percentage))';
}

// Build a ClinicalTrials.gov query from a free-text question. Again this is
// currently hard-coded.
function buildCtgovQuery(question) {
  return 'AREA[ConditionSearch] (glioblastoma OR GBM) AND AREA[InterventionName] (temozolomide OR Temodar OR TMZ) AND (randomized OR phase)';
}

// Parse a Europe PMC result into a minimal literature record.
function parseEuropePmcResult(res) {
  const pmid = res.pmid || res.id || '';
  const title = res.title || '';
  const year = res.pubYear ? Number(res.pubYear) : null;
  const journal = res.journalTitle || undefined;
  const links = {};
  if (pmid) {
    links.pubmed = `https://pubmed.ncbi.nlm.nih.gov/${pmid}`;
  }
  // Try to capture a PDF link if present
  if (res.fullTextUrlList && res.fullTextUrlList.fullTextUrl) {
    const pdf = res.fullTextUrlList.fullTextUrl.find((u) => /pdf/i.test(u.availability));
    if (pdf) {
      links.pdf = pdf.url;
    }
  }
  return {
    pmid,
    title,
    year,
    journal,
    source: 'EuropePMC',
    extraction_confidence: 'low',
    links,
  };
}

// Parse a ClinicalTrials.gov result row into a minimal trial record.
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

// Build an EvidenceBundle by calling the local MCP endpoints.
async function buildEvidenceBundle(question) {
  const base = process.env.MCP_BASE || 'http://localhost:8788/mcp';
  const literatureQuery = buildLiteratureQuery(question);
  const ctgovQuery = buildCtgovQuery(question);
  const timestamp = new Date().toISOString();

  const bundle = {
    question,
    version: 'evidence-bundle.v1',
    literature: [],
    trials: [],
    searchLog: {
      literature_query: literatureQuery,
      ctgov_query: ctgovQuery,
      executed_at: timestamp,
    },
  };

  // 1) Fetch literature from Europe PMC
  try {
    const litUrl = `${base}/europepmc.search?query=${encodeURIComponent(literatureQuery)}&pageSize=50`;
    const litRes = await fetch(litUrl);
    const litJson = await litRes.json();
    const results = litJson?.resultList?.result || [];
    for (const record of results) {
      bundle.literature.push(parseEuropePmcResult(record));
    }
  } catch (err) {
    console.error('Error fetching literature:', err.message || err);
  }

  // 2) Fetch trials from ClinicalTrials.gov
  try {
    // search_trials tool expects an "expr" parameter. Additional params like minRank/maxRank/fields are optional.
    const trialsUrl = `${base}/search_trials?expr=${encodeURIComponent(ctgovQuery)}&maxRank=50`;
    const trialsRes = await fetch(trialsUrl);
    const trialsJson = await trialsRes.json();
    const rows = trialsJson?.rows || [];
    for (const row of rows) {
      bundle.trials.push(parseCtgovResult(row));
    }
  } catch (err) {
    console.error('Error fetching trials:', err.message || err);
  }

  return bundle;
}

async function main() {
  const question = process.argv.slice(2).join(' ') || 'What percent of MGMT promoter methylation in GBM patients benefit from temozolomide (Temodar/TMZ)?';
  const bundle = await buildEvidenceBundle(question);
  console.log(JSON.stringify(bundle, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}
