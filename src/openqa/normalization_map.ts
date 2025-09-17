// src/openqa/normalization_map.ts

import type {
  CanonicalRecord,
  PublicationRecord,
  GeneRecord,
  ProteinRecord,
  PathwayRecord,
  TrialRecord,
} from "./schemas.js";

/**
 * A small "tool result" shape that matches what the runner provides.
 * Extra fields are ignored.
 */
type ToolResultLike = {
  server: string;
  tool: string;
  raw: any;
};

/* =========================================================================
 * Europe PMC → PublicationRecord
 * ========================================================================= */

function toInt(x: any): number | undefined {
  const n = Number.parseInt(String(x), 10);
  return Number.isFinite(n) ? n : undefined;
}

export function normalizeEuropePmc(row: any): PublicationRecord {
  const pmid = row.pmid || row.id || row.PMID;
  const doi = row.doi || row.DOI;
  const title = row.title || row.Title;
  const journal = row.journal || row.Journal || row.source;
  const abstractText = row.abstractText || row.abstract || row.AbstractText;

  const pubYear =
    row.pubYear ??
    row.pubyear ??
    (typeof row.firstPublicationDate === "string"
      ? row.firstPublicationDate.slice(0, 4)
      : undefined) ??
    (typeof row.date === "string" ? row.date.slice(0, 4) : undefined);

  const rec: PublicationRecord = {
    kind: "Publication",
    // Many of your render paths use pmid/doi + meta.year. Keep a stable id fallback.
    id: pmid ?? doi ?? title ?? undefined,
    title,
    pmid: pmid ? String(pmid) : undefined,
    doi: doi ? String(doi) : undefined,
    // Optional date string if EuropePMC gives one; year lives in meta.year
    date:
      typeof row.firstPublicationDate === "string"
        ? row.firstPublicationDate
        : undefined,
    meta: {
      year: toInt(pubYear),
      journal: journal ? String(journal) : undefined,
      abstract: abstractText ? String(abstractText) : undefined,
      // space for later: extracted metrics live under meta.extracted
    },
  };
  return rec;
}

/* =========================================================================
 * ClinicalTrials.gov → TrialRecord
 * ========================================================================= */

export function normalizeCtgov(row: any): TrialRecord {
  // Study Fields API returns arrays for most fields; pick first when needed
  const get = (k: string) => (Array.isArray(row[k]) ? row[k][0] : row[k]);
  const arr = (k: string) => ((row[k] || []) as string[]).filter(Boolean);

  const nct = get("NCTId");

  const rec: TrialRecord = {
    kind: "Trial",
    nctId: nct ? String(nct) : undefined,
    title: get("BriefTitle"),
    status: get("OverallStatus"),
    phase: get("Phase"),
    // schemas.ts defines `condition?: string` (singular)
    condition:
      arr("Condition")[0] || (arr("Condition").length ? arr("Condition").join("; ") : undefined),
    // schemas.ts defines `interventions?: string[]`
    interventions: arr("InterventionName"),
  };
  return rec;
}

/* =========================================================================
 * Pass-through / stubs for other record kinds (safe no-ops)
 * =========================================================================
 * If other servers already emit canonical shapes, you can let them pass through
 * by returning [] here and letting other parts of the pipeline handle them.
 * Add more normalizers as you wire more MCP tools.
 */

/* =========================================================================
 * Dispatcher: ONE tool result → CanonicalRecord[]
 * ========================================================================= */

export function toCanonical(tr: ToolResultLike): CanonicalRecord[] {
  // --- Europe PMC publications ---
  if (tr.server === "europmc" && tr.tool === "search_publications") {
    const rows =
      tr.raw?.results ??
      tr.raw?.hits ??
      tr.raw?.rows ??
      tr.raw?.publications ??
      [];
    return (rows as any[]).map(normalizeEuropePmc);
  }

  // --- ClinicalTrials.gov study fields ---
  if (tr.server === "ctgov" && tr.tool === "search_trials") {
    const rows =
      tr.raw?.rows ??
      tr.raw?.StudyFields ??
      tr.raw?.StudyFieldsResponse?.StudyFields ??
      [];
    return (rows as any[]).map(normalizeCtgov);
  }

  // Unknown or already-canonical tool → nothing to add here
  return [];
}

/* =========================================================================
 * Optional helper: many tool results → flattened canonical list
 * ========================================================================= */

export function toCanonicalFromMany(toolResults: ToolResultLike[]): CanonicalRecord[] {
  const out: CanonicalRecord[] = [];
  for (const tr of toolResults || []) {
    out.push(...toCanonical(tr));
  }
  return out;
}
