// src/openqa/normalization_map.ts
import type {
  CanonicalRecord, ProteinRecord, PathwayRecord, TrialRecord, GeneRecord, PublicationRecord
} from "./schemas.js";
import { extractMetrics } from "./extractors/text_metrics.js";

// ---- MAPPERS ----
function mapUniProtResult(raw: any, prov: {server:string;tool:string;args?:any}): CanonicalRecord[] {
  const hits = raw?.hits ?? [];
  const out: CanonicalRecord[] = [];
  for (const h of hits) {
    const p: ProteinRecord = {
      kind: "Protein",
      id: h.id ?? h.accession,
      accession: h.id ?? h.accession,
      geneSymbol: h.symbol ?? h.gene ?? undefined,
      label: h.symbol ? `${h.symbol} protein` : (h.id ?? "protein"),
      xref: { UniProt: h.id ?? h.accession },
      source: prov,
      meta: { raw: h }
    };
    out.push(p);
    if (h.symbol) {
      const g: GeneRecord = {
        kind: "Gene",
        id: `HGNC:${h.symbol}`,
        symbol: h.symbol,
        organism: "human",
        label: h.symbol,
        xref: { HGNC: h.symbol },
        source: prov
      };
      out.push(g);
    }
  }
  return out;
}

function mapReactomeResult(raw: any, prov: {server:string;tool:string;args?:any}): CanonicalRecord[] {
  const pathways = raw?.pathways ?? [];
  return pathways.map((p: any) => ({
    kind: "Pathway",
    id: p.id,
    pathwayId: p.id,
    label: p.name ?? p.id,
    xref: { Reactome: p.id },
    source: prov,
    meta: { raw: p }
  } as PathwayRecord));
}

function mapCtgovResult(raw: any, prov: {server:string;tool:string;args?:any}): CanonicalRecord[] {
  const trials = raw?.trials ?? [];
  return trials.map((t: any) => ({
    kind: "Trial",
    id: t.nct ?? t.nctId,
    nctId: t.nct ?? t.nctId,
    label: t.title ?? t.nct,
    status: t.status,
    phase: t.phase,
    condition: t.condition,
    interventions: t.interventions,
    xref: { NCT: t.nct ?? t.nctId },
    source: prov,
    meta: { raw: t }
  } as TrialRecord));
}

function mapEuropePmcResult(raw: any, prov: {server:string;tool:string;args?:any}): CanonicalRecord[] {
  const items = raw?.results ?? raw?.resultList?.result ?? [];
  const out: CanonicalRecord[] = [];
  for (const r of items) {
    const metrics = extractMetrics(`${r.title ?? ""}. ${r.abstractText ?? ""}`);
    const rec: PublicationRecord = {
      kind: "Publication",
      id: r.doi ? `DOI:${r.doi}` : (r.pmid ? `PMID:${r.pmid}` : (r.id || undefined)),
      pmid: r.pmid ?? undefined,
      doi: r.doi ?? undefined,
      title: r.title ?? "",
      label: r.title ?? (r.doi || r.pmid || r.id),
      date: r.pubYear ? `${r.pubYear}-01-01` : undefined,
      source: prov,
      meta: {
        journal: r.journal,
        year: r.pubYear,
        authorString: r.authorString,
        abstract: r.abstractText,
        extracted: metrics
      }
    };
    out.push(rec);
  }
  return out;
}

// ---- DISPATCHER ----
export function toCanonical(server: string, tool: string, data: any, args?: any): CanonicalRecord[] {
  const prov = { server, tool, args };
  const s = (server || "").toLowerCase();

  if (s.includes("europmc") || s.includes("europepmc") || s.includes("pubmed")) {
    return mapEuropePmcResult(data, prov);
  }
  if (s.includes("uniprot") || s.includes("protein")) {
    return mapUniProtResult(data, prov);
  }
  if (s.includes("reactome") || s.includes("pathway")) {
    return mapReactomeResult(data, prov);
  }
  if (s.includes("ctgov") || s.includes("clinicaltrials") || s.includes("trials")) {
    return mapCtgovResult(data, prov);
  }

  // Fallback: wrap unknown data as a generic Publication-like record to preserve provenance.
  const rec: CanonicalRecord = {
    kind: "Publication",
    id: undefined,
    label: `${server}:${tool}`,
    source: prov,
    meta: { raw: data }
  };
  return [rec];
}
