import type { Slots } from "../schemas.js";

const DRUG_ALIASES: Record<string, string[]> = {
  temozolomide: ["temodar","tmz"],
  temodar: ["temozolomide","tmz"],
  tmz: ["temozolomide","temodar"],
  sotorasib: ["lumakras","amg 510","amg510"],
  adagrasib: ["krazati","mrtx849","mrtx-849"],
};

const DISEASE_SYNS = ["glioblastoma", "glioblastoma multiforme", "GBM"];

function expand(terms: string[]) {
  const out = new Set<string>();
  for (const t of terms || []) {
    out.add(t);
    const a = DRUG_ALIASES[t.toLowerCase()];
    if (a) a.forEach(x => out.add(x));
  }
  return Array.from(out);
}

function orQuoted(xs: string[]) {
  return xs.filter(Boolean).map(x => `"${x}"`).join(" OR ");
}

export function buildCtgovExpr(slots: Slots, rawQ: string): string {
  const cond = slots.diseases?.length ? slots.diseases : DISEASE_SYNS;
  const drugs = slots.drugs?.length ? expand(slots.drugs) : [];

  const parts: string[] = [];

  // Fielded condition (fallback to GBM synonyms if slots were empty)
  parts.push(`(AREA[ConditionSearch] (${orQuoted(cond)}))`);

  // Fielded intervention if we have drugs
  if (drugs.length) {
    parts.push(`(AREA[InterventionName] (${orQuoted(drugs)}))`);
  }

  // Always nudge toward interventional trials
  parts.push('("clinical trial" OR randomized OR phase)');

  return parts.join(" AND ");
}

