// src/openqa/types.ts

export type McpClient = {
  listTools: () => Promise<Array<{ name: string; description?: string }>>;
  callTool: (name: string, args: any, opts?: { timeoutMs?: number }) => Promise<any>;
};

export type McpToolMeta = {
  server: string;
  name: string;
  description?: string;
};

export type ToolCall = {
  server: string;
  tool: string;
  args: Record<string, any>;
  parallelGroup?: string;
};

export type QueryPlan = {
  rationale: string;
  calls: ToolCall[];
};
