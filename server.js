#!/usr/bin/env node
/**
 * ATXP MCP Server — Agent Tool Library
 * 
 * Exposes ATXP's agent tools as MCP tools, monetized via x402:
 *   - atxp_web_search:       Search the web (FREE tier: 3 calls/day)
 *   - atxp_image_generate:   Generate images (PAID: $0.05–0.15/call)
 *   - atxp_email_send:       Send email from your ATXP address (PAID: $0.01/call)
 *   - atxp_email_inbox:      Check email inbox (PAID: $0.01/call)
 *   - atxp_music_generate:   Generate music from a prompt (PAID: $0.15/call)
 * 
 * Tiers:
 *   FREE  → /mcp/free   — 3 web_search calls/day
 *   PRO   → /mcp        — All 5 tools via xpay.sh paywall ($0.01–0.15/call)
 * 
 * Usage:
 *   node server.js           → stdio mode (Claude Desktop / Cursor)
 *   node server.js --http    → HTTP mode (remote, for xpay.sh proxy)
 * 
 * Powered by ATXP (https://atxp.dev) + x402 micropayments
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const VERSION = "1.0.0";
const ATXP_TOKEN = process.env.ATXP_CONNECTION_TOKEN || "5v8hSJiX5Bg5CuhBXeZpN";

// ─── ATXP CLI wrapper ─────────────────────────────────────────────────────────

async function runAtxp(args, timeoutMs = 30000) {
  const env = {
    ...process.env,
    ATXP_CONNECTION: `https://accounts.atxp.ai?connection_token=${ATXP_TOKEN}&account_id=atxp_acct_OjhZVwpYFSFklfQk2qw6u`,
  };
  
  const { stdout, stderr } = await execAsync(`npx atxp ${args}`, {
    env,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });
  
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// ─── Tool implementations ─────────────────────────────────────────────────────

async function webSearch(query, limit = 5) {
  const safeQuery = query.replace(/"/g, '\\"');
  const { stdout } = await runAtxp(`search "${safeQuery}"`);
  // stdout is the full text results from ATXP
  // Trim to reasonable size
  return stdout.slice(0, 8000);
}

async function imageGenerate(prompt, size = "512") {
  const safePrompt = prompt.replace(/"/g, '\\"');
  // ATXP image returns URL or base64
  const { stdout } = await runAtxp(`image "${safePrompt}"`, 60000);
  return stdout.slice(0, 2000);
}

async function emailSend(to, subject, body) {
  const safeTo = to.replace(/"/g, '\\"');
  const safeSubject = subject.replace(/"/g, '\\"');
  const safeBody = body.replace(/"/g, '\\"');
  const { stdout } = await runAtxp(
    `email send --to "${safeTo}" --subject "${safeSubject}" --body "${safeBody}"`
  );
  return stdout.slice(0, 1000);
}

async function emailInbox(limit = 10) {
  const { stdout } = await runAtxp(`email inbox`);
  return stdout.slice(0, 5000);
}

async function musicGenerate(prompt) {
  const safePrompt = prompt.replace(/"/g, '\\"');
  const { stdout } = await runAtxp(`music "${safePrompt}"`, 120000);
  return stdout.slice(0, 2000);
}

// ─── Create server factory ────────────────────────────────────────────────────

function createMcpServer(tier = "pro") {
  const isFree = tier === "free";
  
  const server = new McpServer({
    name: "atxp-agent-tools",
    version: VERSION,
    description: isFree
      ? "FREE tier — 3 web searches/day via ATXP agent infrastructure. Upgrade to PRO for image gen, email, music, and more. $0.01–0.15/call via xpay.sh (USDC, Base mainnet)."
      : "PRO tier — Full access to ATXP agent tools: web search, image generation, email (send/inbox), and music generation. All powered by ATXP infrastructure. $0.01–0.15/call via x402 micropayments.",
  });

  // ── Tool: atxp_web_search (available in both tiers) ──────────────────────
  server.tool(
    "atxp_web_search",
    "Search the web using ATXP's AI-powered search engine. Returns clean, structured results with titles, URLs, and snippets. " +
    "Great for researching topics, finding current information, checking facts, or discovering resources.",
    {
      query: z.string().describe("The search query to look up on the web."),
      limit: z.number().optional().default(5).describe("Number of results to return (1-10, default 5)."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ query, limit }) => {
      try {
        const results = await webSearch(query, limit || 5);
        return {
          content: [{ type: "text", text: results || "No results found." }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Search error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  if (!isFree) {
    // ── Tool: atxp_image_generate ──────────────────────────────────────────
    server.tool(
      "atxp_image_generate",
      "Generate an AI image from a text prompt using ATXP's image generation service. " +
      "Returns a URL or base64 data for the generated image. " +
      "Supports creative descriptions, photorealistic renders, artistic styles, and more. " +
      "Cost: $0.05–0.15/call depending on size.",
      {
        prompt: z.string().describe("Description of the image to generate. Be specific and descriptive for best results."),
        size: z.enum(["512", "1024", "1792"]).optional().default("512").describe("Image size: 512 (small, $0.05), 1024 (medium, $0.10), 1792 (large, $0.15)."),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async ({ prompt, size }) => {
        try {
          const result = await imageGenerate(prompt, size || "512");
          return {
            content: [{ type: "text", text: result || "Image generation completed." }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Image generation error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // ── Tool: atxp_email_send ──────────────────────────────────────────────
    server.tool(
      "atxp_email_send",
      "Send an email from your ATXP agent email address to any recipient. " +
      "Useful for sending automated notifications, reports, or messages on behalf of an AI agent. " +
      "Cost: $0.01/call.",
      {
        to: z.string().describe("Recipient email address (e.g. 'user@example.com')."),
        subject: z.string().describe("Email subject line."),
        body: z.string().describe("Email body text (plain text or HTML)."),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async ({ to, subject, body }) => {
        try {
          const result = await emailSend(to, subject, body);
          return {
            content: [{ type: "text", text: result || "Email sent successfully." }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Email send error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // ── Tool: atxp_email_inbox ─────────────────────────────────────────────
    server.tool(
      "atxp_email_inbox",
      "Check the inbox of your ATXP agent email address. " +
      "Returns a list of recent emails with senders, subjects, and dates. " +
      "Useful for AI agents that need to receive and process emails. " +
      "Cost: $0.01/call.",
      {
        limit: z.number().optional().default(10).describe("Number of emails to return (default 10)."),
      },
      { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async ({ limit }) => {
        try {
          const result = await emailInbox(limit || 10);
          return {
            content: [{ type: "text", text: result || "Inbox is empty." }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Email inbox error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );

    // ── Tool: atxp_music_generate ──────────────────────────────────────────
    server.tool(
      "atxp_music_generate",
      "Generate an AI music track from a text prompt using ATXP's music generation service. " +
      "Returns a URL to the generated audio file. " +
      "Describe genre, mood, tempo, instruments, or specific style for best results. " +
      "Cost: $0.15/call.",
      {
        prompt: z.string().describe("Description of the music to generate (e.g. 'upbeat electronic track with synth and bass')."),
        lyrics: z.string().optional().describe("Optional lyrics to include in the music."),
      },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async ({ prompt, lyrics }) => {
        try {
          const fullPrompt = lyrics
            ? `${prompt} [lyrics: ${lyrics}]`
            : prompt;
          const result = await musicGenerate(fullPrompt);
          return {
            content: [{ type: "text", text: result || "Music generation completed." }],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Music generation error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );
  } // end !isFree

  // ── Upgrade prompt for free tier ──────────────────────────────────────────
  if (isFree) {
    server.tool(
      "atxp_upgrade_info",
      "Get information about upgrading to the PRO tier for full ATXP tool access.",
      {},
      { readOnlyHint: true },
      async () => ({
        content: [{
          type: "text",
          text: [
            "🔓 ATXP MCP Pro Tier",
            "────────────────────",
            "Unlock all 5 ATXP agent tools:",
            "",
            "  • atxp_web_search     — unlimited searches ($0.01/call)",
            "  • atxp_image_generate — AI images 512–1792px ($0.05–0.15/call)",
            "  • atxp_email_send     — send email from agent address ($0.01/call)",
            "  • atxp_email_inbox    — check agent email inbox ($0.01/call)",
            "  • atxp_music_generate — generate music tracks ($0.15/call)",
            "",
            "Pay-per-use with USDC on Base mainnet via x402.",
            "No subscription, no API key, no account needed.",
            "",
            "PRO endpoint: https://paywall.xpay.sh/atxp-mcp",
            "Powered by ATXP (https://atxp.dev)",
          ].join("\n"),
        }],
      })
    );
  }

  return server;
}

// ─── HTTP Mode ────────────────────────────────────────────────────────────────

function startHttpServer() {
  const app = express();
  app.use(express.json());

  // In-memory session store
  const sessions = new Map();

  function makeHandler(tier) {
    return async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] || randomUUID();

      if (req.method === "DELETE") {
        sessions.delete(sessionId);
        res.status(200).json({ deleted: true });
        return;
      }

      let transport = sessions.get(sessionId);
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          },
        });
        transport.onclose = () => sessions.delete(sessionId);
        const server = createMcpServer(tier);
        await server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    };
  }

  // PRO endpoint (xpay.sh proxies here, adds x402 payment gate)
  app.post("/mcp", makeHandler("pro"));
  app.get("/mcp", makeHandler("pro"));
  app.delete("/mcp", makeHandler("pro"));

  // FREE endpoint (direct access, 3 searches/day)
  app.post("/mcp/free", makeHandler("free"));
  app.get("/mcp/free", makeHandler("free"));
  app.delete("/mcp/free", makeHandler("free"));

  // Health check
  app.get("/health", (req, res) => {
    res.json({
      status: "ok",
      version: VERSION,
      service: "atxp-mcp",
      tiers: { free: "/mcp/free", pro: "/mcp (via xpay.sh)" },
      tools: {
        free: ["atxp_web_search (3/day)", "atxp_upgrade_info"],
        pro: ["atxp_web_search", "atxp_image_generate", "atxp_email_send", "atxp_email_inbox", "atxp_music_generate"],
      },
    });
  });

  // Root info
  app.get("/", (req, res) => {
    res.json({
      name: "ATXP MCP Server",
      version: VERSION,
      description: "Access 5+ ATXP agent tools (web search, image gen, email, music) via MCP + x402",
      endpoints: {
        free: "/mcp/free (3 web searches/day)",
        pro: "/mcp (all tools, $0.01–0.15/call, via xpay.sh paywall)",
        health: "/health",
      },
      usage: {
        mcp_client: "Configure with endpoint: https://atxp-mcp-production.up.railway.app/mcp/free",
        xpay_proxy: "https://paywall.xpay.sh/atxp-mcp",
      },
      powered_by: "ATXP (https://atxp.dev) + x402 micropayments",
    });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    process.stderr.write(`ATXP MCP Server v${VERSION} running on port ${PORT}\n`);
    process.stderr.write(`  FREE:  http://localhost:${PORT}/mcp/free\n`);
    process.stderr.write(`  PRO:   http://localhost:${PORT}/mcp\n`);
    process.stderr.write(`  Health: http://localhost:${PORT}/health\n`);
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const isHttp = process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http";

if (isHttp) {
  startHttpServer();
} else {
  // stdio mode
  const server = createMcpServer("pro");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
