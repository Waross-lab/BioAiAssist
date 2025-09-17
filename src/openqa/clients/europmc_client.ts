// src/openqa/clients/europmc_client.ts
import type { McpClient } from "../types.js";

// Minimal Europe PMC client that conforms to the McpClient shape used by the runner.
// Tool: search_publications(query, size?, yearFrom?, yearTo?)
export function makeEuropePmcClient(): McpClient {
  return {
    async listTools() {
      return [{
        name: "search_publications",
        description: "Europe PMC search over biomedical literature; returns title/abstract/IDs."
      }];
    },

    async callTool(name: string, args: any) {
      if (name !== "search_publications") {
        throw new Error(`europmc: unknown tool '${name}'`);
      }
      const query: string = args?.query || "";
      const size: number = Math.min(Math.max(parseInt(args?.size ?? "25", 10) || 25, 1), 100);
      const yearFrom: string | undefined = args?.yearFrom;
      const yearTo: string | undefined = args?.yearTo;

      const filters: string[] = [];            // <— type it
       if (yearFrom) filters.push(`FIRST_PDATE:[${yearFrom}-01-01 TO *]`);
       if (yearTo)   filters.push(`FIRST_PDATE:[* TO ${yearTo}-12-31]`);
      const q = [query, ...filters].filter(Boolean).join(" AND ");

      const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
      url.searchParams.set("query", q);
      url.searchParams.set("format", "json");
      url.searchParams.set("resultType", "core");
      url.searchParams.set("pageSize", String(size));

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`europmc http ${res.status}`);
      const json: any = await res.json();

      const results = (json?.resultList?.result ?? []).map((r: any) => ({
        id: r?.id ?? r?.pmid ?? r?.pmcid ?? r?.doi ?? null,
        pmid: r?.pmid ?? null,
        pmcid: r?.pmcid ?? null,
        doi: r?.doi ?? null,
        title: r?.title ?? "",
        journal: r?.journalInfo?.journal?.title ?? "",
        pubYear: r?.pubYear ?? null,
        authorString: r?.authorString ?? "",
        abstractText: r?.abstractText ?? "",
        source: r?.source ?? "",
      }));

      return { count: results.length, results };
    }
  };
}
