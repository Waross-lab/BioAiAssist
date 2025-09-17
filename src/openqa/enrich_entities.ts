// src/openqa/enrich_entities.ts
import type { PublicationRecord, GeneRecord, Slots } from "./schemas.js";

const GENE_TOKEN = /\b[A-Z][A-Z0-9]{2,6}\b/g;
const CONTEXT = /\b(gene|protein|promoter|methyl|expression|overexpression|silencing|knockdown|mutation|variant|amplification|deletion|pathway|receptor|kinase)\b/i;

const BLOCK = new Set<string>([
  "AND","OR","THE","A","AN","OF","IN","FOR","WITH","TO","BY","AT","VS",
  "WHAT","PERCENT","BENEFIT","FROM","IS","ARE","DO","DOES",
  "GBM","NSCLC","CRC","AML","CML","ALL","MM","DLBCL","DNA","RNA","EGFP","GFP","PCR",
  "HR","OS","OR","RR","CI","TMZ","TCGA","PFS","ORR","DFS","EFS","DOR","DCR","TTF"
]);

function sentenceSplit(s: string): string[] {
  return String(s || "").split(/(?<=[\.\?!;])\s+/);
}

export function enrichGenesFromPublications(
  pubs: PublicationRecord[],
  baseSlots: Slots,
  excludeTokensUP: Set<string> // pass drug/disease tokens (UPPERCASE) to avoid false genes
): { geneRecords: GeneRecord[], mergedGeneSymbols: string[] } {

  const counts = new Map<string, number>();

  for (const p of pubs) {
    const title = p.title || p.label || "";
    const abstr = String(p.meta?.abstract || "");
    for (const chunk of [...sentenceSplit(title), ...sentenceSplit(abstr)]) {
      if (!CONTEXT.test(chunk)) continue; // keep only bio-context sentences
      const matches = chunk.match(GENE_TOKEN) || [];
      for (const tok of matches) {
        const T = tok.toUpperCase();
        if (T.length < 2 || T.length > 7) continue;
        if (BLOCK.has(T)) continue;
        if (excludeTokensUP.has(T)) continue;
        if (!/[A-Z]/.test(T)) continue;
        counts.set(T, (counts.get(T) || 0) + 1);
      }
    }
  }

  // Keep tokens that appear at least twice across context sentences (precision bump)
  const top = Array.from(counts.entries())
    .filter(([_, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([sym]) => sym);

  // Merge with any existing slot genes (but keep unique)
  const mergedGeneSymbols = Array.from(new Set([...(baseSlots.genes || []), ...top]));

  const geneRecords: GeneRecord[] = mergedGeneSymbols.map(sym => ({
    kind: "Gene",
    id: `SYMBOL:${sym}`,
    symbol: sym,
    organism: baseSlots.organism || "human",
    label: sym,
    xref: { HGNC: sym },
    source: { server: "derived", tool: "gene_mention_miner", args: {} }
  }));

  return { geneRecords, mergedGeneSymbols };
}
