import { planFromQuery } from "./planner.js";
import { runPlan } from "./runner.js";
import { renderAnswer } from "./normalize_and_report.js";
import type { McpToolMeta, McpClient } from "./types.js";

export async function answerOpenQuestion(
  userQuery: string,
  {
    discoverTools,
    mcpClients,
    llmPlanner,
    concurrency = 4,
  }: {
    discoverTools: () => Promise<McpToolMeta[]>,
    mcpClients: Record<string, McpClient>,
    llmPlanner?: (q: string, toolsJson: any) => Promise<{ rationale: string; calls: any[] } | null>,
    concurrency?: number,
  }
) {
  const plan = await planFromQuery(userQuery, discoverTools, llmPlanner);
  const results = await runPlan(plan, mcpClients, { concurrency });
  return renderAnswer(userQuery, results);
}
