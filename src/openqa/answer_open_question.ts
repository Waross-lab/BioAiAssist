// src/openqa/answer_open_question.ts
import { planFromQuery } from "./planner.js";
import { renderAnswer } from "./normalize_and_report.js";
import { runPlan as _runPlan } from "./runner.js";

/** Try to get a default clients map from runner.js; otherwise fall back to HTTP client. */
async function getClientsForRunner(): Promise<any> {
  const mod: any = await import("./runner.js");

  // Prefer built-in helpers if your runner exports them
  const factoryNames = [
    "makeDefaultClients",
    "defaultClients",
    "getDefaultClients",
    "createDefaultClients",
    "connectDefaultClients"
  ];
  for (const name of factoryNames) {
    if (typeof mod[name] === "function") {
      try {
        const clients = await mod[name]();
        if (clients) return clients;
      } catch {
        // fall through to next option
      }
    }
  }

  // Fallback: HTTP MCP endpoint (single endpoint serving multiple "server" names)
  const base = process.env.BIOAI_MCP_HTTP || "http://localhost:8788/mcp";

  async function httpCall(server: string, tool: string, args: any) {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server, tool, args })
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    // Expecting the tool handler to return JSON { rows } / { result } etc.
    return await res.json();
  }

  // Proxy returns a per-server client object that exposes .call(tool, args)
  return new Proxy({}, {
    get: (_target, serverKey: string) => ({
      call: (tool: string, args: any) => httpCall(serverKey, tool, args)
    })
  });
}

/**
 * Answer an open question by planning tool calls, executing them, normalizing,
 * and building an Answer Card suitable for HTML/PDF rendering.
 */
export async function answerOpenQuestion(userQuery: string) {
  // 1) Plan
  const plan = await planFromQuery(userQuery);

  // 2) Clients + run
  const clients: any = await getClientsForRunner();
  const run = await _runPlan(plan, clients) as any;

  // 3) Normalize the runner output shape
  const resultsArr: any[] = Array.isArray(run)
    ? run
    : Array.isArray(run?.results)
    ? run.results
    : [];

  // 4) Render (normalize + extract metrics + build AnswerCard)
  const rendered = renderAnswer(
    userQuery,
    resultsArr.map((r: any) => ({
      call: r.call,
      data: r.data,                        // may be undefined on failures (OK)
      ok: !!r.ok,
      ms: r.ms ?? r.elapsedMs ?? 0,
      elapsedMs: r.elapsedMs,
      error: r.error,
    }))
  );

  // 5) Small summary for console/smoke output
  const okCount = resultsArr.filter((r: any) => r.ok).length;
  const fail    = resultsArr.filter((r: any) => !r.ok);
  const summary = `Collected ${okCount} tool results; ${fail.length} failed.`;

  return {
    query: userQuery,
    hits: okCount,
    failures: fail.map((r: any) => r.error).filter(Boolean),
    summary,
    records: resultsArr,         // raw tool runs for debugging
    answerCard: rendered.answerCard,  // <-- used by smoke_openqa.mjs for HTML/PDF
    plan,
  };
}
