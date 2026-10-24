#!/usr/bin/env node
// claude-local-api v3 — resident-session facade over the official Claude Agent SDK.
//
// Architecture: one resident CLI worker per conversation (the SDK's open-input
// mode: a single query() whose prompt is a long-lived async iterable). The
// per-request process lifecycle cost (spawn + module load + handshake + session
// replay + scaffolding) is paid ONCE per conversation, not per request — each
// request after the first costs only network + inference, same as direct use.
//
//   POST /v1/messages            (stream: true → SSE, else JSON)
//   GET  /v1/models | /health
//
// Conversation key: x-claude-session-id → x-claude-code-session-id → first-msg
// fingerprint. Tool calls block the in-process handler until the caller's next
// request delivers the tool_result — no abort/resume dance, chains correctly
// across autonomous multi-round tool use. Affinity persists via SQLite.

import http from "node:http";
import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

const PORT = parseInt(process.env.PORT || "8466", 10);
const HOST = process.env.HOST || "127.0.0.1";
const API_KEY = process.env.CLAUDE_LOCAL_API_KEY || "";
const CWD = path.resolve(process.env.CLAUDE_LOCAL_CWD || "./sandbox");
const TOOLS_ON = process.env.CLAUDE_LOCAL_TOOLS === "1";
const PERMISSION_MODE = process.env.CLAUDE_LOCAL_PERMISSION_MODE || "default";
const TIMEOUT_MS = parseInt(process.env.CLAUDE_LOCAL_TIMEOUT_MS || "300000", 10);
const MAX_CONCURRENCY = parseInt(process.env.CLAUDE_LOCAL_MAX_CONCURRENCY || "4", 10);
const WORKER_IDLE_MS = parseInt(process.env.CLAUDE_LOCAL_WORKER_IDLE_MS || "3600000", 10);
const WORKER_MAX = parseInt(process.env.CLAUDE_LOCAL_WORKER_MAX || "16", 10);

await mkdir(CWD, { recursive: true });

// ---------- global request semaphore ----------
let active = 0;
const waiters = [];
const acquire = () => (active < MAX_CONCURRENCY ? Promise.resolve(++active) : new Promise((r) => waiters.push(() => r(++active))));
const release = () => { active--; waiters.shift()?.(); };

const readBody = (req, limit = 20 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) return reject(Object.assign(new Error("request too large"), { status: 413 })); chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

// ---------- JSON Schema -> Zod raw shape (common subset) ----------
function propToZod(schema) {
  if (!schema || typeof schema !== "object") return z.unknown();
  let out;
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (schema.enum) out = z.enum(schema.enum);
  else if (t === "string") out = z.string();
  else if (t === "number") out = z.number();
  else if (t === "integer") out = z.number().int();
  else if (t === "boolean") out = z.boolean();
  else if (t === "array") out = z.array(propToZod(schema.items));
  else if (t === "object" || schema.properties) {
    const shape = {};
    for (const [k, v] of Object.entries(schema.properties || {})) shape[k] = propToZod(v);
    out = z.object(shape);
  } else out = z.unknown();
  if (schema.description) out = out.describe(schema.description);
  return out;
}
function jsonSchemaToZodShape(jsonSchema) {
  const shape = {};
  const required = new Set(jsonSchema?.required || []);
  for (const [k, v] of Object.entries(jsonSchema?.properties || {})) {
    const zod = propToZod(v);
    shape[k] = required.has(k) ? zod : zod.optional();
  }
  return shape;
}

// ---------- affinity persistence (SQLite write-through) ----------
const msgSig = (m) => JSON.stringify(m);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const DB_PATH = process.env.CLAUDE_LOCAL_AFFINITY_DB || path.join(path.dirname(fileURLToPath(import.meta.url)), "affinity.db");
const affinity = new Map(); // key -> { history, systemHash, toolsSig, modelSig, sampleSig, at }
let db = null;
try {
  db = new DatabaseSync(DB_PATH);
  db.exec("CREATE TABLE IF NOT EXISTS affinity (key TEXT PRIMARY KEY, history TEXT NOT NULL, systemHash TEXT NOT NULL, toolsSig TEXT NOT NULL, modelSig TEXT NOT NULL, sampleSig TEXT NOT NULL, at INTEGER NOT NULL)");
  for (const row of db.prepare("SELECT * FROM affinity").all())
    affinity.set(row.key, { history: JSON.parse(row.history), systemHash: row.systemHash, toolsSig: row.toolsSig, modelSig: row.modelSig, sampleSig: row.sampleSig, at: row.at });
  console.log(`[affinity] hydrated ${affinity.size} conversation(s)`);
} catch (e) { console.log(`[affinity] persistence disabled: ${String(e.message).slice(0, 80)}`); }
const saveAffinity = (key, v) => { affinity.set(key, v); if (db) try { db.prepare("INSERT OR REPLACE INTO affinity VALUES (?,?,?,?,?,?,?)").run(key, JSON.stringify(v.history), v.systemHash, v.toolsSig, v.modelSig, v.sampleSig, v.at); } catch {} };
const dropAffinity = (key) => { affinity.delete(key); if (db) try { db.prepare("DELETE FROM affinity WHERE key = ?").run(key); } catch {} };
const pruneAffinity = () => { const now = Date.now(); for (const [k, v] of affinity) if (now - v.at > WORKER_IDLE_MS) dropAffinity(k); };

