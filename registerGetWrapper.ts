/*
 * registerGetWrapper.ts
 *
 * This helper module adds an improved REST-style GET wrapper to your
 * MCP server.  It attaches a route for `/mcp/:toolName` that accepts
 * query parameters, performs robust type coercion (numbers, booleans,
 * arrays via comma-separated values or `[]` suffixes), validates the
 * input against the tool's Zod schema, and returns JSON responses.
 *
 * Usage:
 *   import { registerGetWrapper } from './registerGetWrapper.js';
 *   // after defining your Express app and tools array:
 *   registerGetWrapper(app, tools);
 *
 *   // Start your server as usual.  You can then call tools via GET, e.g.:
 *   // http://localhost:8788/mcp/uniprot.search?query=TP53&size=5
 */

import { Request, Response, Express } from 'express';
import { z } from 'zod';

export type Tool = {
  name: string;
  description: string;
  inputSchema?: z.Schema<any>;
  handler: (args: any) => Promise<any>;
};

// Coerce query parameter values into numbers, booleans, arrays, or strings.
// Handles comma-separated values and keys ending with [] as arrays.
function coerceValue(value: any): any {
  if (Array.isArray(value)) {
    return value.map(coerceValue);
  }
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  // If comma-separated, return array of coerced values
  if (trimmed.includes(',')) {
    return trimmed.split(',').map(v => coerceValue(v));
  }
  // numeric string
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  // boolean string
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;
  return trimmed;
}

// Parse Express req.query into an argument object with type coercion
function parseQuery(query: any): any {
  const result: Record<string, any> = {};
  for (const key in query) {
    if (!Object.prototype.hasOwnProperty.call(query, key)) continue;
    const value = query[key];
    // Handle keys ending with [] as arrays
    if (key.endsWith('[]')) {
      const cleanKey = key.slice(0, -2);
      result[cleanKey] = coerceValue(value);
    } else {
      result[key] = coerceValue(value);
    }
  }
  return result;
}

/**
 * Register a GET route on the Express app to call MCP tools by name.
 *
 * @param app The Express application instance
 * @param tools The array of tool definitions used by the MCP server
 */
export function registerGetWrapper(app: Express, tools: Tool[]): void {
  app.get('/mcp/:toolName', async (req: Request, res: Response) => {
    const { toolName } = req.params;
    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      return res.status(404).json({ error: `Unknown tool: ${toolName}` });
    }
    try {
      const rawArgs = parseQuery(req.query);
      // Validate arguments against the tool's input schema, if present
      const args = tool.inputSchema ? tool.inputSchema.parse(rawArgs) : rawArgs;
      const result = await tool.handler(args);
      return res.json(result);
    } catch (e: unknown) {
      // Provide helpful error messages
      let message: string;
      if (e instanceof z.ZodError) {
        // ZodError has an `issues` array describing all validation failures
        message = e.issues.map((issue: any) => issue.message).join('; ');
      } else if (typeof e === 'object' && e && 'message' in e) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        message = (e as any).message as string;
      } else {
        message = 'Invalid input';
      }
      return res.status(400).json({ error: message });
    }
  });
}