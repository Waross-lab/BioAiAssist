import type { QueryPlan, ToolCall, McpClient } from "./types.js";

type RunOpts = { concurrency?: number; timeoutMs?: number };
export type ToolResult = { call: ToolCall; ok: boolean; data?: any; error?: string; elapsedMs: number };

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    const DEFAULT_TIMEOUT_MS = Number(process.env.BIOAI_TOOL_TIMEOUT_MS ?? 45000); // was 20000
  });
}

async function mapWithConcurrency<I, O>(
  items: I[],
  limit: number,
  fn: (item: I) => Promise<O>
): Promise<O[]> {
  const q = [...items];
  const results: O[] = [];
  let inFlight = 0;

  return new Promise((resolve, reject) => {
    const next = () => {
      if (!q.length && inFlight === 0) return resolve(results);
      while (inFlight < limit && q.length) {
        const item = q.shift()!;
        inFlight++;
        fn(item).then(r => {
          results.push(r);
          inFlight--;
          next();
        }, reject);
      }
    };
    next();
  });
}

export async function runPlan(
  plan: QueryPlan,
  clients: Record<string, McpClient>,
  { concurrency = 4, timeoutMs = 20_000 }: RunOpts = {}
) {
  return mapWithConcurrency(plan.calls, concurrency, async (call) => {
    const t0 = Date.now();
    try {
      const client = clients[call.server];
      if (!client) throw new Error(`No MCP client for server: ${call.server}`);
      const data = await withTimeout(
        client.callTool(call.tool, call.args, { timeoutMs }),
        timeoutMs,
        `Tool timeout: ${call.server}.${call.tool}`
      );
      return { call, ok: true, data, elapsedMs: Date.now() - t0 };
    } catch (err: any) {
      return { call, ok: false, error: String(err?.message ?? err), elapsedMs: Date.now() - t0 };
    }
  });
}