const flattenText = (content) =>
  typeof content === "string" ? content : (content || []).map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : `[${b.type}]`)).join("\n");

// =====================================================================
// Resident worker: one CLI process per conversation, fed via open input
// =====================================================================
const workers = new Map(); // convKey -> Worker
class Worker {
  constructor(convKey, opts, firstUserBlocks) {
    this.convKey = convKey;
    this.opts = opts; // { tools, model, system, sample }
    this.sessionId = null;
    this.inputWaiters = [];
    this.inputQueue = [];
    this.collector = null;          // active HTTP turn's collector
    this.pendingHandlers = new Map(); // tool key -> { resolve }
    this.lastUsed = Date.now();
    this.dead = false;

    const self = this;
    async function* openInput() {
      yield { type: "user", message: { role: "user", content: firstUserBlocks }, parent_tool_use_id: null };
      while (true) {
        const item = await new Promise((r) => (self.inputQueue.length ? r(self.inputQueue.shift()) : self.inputWaiters.push(r)));
        if (item === null) return; // dispose / idle reap
        yield item;
      }
    }

    this.abort = new AbortController();
    this.iter = query({ prompt: openInput(), options: this.buildOptions() });
    this.pump();
  }

  buildOptions() {
    const { tools: callerTools, model, system, sample } = this.opts;
    const env = {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      ...(sample ? { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(sample) } : {}),
    };
    let mcp = null;
    if (callerTools.length) {
      const self = this;
      mcp = createSdkMcpServer({
        name: "caller_tools", version: "1.0.0", alwaysLoad: true,
        tools: callerTools.map((t, idx) => ({
          name: t.name?.replace(/[^a-zA-Z0-9_-]/g, "_") || `tool_${idx}`,
          description: t.description || "",
          inputSchema: jsonSchemaToZodShape(t.input_schema || t.parameters || {}),
          handler: async (args) => {
            // block until the caller's next request resolves this with a tool_result
            const payload = await new Promise((resolve) => self.pendingHandlers.set(`${self.handlerSeq++}`, { resolve }));
            return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
          },
        })),
      });
      this.handlerSeq = 0;
    }
    return {
      cwd: CWD, abortController: this.abort, settingSources: [],
      permissionMode: "default",
      model: model || process.env.CLAUDE_LOCAL_MODEL || undefined,
      systemPrompt: system || undefined,
      // no maxTurns cap: the whole conversation is ONE query in open-input mode;
      // the agent loop must run as many rounds as the conversation needs
      includePartialMessages: true,
      env,
      ...(mcp ? { mcpServers: { caller_tools: mcp }, allowedTools: ["mcp__caller_tools"] } : {}),
      ...(!TOOLS_ON ? { disallowedTools: [
        "Agent","AskUserQuestion","Bash","Edit","ListAgents","Read","ReportFindings","ScheduleWakeup","Skill",
        "ToolSearch","DeferredToolPlaceholder","Write","Glob","Grep","NotebookEdit","WebFetch","WebSearch","TodoWrite",
        "Task","ExitPlanMode","CronCreate","CronDelete","CronList","DesignSync","EnterPlanMode","EnterWorktree",
        "ExitWorktree","LSP","Monitor","PushNotification","RemoteTrigger","SendMessage","TaskStop","WaitForMcpServers",
        "MultiEdit","SlashTool","ListMcpResources","ReadMcpResource","Mcp",
      ] } : {}),
      canUseTool: async (input) =>
        input.tool_name?.startsWith("mcp__caller_tools")
          ? { behavior: "allow", updatedInput: input.input }
          : { behavior: "deny", updatedInput: input.input, message: "Built-in tools are disabled on this facade." },
    };
  }

