// src/openqa/extractors/text_metrics.ts

export interface MetricCutoff {
  value: number;
  units: "%" | string;
  context?: string;
}

export interface MetricHR {
  endpoint?: string; // OS/PFS/unknown
  value: number;
  ci?: string;       // 95% CI text if present
}

export interface MetricMedian {
  endpoint: "OS" | "PFS" | "unknown";
  value: number;
  units: "months" | "weeks" | "days";
}

export interface ExtractedMetrics {
  cutoffs: MetricCutoff[];
  hr: MetricHR[];
  medians: MetricMedian[];
}

/** Normalize common time units to a small set */
function normUnit(u: string): "months" | "weeks" | "days" {
  const s = (u || "").toLowerCase();
  if (s.startsWith("w")) return "weeks";
  if (s.startsWith("d")) return "days";
  return "months";
}

/** Extract numbers from publication title/abstract text with strict context */
export function extractMetrics(text: string): ExtractedMetrics {
  const T = String(text || " ");

  const cutoffs: MetricCutoff[] = [];
  const hr: MetricHR[] = [];
  const medians: MetricMedian[] = [];

  // --- Regexes (context-aware) ---

  // Cutoff % must be near cutoff/threshold/methylation words
  const CUTOFF_PCT_RE =
    /(\d{1,3}(?:\.\d+)?)\s?%\s*(?:cut[-\s]?off|threshold|methyl(?:ation)?(?:\s+cut[-\s]?off)?)/gi;

  // Hazard ratio with optional 95% CI
  const HR_RE =
    /\b(?:hazard\s*ratio|HR)\s*(?:=|:)?\s*(\d+(?:\.\d+)?)(?:\s*\(\s*(?:95%\s*CI|CI\s*95%)\s*([^)]*)\))?/gi;

  // Median OS/PFS (months) — short proximity window to units
  const MED_OS_RE =
    /\b(?:median\s+)?overall\s+survival[^0-9]{0,20}(\d+(?:\.\d+)?)\s*(months?|mo|m|weeks?|w|days?|d)\b/gi;
  const MED_PFS_RE =
    /\b(?:median\s+)?progression[-\s]?free\s+survival[^0-9]{0,20}(\d+(?:\.\d+)?)\s*(months?|mo|m|weeks?|w|days?|d)\b/gi;

  // Fallback ratios (sometimes abstracts say OR/RR instead of HR)
  const OR_RE = /\b(?:odds\s*ratio|OR)\s*(?:=|:)?\s*(\d+(?:\.\d+)?)(?:\s*\(\s*(?:95%\s*CI|CI\s*95%)\s*[^)]*\))?/gi;
  const RR_RE = /\b(?:(?:risk\s*ratio|relative\s*risk)|RR)\s*(?:=|:)?\s*(\d+(?:\.\d+)?)(?:\s*\(\s*(?:95%\s*CI|CI\s*95%)\s*[^)]*\))?/gi;

  // --- Extraction loops ---
  let m: RegExpExecArray | null;

  // Cutoff %
  while ((m = CUTOFF_PCT_RE.exec(T)) !== null) {
    cutoffs.push({ value: parseFloat(m[1]), units: "%", context: "cutoff/threshold" });
  }

  // HR
  while ((m = HR_RE.exec(T)) !== null) {
    const ci = m[2]?.trim();
    hr.push({ endpoint: "OS_or_PFS", value: parseFloat(m[1]), ci });
  }

  // Median OS
  while ((m = MED_OS_RE.exec(T)) !== null) {
    medians.push({ endpoint: "OS", value: parseFloat(m[1]), units: normUnit(m[2]) });
  }

  // Median PFS
  while ((m = MED_PFS_RE.exec(T)) !== null) {
    medians.push({ endpoint: "PFS", value: parseFloat(m[1]), units: normUnit(m[2]) });
  }

  // Fallback OR/RR → treat as generic effect size if no HR found
  if (hr.length === 0) {
    while ((m = OR_RE.exec(T)) !== null) {
      hr.push({ endpoint: "unknown", value: parseFloat(m[1]) });
    }
    while ((m = RR_RE.exec(T)) !== null) {
      hr.push({ endpoint: "unknown", value: parseFloat(m[1]) });
    }
  }

  return { cutoffs, hr, medians };
}

