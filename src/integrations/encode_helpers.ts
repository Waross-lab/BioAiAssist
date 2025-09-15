// src/integrations/encode_helpers.ts
import { EncodeAdapter, EncodeQuery } from "../adapters/encode";

// Minimal shared shapes; align with your existing types if names differ.
export interface TargetRow {
  source_ids: { UniProt?: string|null; ChEMBL?: string|null; ENCODE?: string|null };
  name?: string;
  organism?: string;
  synonyms?: string[];
}
export interface AssayRow {
  source_ids: { ChEMBL?: string|null; ENCODE?: string|null };
  target_ref?: { source: "ChEMBL"|"UniProt"|"ENCODE"; id: string } | null;
  compound_ref?: { source: string; id: string } | null;
  activity_type?: string | null;
  activity_value?: number | string | null;
  activity_units?: string | null;
  pchembl?: number | null;
}

/**
 * Derive ENCODE assay filters from free-text tokens.
 * We keep this simple to avoid hard-coding biology; just detect common assay names.
 */
export function makeEncodeQuery(tokens: string[], organism: string, maxPerSource = 50): EncodeQuery {
  const assayHints = tokens.filter(t =>
    /(chip-?seq|atac-?seq|rna-?seq|dnase-?seq|hi-?c|chip-?exo|mpr(a)?)/i.test(t)
  );
  return {
    organism,
    assay_titles: assayHints,
    maxPerSource: Math.min(200, Math.max(1, maxPerSource)),
    status: "released",
  };
}

/** Fetch ENCODE experiments using the adapter. */
export async function fetchEncode(q: EncodeQuery): Promise<any[]> {
  const adapter = new EncodeAdapter();
  return adapter.query(q);
}

/** Normalize ENCODE rows into lightweight Targets + Assays. */
export function normalizeEncode(rows: any[], organism: string): { targets: TargetRow[]; assays: AssayRow[] } {
  // Targets
  const targets: TargetRow[] = rows.map((e: any) => {
    const orgObj = Array.isArray(e.organism) ? e.organism[0] : e.organism;
    const sci = orgObj?.scientific_name || orgObj?.name || organism;
    const tgt = Array.isArray(e.target) ? e.target[0] : e.target;
    const label = tgt?.label || tgt?.name;
    const id = tgt?.accession || tgt?.uuid || tgt?.["@id"] || null;
    return label
      ? ({ source_ids: { ENCODE: id }, name: label, organism: sci, synonyms: [] } as TargetRow)
      : null;
  }).filter(Boolean) as TargetRow[];

  // quick index for linking
  const tIdx = new Map<string, TargetRow>();
  for (const t of targets) {
    const key = (t.source_ids.ENCODE || t.name || JSON.stringify(t.source_ids)) + "";
    tIdx.set(key, t);
  }

  // Assays
  const assays: AssayRow[] = rows.map((e: any) => {
    const acc = e?.accession || e?.uuid || null;
    const tgt = Array.isArray(e.target) ? e.target[0] : e.target;
    const label = tgt?.label || tgt?.name;

    let target_ref: AssayRow["target_ref"] = null;
    if (label) {
      for (const v of tIdx.values()) {
        if (v.name && String(v.name).toLowerCase() === String(label).toLowerCase()) {
          target_ref = { source: "ENCODE", id: (v.source_ids.ENCODE as string) };
          break;
        }
      }
    }

    const assay_title = e?.assay_title || e?.assay_term_name || "ENCODE assay";
    return {
      source_ids: { ENCODE: acc },
      target_ref,
      compound_ref: null,
      activity_type: assay_title,
      activity_value: null,
      activity_units: null,
      pchembl: null,
    } as AssayRow;
  });

  return { targets, assays };
}

/** Helper to filter ENCODE rows by organism in case upstream didn't filter. */
export function encodeRowMatchesOrganism(row: any, organism: string): boolean {
  if (!row) return false;
  const org = Array.isArray(row.organism) ? row.organism[0] : row.organism;
  const sci = org?.scientific_name || org?.name || "";
  return typeof sci === "string"
    ? sci.toLowerCase().includes(organism.toLowerCase())
    : true; // keep rows if absent
}
