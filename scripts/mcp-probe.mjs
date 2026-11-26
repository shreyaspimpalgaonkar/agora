import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
const server = new McpServer({ name: "agora-probe", version: "0.0.1" });
server.registerTool("board_post", {
  title: "Post to board",
  description: "Post a short message to the shared message board.",
  inputSchema: { message: z.string().describe("text to post") },
}, async ({ message }) => {
  fs.appendFileSync(process.env.PROBE_OUT || "/tmp/probe.txt", `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, id: 42 }) }] };
});
await server.connect(new StdioServerTransport());
