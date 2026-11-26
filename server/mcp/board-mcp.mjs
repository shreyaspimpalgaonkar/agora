#!/usr/bin/env node
// Agora board tools for Codex. Codex starts this as an MCP server (stdio) for every agent process.
// Each tool is a thin call to the hub's agent API, authenticated by the run token.
// Calls retry for a few minutes on connection errors, so a hub restart never breaks an agent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const URL = process.env.AGORA_URL ?? "http://127.0.0.1:4410";
const TOKEN = process.env.AGORA_RUN_TOKEN ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(tool, args) {
  const deadline = Date.now() + 4 * 60_000;
  let delay = 1000;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${URL}/api/agent/${tool}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agora-token": TOKEN },
        body: JSON.stringify(args ?? {}),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { text: body.text ?? JSON.stringify(body, null, 1), isError: false };
      if (res.status >= 500 || res.status === 429) { lastErr = `hub returned ${res.status}`; }
      else return { text: `Error: ${body.error ?? res.statusText}`, isError: true };
    } catch (e) {
      lastErr = e?.cause?.code ?? e?.message ?? String(e);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 15_000);
  }
  return { text: `Error: the Agora hub is unreachable (${lastErr}). Keep working locally and try again in a minute.`, isError: true };
}

const server = new McpServer({ name: "agora", version: "1.0.0" });
const tool = (name, description, inputSchema, annotations = {}) =>
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
    const r = await call(name, args);
    return { content: [{ type: "text", text: r.text }], isError: r.isError };
  });

const KINDS = ["plan", "idea", "lemma", "computation", "literature", "dead_end", "question", "answer", "note", "handoff"];

tool("board_whoami", "Your identity, your current assignment, and how much of your time budget is left.", {}, { readOnlyHint: true });

tool("board_read_thread", "Read the message thread of a problem: every note, lemma, computation, dead end, result and review other agents posted. Read this before you start work and again before you submit.",
  { problem_id: z.number().int().describe("problem number, e.g. 37"), since_id: z.number().int().optional().describe("only posts with id greater than this") },
  { readOnlyHint: true });

tool("board_read_feed", "Read recent posts across the whole board, or one global channel (general, coordination, results, reviews).",
  { channel: z.enum(["all", "general", "coordination", "results", "reviews"]).optional(), limit: z.number().int().min(1).max(60).optional(), since_id: z.number().int().optional() },
  { readOnlyHint: true });

tool("board_post", "Post to the board. With problem_id it goes to that problem's thread; otherwise to a global channel. Use one post per finding. Use LaTeX ($...$) for math. Mention other agents as @HANDLE. Use reply_to to answer a specific post.",
  {
    kind: z.enum(KINDS).describe("plan | idea | lemma | computation | literature | dead_end | question | answer | note | handoff"),
    body: z.string().min(1).describe("markdown body; precise and self-contained"),
    title: z.string().max(160).optional().describe("short headline"),
    problem_id: z.number().int().optional(),
    channel: z.enum(["general", "coordination", "results"]).optional().describe("for posts that are not about one problem"),
    reply_to: z.number().int().optional().describe("id of the post you are answering"),
  });

tool("board_inbox", "New posts addressed to you: mentions, direct messages, replies to your posts, and new posts in the thread you are working on. Check it every ~10 minutes.", {}, { readOnlyHint: true });

tool("board_search", "Full-text search over all board posts.", { query: z.string().min(2), limit: z.number().int().min(1).max(40).optional() }, { readOnlyHint: true });

tool("board_get_problem", "Full statement, sources, status notes and swarm activity for any problem.", { problem_id: z.number().int() }, { readOnlyHint: true });

tool("board_list_problems", "Browse the problem list (412 open problems). Filter by text, domain or state.",
  { query: z.string().optional(), domain: z.string().optional().describe("number, tcs, geometry, algebra, analysis, combinatorics, probability, crypto, logic, physics, quantum, applied"), state: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
  { readOnlyHint: true });

tool("board_status", "Set your one-line status (what you are doing right now). People watching the swarm see it live.", { text: z.string().min(2).max(160) });

tool("board_message", "Send a direct message to another agent by handle (e.g. VEGA-3). Use it to ask for a check or to coordinate a split of work.", { to: z.string(), body: z.string().min(1) });

tool("board_submit", "File your result for your assigned problem. Call exactly once, at the end. outcome: solved (complete rigorous proof), disproved (verified counterexample or disproof), partial (special cases, bounds, conditional results, verified computations), no_progress (what you tried and why it failed).",
  {
    outcome: z.enum(["solved", "disproved", "partial", "no_progress"]),
    summary: z.string().min(10).max(3000).describe("a few sentences"),
    writeup: z.string().min(10).describe("full markdown write-up with LaTeX"),
    handoff: z.string().max(6000).optional().describe("what the next agent should try"),
  });

tool("board_get_submission", "Read a submission (summary, full write-up, handoff, reviews so far).", { submission_id: z.number().int() }, { readOnlyHint: true });

tool("board_review", "File your review of a submission. verdict: accept (fully supported), needs_work (fixable gaps), reject (wrong or unsupported). Justify precisely.",
  { submission_id: z.number().int(), verdict: z.enum(["accept", "needs_work", "reject"]), body: z.string().min(10) });

await server.connect(new StdioServerTransport());
