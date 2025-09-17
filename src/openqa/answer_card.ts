// src/openqa/answer_card.ts
import type {
  AnswerCard, CanonicalRecord, Slots,
  GeneRecord, ProteinRecord, PathwayRecord, VariantRecord,
  DiseaseRecord, DrugRecord, TrialRecord, PublicationRecord
} from "./schemas.js";
import { enrichGenesFromPublications } from "./enrich_entities.js";

// --- Ranking helpers (generic, query-agnostic) ---
function scorePublication(p: PublicationRecord, slots?: Slots): number {
  const title = (p.title ?? p.label ?? "").toLowerCase();
  const abstract = String(p.meta?.abstract ?? "").toLowerCase();
  const journal = String(p.meta?.journal ?? "").toLowerCase();
  const text = `${title} ${abstract} ${journal}`;

  const isTrial    = /\b(randomi[sz]ed|randomised|clinical trial|phase\s*(?:i{1,3}|iv|[1-4]))\b/.test(text);
  const isMeta     = /\bmeta[-\s]?analysis\b|\bsystematic review\b/.test(text);
  const isReview   = /\breview\b/.test(text) && !/\bprotocol\b/.test(text);
  const isPreprint = /\bbiorxiv|medrxiv|preprint\b/.test(text);

  const ex: any = p.meta?.extracted;
  const hasHR   = Array.isArray(ex?.hr) && ex.hr.length > 0;
  const hasMed  = Array.isArray(ex?.medians) && ex.medians.length > 0;
  const hasCut  = Array.isArray(ex?.cutoffs) && ex.cutoffs.length > 0;

  const year = Number(p.meta?.year ?? (p.date ? p.date.slice(0, 4) : NaN));
  const recencyBump = Number.isFinite(year) ? Math.min(3, Math.max(0, (year - 2010) / 5)) : 0;

  let slotBump = 0;
  if (slots) {
    const hit = (arr?: string[]) =>
      (arr ?? []).some(t => t && text.includes(String(t).toLowerCase()));
    if (hit(slots.genes))     slotBump += 0.5;
    if (hit(slots.drugs))     slotBump += 0.5;
    if (hit(slots.diseases))  slotBump += 0.5;
    if (hit(slots.variants))  slotBump += 0.25;
  }

  let s = 0;
  if (isTrial) s += 6;
  if (isMeta)  s += 5;
  if (hasHR)   s += 3;
  if (hasMed)  s += 3;
  if (hasCut)  s += 1;

  if (isReview)   s -= 2;
  if (isPreprint) s -= 1;

  s += recencyBump + slotBump;
  return s;
}

function cmpYearDesc(a?: number, b?: number) {
  const A = Number.isFinite(a as number) ? (a as number) : -1;
  const B = Number.isFinite(b as number) ? (b as number) : -1;
  return B - A;
}

export function buildAnswerCard(
  query: string,
  slots: Slots,
  records: CanonicalRecord[],
  toolsRun: Array<{ server: string; tool: string; ok: boolean; ms: number }>
): AnswerCard {
  const pick = <T extends CanonicalRecord>(kind: T["kind"]) =>
    (records.filter(r => r.kind === kind) as unknown as T[]);

  // Base entities from canonical records
  const baseGenes   = pick<GeneRecord>("Gene");
  const proteins    = pick<ProteinRecord>("Protein").slice(0, 12);
  const pathways    = pick<PathwayRecord>("Pathway").slice(0, 16);
  const variants    = pick<VariantRecord>("Variant").slice(0, 16);
  const diseases    = pick<DiseaseRecord>("Disease").slice(0, 12);
  const drugs       = pick<DrugRecord>("Drug").slice(0, 12);
  const trials      = pick<TrialRecord>("Trial").slice(0, 16);

  // --- Rank publications before slicing ---
  let pubsAll = pick<PublicationRecord>("Publication");
  pubsAll.sort((a, b) => {
    const s = scorePublication(b, slots) - scorePublication(a, slots);
    if (s !== 0) return s;

    const ya = Number(a.meta?.year ?? (a.date ? a.date.slice(0, 4) : NaN));
    const yb = Number(b.meta?.year ?? (b.date ? b.date.slice(0, 4) : NaN));
    const yc = cmpYearDesc(ya, yb);
    if (yc !== 0) return yc;

    const ta = (a.title ?? a.label ?? "").toLowerCase();
    const tb = (b.title ?? b.label ?? "").toLowerCase();
    return ta.localeCompare(tb);
  });
  const publications = pubsAll.slice(0, 20);

  // --- Enrich genes from publication titles/abstracts (generic) ---
  const excludeUP = new Set<string>([
    ...drugs.map(d => (d as any).label?.toUpperCase?.()
      || (d as any).name?.toUpperCase?.()
      || String((d as any).id || d).toUpperCase()),
    "GBM","NSCLC","CRC","AML","CML","ALL","MM","DLBCL"
  ]);
  const { geneRecords, mergedGeneSymbols } =
    enrichGenesFromPublications(publications, slots, excludeUP);

  // Merge base + mined genes, unique by symbol/id
  const mergedGenes = Array.from(new Map(
    [...baseGenes, ...geneRecords].map(g => [g.symbol || g.id, g])
  ).values()).slice(0, 12);

  // Highlights (use merged genes)
  const highlights: Array<{ text: string; recordId?: string }> = [];
  if (mergedGenes[0]) highlights.push({ text: `Top gene: ${mergedGenes[0].symbol ?? mergedGenes[0].label ?? mergedGenes[0].id}` });
  if (trials[0])      highlights.push({ text: `Trial: ${trials[0].nctId ?? trials[0].label}` });
  if (pathways[0])    highlights.push({ text: `Pathway: ${pathways[0].label}` });

  const evidence = publications.slice(0, 30).map((p: PublicationRecord) => ({
    recordKind: "Publication" as const,
    label: p.title ?? p.label,
    id: p.pmid ? `PMID:${p.pmid}` : (p.doi ? `DOI:${p.doi}` : p.id),
    source: { server: p.source?.server ?? "", tool: p.source?.tool ?? "" }
  }));

  return {
    query,
    slots: { ...slots, genes: mergedGeneSymbols.slice(0, 12) },
    entities: { genes: mergedGenes, proteins, pathways, variants, diseases, drugs, trials, publications },
    highlights,
    evidence,
    toolsRun
  };
}
