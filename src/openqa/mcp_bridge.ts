// src/openqa/mcp_bridge.ts
import type { McpClient, McpToolMeta } from "./types.js";

type BioMcpExports = {
  startAll?: () => Promise<string[]>;
  connectAll?: () => Promise<string[]>;
  getClientFor?: (name: string) => Promise<McpClient> | McpClient;
};

// Try multiple relative locations depending on your outDir structure
async function loadBioMcp(): Promise<BioMcpExports | null> {
  const candidates = [
    // when this file is dist/src/openqa/mcp_bridge.js and bio-mcp is dist/bio-mcp.js
    "../../bio-mcp.js",
    // when this file is dist/openqa/mcp_bridge.js and bio-mcp is dist/bio-mcp.js
    "../bio-mcp.js",
    // rare: if bio-mcp ended up under dist/src (not typical)
    "../../src/bio-mcp.js",
  ];

  for (const rel of candidates) {
    try {
      const url = new URL(rel, import.meta.url).href;
      const mod = await import(url); // dynamic: TS won't try to resolve at build time
      return mod as any;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function makeMcpClients(): Promise<Record<string, McpClient>> {
  const mod = await loadBioMcp();
  if (!mod) {
    throw new Error(
      "mcp_bridge: couldn't locate compiled bio-mcp.js. " +
      "Check that bio-mcp.ts compiles to dist/bio-mcp.js and your tsconfig include '*.ts' at repo root."
    );
  }

  const startAll = mod.startAll ?? mod.connectAll;
  const getClientFor = mod.getClientFor;

  if (!startAll || !getClientFor) {
    throw new Error(
      "mcp_bridge: bio-mcp.js must export startAll() (or connectAll()) and getClientFor(name)."
    );
  }

  const servers: string[] = await startAll(); // e.g., ["uniprot","reactome","ctgov"]
  const out: Record<string, McpClient> = {};

  for (const name of servers) {
    const raw = await getClientFor(name);
    if (!raw?.listTools || !raw?.callTool) {
      throw new Error(`mcp_bridge: server '${name}' missing listTools/callTool`);
    }
    out[name] = {
      listTools: raw.listTools.bind(raw),
      callTool: raw.callTool.bind(raw),
    };
  }
  return out;
}

export async function discoverAllTools(clients: Record<string, McpClient>): Promise<McpToolMeta[]> {
  const out: McpToolMeta[] = [];
  for (const [server, client] of Object.entries(clients)) {
    const tools = await client.listTools();
    for (const t of tools) {
      out.push({ server, name: t.name, description: t.description });
    }
  }
  return out;
}

