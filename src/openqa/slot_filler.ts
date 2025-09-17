// src/openqa/slot_filler.ts
import type { Slots } from "./schemas.js";

// A few broad disease synonyms, purely generic
const DISEASE_SYNONYMS: Record<string, string> = {
  nsclc: "non-small cell lung cancer",
  "non small cell lung cancer": "non-small cell lung cancer",
  "non-small-cell lung cancer": "non-small cell lung cancer",
  gbm: "glioblastoma",
  aml: "acute myeloid leukemia",
  cml: "chronic myeloid leukemia",
  crc: "colorectal cancer",
};

// Common drug hints (no hard-coding to one query; feel free to expand)
const DRUG_HINTS = [
  "temozolomide", "temodar", "tmz",
  "sotorasib", "adagrasib",
  "osimertinib", "gefitinib", "erlotinib",
  "dabrafenib", "trametinib", "vemurafenib",
  "imatinib", "ponatinib"
];

// Brand ↔ generic aliases (generic mechanism; extend anytime)
const DRUG_ALIASES: Record<string, string[]> = {
  temozolomide: ["temodar", "tmz"],
  temodar: ["temozolomide", "tmz"],
  tmz: ["temozolomide", "temodar"],
  sotorasib: ["lumakras", "amg 510", "amg510"],
  adagrasib: ["krazati", "mrtx849", "mrtx-849"],
};

// Words we ignore as “genes”
const STOPWORDS = new Set([
  "AND","OR","OF","IN","FOR","WITH","TO","THE","A","AN","ON","BY","AT","VS",
  "ABOUT","SHOW","LIST","FIND","TRIAL","TRIALS",
  "WHAT","PERCENT","BENEFIT","FROM","IS","ARE","DO","DOES","WHO","WHICH","WHERE","WHEN","WHY","HOW",
  "PATIENT","PATIENTS",
  "HR","OS","OR","RR","CI","TMZ","TCGA","PFS","ORR","DFS","EFS","DOR","DCR","TTF"
]);

// Very light gene token heuristic (uppercase 2–7 chars/digits)
const GENE_TOKEN = /^[A-Z][A-Z0-9]{2,6}$/;

// Variant patterns we may want to surface as slots
const VARIANT_PATTERNS = [
  /\bp\.[A-Z][a-z]{2}\d+[A-Z][a-z]{2}\b/i, // p.Gly12Cys
  /\bp\.[A-Z]\d+[A-Z]\b/i,                 // p.G12C
  /\b[A-Z]\d{1,4}[A-Z]\b/,                 // G12C, V600E
  /\brs\d+\b/i,                            // rsIDs
  /\bc\.\d+[ACGT]?>[ACGT]?\b/i             // c.34G>T
];

// Clinical phase + NCT IDs
const PHASE_REGEX = /\bphase\s*(i{1,3}|iv|[1-4])\b/ig;
const NCT_REGEX   = /\bNCT\d{8}\b/ig;

// Normalize a token to “gene-like” form: strip punctuation, uppercase
function normalizeToken(t: string): string {
  return t.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function fillSlots(query: string): Slots {
  const Q = query?.trim() ?? "";
  // Split on non-alphanum but keep simple things like dashes/periods for variants
  const tokens = Q.split(/[^A-Za-z0-9\-\.+]/).filter(Boolean);
  const lower  = Q.toLowerCase();

  // Drugs: detect any hints we know, then expand with aliases
  const baseDrugs = DRUG_HINTS.filter(d => lower.includes(d.toLowerCase()));
  const drugs = Array.from(new Set(baseDrugs.flatMap(d => {
    const dl = d.toLowerCase();
    const aliases = DRUG_ALIASES[dl] ?? [];
    return [d, ...aliases];
  })));

  // Build quick “not-a-gene” sets (avoid classifying these as genes)
  const drugUP = new Set<string>([
    ...drugs.map(d => d.toUpperCase()),
    ...Object.keys(DRUG_ALIASES).map(k => k.toUpperCase()),
    ...Object.values(DRUG_ALIASES).flat().map(v => v.toUpperCase())
  ]);
  const diseaseTokensUP = new Set<string>([
    "GBM","NSCLC","SCLC","CRC","AML","CML","ALL","DLBCL","MM","MELANOMA"
  ]);

  // Genes: normalize to uppercase, strip punctuation, basic pattern, then exclude drugs/diseases/stopwords
  const genes = Array.from(new Set(
    tokens
      .map(normalizeToken)
      .filter(t => t.length > 0)
      .filter(t => GENE_TOKEN.test(t))
      .filter(t => !STOPWORDS.has(t))
      .filter(t => !drugUP.has(t))
      .filter(t => !diseaseTokensUP.has(t))
  ));

  // Variants: collect from the full string (not tokenized)
  const variantsSet = new Set<string>();
  for (const re of VARIANT_PATTERNS) {
    const matches = Q.match(re) ?? [];
    for (const v of matches) variantsSet.add(v);
  }

  // Diseases: map simple synonyms from the raw lowercase query
  const diseasesSet = new Set<string>();
  for (const [k, norm] of Object.entries(DISEASE_SYNONYMS)) {
    if (lower.includes(k)) diseasesSet.add(norm);
  }

  // Clinical phases
  const phases: number[] = [];
  const seenPhase: Record<number, true> = {};
  let m: RegExpExecArray | null;
  while ((m = PHASE_REGEX.exec(Q)) !== null) {
    const g = (m[1] || "").toLowerCase();
    const num =
      g === "iv" ? 4 :
      g === "iii" ? 3 :
      g === "ii" ? 2 :
      g === "i" ? 1 :
      parseInt(g, 10);
    if (num && !seenPhase[num]) { seenPhase[num] = true; phases.push(num); }
  }

  // NCT IDs
  const nctIds = Array.from(new Set(Q.match(NCT_REGEX) ?? []));

  // Organism (very light heuristic)
  const organism =
    /mouse|murine/i.test(Q) ? "mouse" :
    /rat/i.test(Q)          ? "rat"   :
    /zebrafish/i.test(Q)    ? "zebrafish" :
    "human";

  return {
    genes,
    variants: Array.from(variantsSet),
    diseases: Array.from(diseasesSet),
    drugs,
    phases,
    nctIds,
    organism
  };
}
