// src/openqa/query_builders/literature.ts
import type { Slots } from "../schemas.js";

// Generic endpoint / study terms (query-agnostic)
const ENDPOINT_TERMS = [
  "overall survival", "OS",
  "progression-free survival", "PFS",
  "hazard ratio", "HR",
  "response rate", "ORR"
];

const STUDY_TERMS = [
  "randomized", "randomised",
  "clinical trial", "phase",
  "meta-analysis", "systematic review",
  "cohort", "case-control"
];

// Lightweight brand↔generic aliases (seed list; safe & generic)
// You can extend this or later swap in an MCP-backed RxNorm/CHEMBL lookup.
const DRUG_ALIASES: Record<string, string[]> = {
  temozolomide: ["temodar", "tmz"],
  temodar: ["temozolomide", "tmz"],
  tmz: ["temozolomide", "temodar"],
  sotorasib: ["lumakras", "amg 510", "amg510"],
  adagrasib: ["krazati", "mrtx849", "mrtx-849"],
};

function expandAliases(terms: string[], dict: Record<string, string[]>): string[] {
  const out = new Set<string>();
  for (const t of terms) {
    out.add(t);
    const alts = dict[t.toLowerCase()];
    if (alts) for (const a of alts) out.add(a);
  }
  return Array.from(out);
}

export function buildEuropePmcQuery(slots: Slots, rawQ: string): string {
  const parts: string[] = [];

  // Compact OR groups from slots (limit to keep queries efficient)
  if (slots.genes?.length)    parts.push(`(${Array.from(new Set(slots.genes)).slice(0, 3).join(" OR ")})`);
  if (slots.diseases?.length) parts.push(`(${Array.from(new Set(slots.diseases)).slice(0, 3).join(" OR ")})`);

  if (slots.drugs?.length) {
    const expanded = expandAliases(slots.drugs.slice(0, 3), DRUG_ALIASES);
    // Quote drug tokens so multiword names are handled
    parts.push(`(${expanded.map(x => `"${x}"`).join(" OR ")})`);
  }

  if (slots.nctIds?.length)   parts.push(`(${slots.nctIds.slice(0, 3).join(" OR ")})`);

  const qLower = (rawQ || "").toLowerCase();

  // Outcome intent?
  const mentionsOutcome = /\b(benefit|efficacy|survival|outcomes?|hazard\s*ratio|hr\b|overall\s*survival|os\b|progression|pfs\b|response\s*rate|orr)\b/i
    .test(rawQ);

  if (mentionsOutcome) {
    parts.push("(overall survival OR OS OR progression-free survival OR PFS OR hazard ratio OR HR OR response rate OR ORR)");
  }

  // Quantification-ish hints (generic; not biomarker-specific)
  if (/\b(methylation|promoter|cut[\-\s]?off|threshold|pyrosequencing|bisulfite|copy\s*number|expression|overexpression)\b/i.test(rawQ)) {
    parts.push('(methylation OR "promoter methylation" OR cutoff OR threshold OR expression)');
  }

  // Study-type filter only if user implied outcomes/benefit
  if (mentionsOutcome) {
    parts.push('("clinical trial" OR randomized OR randomised OR meta-analysis OR cohort OR "case-control")');
  }

  // Final assembly
  return parts.filter(Boolean).join(" AND ");
}
