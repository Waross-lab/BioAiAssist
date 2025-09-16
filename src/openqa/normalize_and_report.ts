import type { ToolResult } from "./runner.js";

export function normalize(results: ToolResult[]) {
  return results.map(r => ({
    kind: "tool_result",
    server: r.call.server,
    tool: r.call.tool,
    canonical: r.data, // placeholder until wired into stage2_normalization
  }));
}

export function renderAnswer(query: string, results: ToolResult[]) {
  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  return {
    query,
    hits: ok.length,
    failures: failed.map(f => ({ server: f.call.server, tool: f.call.tool, error: f.error })),
    summary: `Collected ${ok.length} tool results; ${failed.length} failed.`,
    records: normalize(ok),
  };
}