  async pump() {
    try {
      for await (const msg of this.iter) {
        this.lastUsed = Date.now();
        if (msg.type === "system" && msg.subtype === "init") this.sessionId = msg.session_id ?? this.sessionId;
        this.collector?.onMessage(msg);
        // tool handoff: the model invoked a caller tool; the CLI is now blocked in
        // our handler — finalize the waiting HTTP turn with the collected tool_use
        if (this.collector && this.pendingHandlers.size > 0 && this.collector.hasToolUse()) this.collector.finalize();
      }
    } catch {
      this.dead = true;
      this.collector?.onError(new Error("worker died"));
      this.reapWaiters();
    }
  }
  reapWaiters() {
    while (this.inputWaiters.length) this.inputWaiters.shift()(null);
    for (const h of this.pendingHandlers.values()) h.resolve("__facade_worker_died__");
    this.pendingHandlers.clear();
  }
  push(item) {
    this.lastUsed = Date.now();
    if (this.inputWaiters.length) this.inputWaiters.shift()(item);
    else this.inputQueue.push(item);
  }
  dispose() { this.dead = true; this.push(null); try { this.abort.abort(new Error("dispose")); } catch {} }
}

// resolve ONE pending tool handler with the next tool_result content (FIFO —
// handlers are invoked in the order the model called the tools)
function resolveOneHandler(worker, text) {
  const firstKey = worker.pendingHandlers.keys().next().value;
  if (firstKey === undefined) return false;
  worker.pendingHandlers.get(firstKey).resolve(text);
  worker.pendingHandlers.delete(firstKey);
  return true;
}

// ---- one HTTP turn against a worker ----
function runTurn(worker, { onEvent }) {
  return new Promise((resolve, reject) => {
    const out = { text: "", toolUses: [], usage: { input_tokens: 0, output_tokens: 0 }, sawStreamStop: false, lastModel: "claude" };
    const turn = {
      hasToolUse: () => out.toolUses.length > 0,
      finalize() { cleanup(); resolve(out); },
      onMessage(msg) {
        if (msg.type === "stream_event") {
          const ev = msg.event;
          if (ev.type === "message_start") { out.lastModel = ev.message?.model ?? out.lastModel; out.usage.input_tokens += ev.message?.usage?.input_tokens ?? 0; }
          else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") out.text += ev.delta.text;
          else if (ev.type === "message_delta") out.usage.output_tokens += ev.usage?.output_tokens ?? 0;
          else if (ev.type === "message_stop") out.sawStreamStop = true;
          onEvent?.(ev);
        } else if (msg.type === "assistant") {
          // text & usage come from stream events (includePartialMessages is always
          // on); the complete assistant message contributes only tool blocks + model
          for (const b of msg.message?.content || []) {
            if (b.type === "tool_use") out.toolUses.push({ type: "tool_use", id: b.id, name: b.name.replace(/^mcp__caller_tools__/, ""), input: b.input });
          }
          out.lastModel = msg.message?.model ?? out.lastModel;
        } else if (msg.type === "result") {
          if (msg.subtype !== "success") { cleanup(); return reject(Object.assign(new Error(msg.error || `turn ended: ${msg.subtype}`), { status: 502 })); }
          cleanup(); resolve(out);
        }
      },
      onError(e) { cleanup(); reject(e); },
    };
    const cleanup = () => { if (worker.collector === turn) worker.collector = null; clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); worker.dispose(); reject(new Error("turn timeout")); }, TIMEOUT_MS);
    worker.collector = turn;
  });
}

