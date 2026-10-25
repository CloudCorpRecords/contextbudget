/**
 * contextbudget MCP server. Tool: budget_path.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCheck, VERSION } from "./core.js";

const server = new McpServer({ name: "contextbudget", version: VERSION });

server.tool(
  "budget_path",
  "Estimate the token cost of a directory tree for an agent context window. Returns per-file and per-directory estimates using a deterministic character-based estimator (stated as an estimate, never an exact tokenizer count), the largest files, totals against a default 200k budget, and which subtrees to exclude. Verdict WITHIN-BUDGET or OVER-BUDGET.",
  {
    path: z.string().describe("Target path to check"),
  },
  async ({ path }) => {
    const report = runCheck(path);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
