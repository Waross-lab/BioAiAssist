// src/openqa/answer_open_question.ts
import { planFromQuery } from "./planner.js";
import { runPlan } from "./runner.js";
import { renderAnswerCard } from "./normalize_and_report.js";
import type { McpToolMeta, McpClient, QueryPlan } from "./types.js";

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
    llmPlanner?: (q: string, toolsJson: any) => Promise<QueryPlan | null>,
    concurrency?: number,
  }
) {
  const plan = await planFromQuery(userQuery, discoverTools, llmPlanner);
  const results = await runPlan(plan, mcpClients, { concurrency });

  // NEW: rich card + keep legacy summary for compatibility
  const { card, legacy } = renderAnswerCard(userQuery, results);
  return { ...legacy, answerCard: card, plan };
}