// =====================================================================
// HTTP layer
// =====================================================================
const sse = (res, ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
const startSSE = (res) => { if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  if (API_KEY && url.pathname.startsWith("/v1/")) {
    const provided = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "") || req.headers["x-api-key"] || "";
    const ok = provided.length === API_KEY.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(API_KEY));
    if (!ok) { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid or missing api key" } })); }
  }

  if (route === "GET /health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, version: 3, workers: workers.size })); }
  if (route === "GET /v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [ { id: "sonnet" }, { id: "opus" }, { id: "haiku" } ] }));
  }
  if (req.method === "POST" && url.pathname.replace(/\?.*$/, "") === "/v1/messages") {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { res.writeHead(e.status || 400, { "content-type": "application/json" }); return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: String(e.message || e) } })); }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages[] is required" } }));
    }

    await acquire();
    try {
      pruneAffinity();
      const key = req.headers["x-claude-session-id"] ? `explicit:${req.headers["x-claude-session-id"]}`
        : req.headers["x-claude-code-session-id"] ? `ccsid:${req.headers["x-claude-code-session-id"]}`
        : `first:${body.messages[0] ? sha(msgSig(body.messages[0])).slice(0, 24) : "empty"}`;
      const systemHash = body.system !== undefined ? sha(msgSig(body.system)) : "";
      const toolsSig = msgSig((body.tools || []).map((t) => t.name).sort());
      const modelSig = body.model || "";
      const sample = {};
      for (const k of ["temperature", "top_p", "top_k", "stop_sequences"]) if (body[k] !== undefined) sample[k] = body[k];
      const sampleSig = msgSig(sample);

      const entry = affinity.get(key);
      let worker = workers.get(key);
      let continuing = false;

      if (worker && !worker.dead && entry && entry.systemHash === systemHash && entry.toolsSig === toolsSig && entry.modelSig === modelSig && entry.sampleSig === sampleSig) {
        const hist = body.messages, prev = entry.history;
        if (hist.length > prev.length) {
          let prefixOk = true;
          for (let i = 0; i < prev.length; i++) if (msgSig(hist[i]) !== msgSig(prev[i])) { prefixOk = false; break; }
          if (prefixOk) continuing = true;
        }
      }
      if (!continuing) {
        worker?.dispose();
        const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
        const earlier = body.messages.slice(0, body.messages.lastIndexOf(lastUser));
        const blocks = [];
        if (earlier.length) blocks.push({ type: "text", text: earlier.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${flattenText(m.content).trim()}`).join("\n\n") });
        blocks.push(...(typeof lastUser.content === "string" ? [{ type: "text", text: lastUser.content }] : lastUser.content));
        worker = new Worker(key, {
          tools: body.tools || [], model: body.model,
          system: typeof body.system === "string" ? body.system : flattenText(body.system) || undefined,
          sample: Object.keys(sample).length ? sample : null,
        }, blocks);
        workers.set(key, worker);
      } else {
        // feed the resident worker: tool_results unblock pending handlers (FIFO),
        // any remaining plain blocks start the next turn
        const prevLen = entry.history.length;
        const delta = body.messages.slice(prevLen);
        const trailingUser = [...delta].reverse().find((m) => m.role === "user");
        const plainBlocks = [];
        if (trailingUser) {
          const blocks = typeof trailingUser.content === "string" ? [{ type: "text", text: trailingUser.content }] : trailingUser.content;
          for (const b of blocks) if (b.type === "tool_result") resolveOneHandler(worker, typeof b.content === "string" ? b.content : flattenText(b.content));
          else plainBlocks.push(b);
        }
        if (plainBlocks.length) worker.push({ type: "user", message: { role: "user", content: plainBlocks }, parent_tool_use_id: null });
        // no push at all and nothing pending: the turn was already running (e.g.
        // client retry) — just collect whatever the worker produces next
      }

      const result = await runTurn(worker, { ...(body.stream === true ? { onEvent: (ev) => { startSSE(res); sse(res, ev); } } : {}) });
      const sid = worker.sessionId || "";
      saveAffinity(key, { history: body.messages.map((m) => JSON.parse(msgSig(m))), systemHash, toolsSig, modelSig, sampleSig, at: Date.now() });
      const stopReason = result.toolUses.length ? "tool_use" : "end_turn";
      const content = result.toolUses.length
        ? [...(result.text ? [{ type: "text", text: result.text }] : []), ...result.toolUses]
        : [{ type: "text", text: result.text }];

      if (body.stream === true) {
        startSSE(res);
        if (!result.sawStreamStop) { sse(res, { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: result.usage }); sse(res, { type: "message_stop" }); }
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `msg_local_${Date.now().toString(36)}`, type: "message", role: "assistant", model: result.lastModel, content, stop_reason: stopReason, stop_sequence: null, usage: result.usage, session_id: sid }));
      }
    } catch (e) {
      if (!res.headersSent) { res.writeHead(e.status || 500, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(e.message || e) } })); }
      else res.end();
    } finally { release(); }
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no route: ${route}` } }));
});

// idle / cap reaper
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of workers) if (now - w.lastUsed > WORKER_IDLE_MS || w.dead) { w.dispose(); workers.delete(k); }
  if (workers.size > WORKER_MAX) {
    const oldest = [...workers.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k] of oldest.slice(0, workers.size - WORKER_MAX)) { workers.get(k).dispose(); workers.delete(k); }
  }
}, 60_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`[claude-local-api v3] http://${HOST}:${PORT} resident workers (idle ${WORKER_IDLE_MS / 60000}min, max ${WORKER_MAX}) cwd=${CWD}`);
});
