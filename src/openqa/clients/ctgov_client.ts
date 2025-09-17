// src/openqa/clients/ctgov_client.ts
// Uses the public Study Fields API: https://clinicaltrials.gov/api
// Node 18+ has global fetch; no dependency needed.

export interface CtgovSearchArgs {
  expr: string;              // boolean expression, e.g. ("glioblastoma") AND ("temozolomide" OR "temodar" OR "tmz")
  status?: string[];         // ["RECRUITING", "NOT_YET_RECRUITING", "ACTIVE_NOT_RECRUITING"]
  minRank?: number;          // 1-based start (default 1)
  maxRank?: number;          // end rank (default 100)
  fields?: string[];         // field list
}

export async function searchTrialsCtgov(args: CtgovSearchArgs) {
  const {
    expr,
    status = [],
    minRank = 1,
    maxRank = 100,
    fields = [
      "NCTId","BriefTitle","OverallStatus","Phase",
      "Condition","InterventionName","StudyType",
      "StartDate","PrimaryCompletionDate","CompletionDate",
      "LocationCountry","LocationCity","LeadSponsorName","StudyResults",
      "EnrollmentCount"
    ],
  } = args;

  const url = new URL("https://clinicaltrials.gov/api/query/study_fields");
  url.searchParams.set("expr", buildExpr(expr, status));
  url.searchParams.set("fields", fields.join(","));
  url.searchParams.set("min_rnk", String(minRank));
  url.searchParams.set("max_rnk", String(maxRank));
  url.searchParams.set("fmt", "json");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`ctgov HTTP ${res.status}`);
  const json = await res.json();
  return (json?.StudyFieldsResponse?.StudyFields || []) as any[];
}

function buildExpr(expr: string, status: string[]) {
  if (!status.length) return expr;
  // Example: (glioblastoma AND temozolomide) AND (AREA[OverallStatus] RECRUITING OR AREA[OverallStatus] ACTIVE_NOT_RECRUITING)
  const statusQ = status.map(s => `AREA[OverallStatus] ${s}`).join(" OR ");
  return `(${expr}) AND (${statusQ})`;
}
