// src/adapters/encode.ts
// ENCODE Portal adapter (Node >=18 for global fetch).
// Fetches Experiments and returns the @graph array as raw rows.

export interface EncodeQuery {
  organism: string;          // e.g., "Homo sapiens"
  assay_titles?: string[];   // optional (e.g., ["ChIP-seq","ATAC-seq","RNA-seq"])
  status?: string;           // default "released"
  maxPerSource?: number;     // default 50 (hard-capped at 200)
}

export class EncodeAdapter {
  name = "ENCODE" as const;

  async query(args: EncodeQuery): Promise<any[]> {
    const status = args.status || "released";
    const limit = Math.max(1, Math.min(args.maxPerSource ?? 50, 200));

    const params = new URLSearchParams();
    params.set("type", "Experiment");
    params.set("status", status);
    params.set("format", "json");
    params.set("limit", String(limit));
    params.set("organism.scientific_name", args.organism); // organism gate

    if (args.assay_titles && args.assay_titles.length) {
      for (const a of args.assay_titles) params.append("assay_title", a);
    }

    const url = "https://www.encodeproject.org/search/?" + params.toString();
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new Error("ENCODE fetch failed: " + res.status + " " + res.statusText);
    }

    const data: any = await res.json();
    const graph = data && data["@graph"];
    return Array.isArray(graph) ? graph : [];
  }
}
