# Durable Execution

**The pain:** _What happens if the process dies after a side effect?_

This is the emotional center of the course. Lesson 1's agent works in a demo and it's a liability
in production. Its state is a variable in memory, and the instant the process dies, that state is
gone. Mid-task, mid-spend, mid-`sendReply`. Today we make the agent **durable**: it checkpoints
every step, and a crash resumes from the last completed step with no repeated work and no
duplicate side effects.

> The shift: stop thinking in "agent calls" and start thinking in **evented, checkpointed
> execution**. If you can't replay it, resume it, and retry it safely, it isn't production-grade.

## The failure mode

Take the Lesson 1 agent. Submit the 3-item task, and **kill the server while it's running**
(`Ctrl-C`). Two things just broke:

1. The in-memory `messages` array vanished. On restart the agent has no idea anything happened.
2. Any `sendReply` it already fired **cannot be un-fired**, and a naive "just run it again" would
   re-send those emails.

Retries aren't enough. Durability isn't just saving messages. It's knowing **which side effects
already happened** so you never repeat them.

## What the harness adds

Two durable stores, both backed by Postgres:

- **Durable execution** with **[DBOS](https://docs.dbos.dev)**. Every model call and every tool
  call becomes a checkpointed *step*. DBOS records each step's result, and on restart it resumes the
  workflow from the last completed step.
- **A durable event log** with **Drizzle**. The in-memory event buffer from Lesson 1 becomes a
  Postgres table, so the inspector can replay the whole timeline across a restart.

You'll need a Postgres database. Grab a free instant one from
[neon.new](https://neon.new) and put its **direct** connection string in `.dev.vars` as
`DATABASE_URL` (use the host *without* `-pooler`, since DBOS needs session features that connection
poolers break).

## Live code

> Files you already have are shown as a diff: red `-` lines come out, green `+` lines go in, everything else is context you leave alone. New files are shown in full.

First, install the new dependencies:

```bash
npm install @dbos-inc/dbos-sdk drizzle-orm postgres
```

### 1. `harness/db.ts`: the durable event log table

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { pgTable, bigserial, jsonb } from "drizzle-orm/pg-core";
import type { AgentEvent } from "@shared/events";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — copy .dev.vars.example to .dev.vars.");
}

// postgres.js connection (Neon requires SSL, carried in the URL). We keep the
// pool small — this is the durable event log, not a high-traffic app DB.
const client = postgres(connectionString, { max: 5 });
export const db = drizzle(client);

// The DURABLE event log. In Lesson 1 the event stream lived in a memory array
// that vanished on restart. Now every event is a row here, so the inspector can
// replay the whole timeline — including work that happened before a crash.
export const eventLog = pgTable("event_log", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(), // global order
  data: jsonb("data").$type<AgentEvent>().notNull(),
});

// Create the table on boot. Keeps the workshop migration-free; in a real app
// you'd use Drizzle migrations instead.
export async function ensureSchema(): Promise<void> {
  await client`
    CREATE TABLE IF NOT EXISTS event_log (
      seq  bigserial PRIMARY KEY,
      data jsonb NOT NULL
    )
  `;
}
```

### 2. `harness/bus.ts`: make `emit` durable

In Lesson 1 the bus was an in-memory array in `server/`. Move it to `harness/bus.ts` and give it a
second job: **write every event to Postgres before broadcasting it.** `emit` becomes async.

```ts
import { randomUUID } from "node:crypto";
import { db, eventLog } from "./db";
import type { AgentEvent, EventInput } from "@shared/events";

// The harness event bus. Two jobs now:
//   1. DURABLY persist every event to Postgres (so the timeline survives a crash)
//   2. broadcast it live to any connected inspector
//
// `emit` is async now — we write to the database before we hand the event out.

type Listener = (event: AgentEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function emit(input: EventInput): Promise<void> {
  const event: AgentEvent = { ...input, id: randomUUID(), ts: Date.now() };
  await db.insert(eventLog).values({ data: event }); // durable, ordered by `seq`
  for (const listener of listeners) listener(event); // live
}

// The full timeline so far, in order — read back from Postgres on every connect.
export async function history(): Promise<AgentEvent[]> {
  const rows = await db.select().from(eventLog).orderBy(eventLog.seq);
  return rows.map((row) => row.data);
}
```

Now **delete** the old in-memory bus at `server/bus.ts`. `harness/bus.ts` replaces it.

### 3. `harness/tools.ts`: take back tool execution

To make a tool call durable and **exactly-once**, the harness has to own when it runs. So we
**drop `execute`** from the tool definitions (the model just sees the schemas) and add our own
`runTool`.

```diff
@@ -1,62 +1,65 @@
 import { tool } from "ai";
 import { z } from "zod";
 
-// The tools our triage agent can call. They're fake but realistic.
+// The tool SCHEMAS the model sees. Note there's no `execute` anymore.
 //
-// The important thing for Lesson 1: these run with NO mediation. No sandbox,
-// no policy, no approval. `sendReply` actually "emails the customer" the moment
-// the model asks for it. That recklessness is the whole point — it's what the
-// rest of the course exists to fix.
-
-const KNOWLEDGE_BASE: Record<string, string> = {
-  billing:
-    "Double charges are usually a duplicate authorization that drops off in 3–5 days. If it already settled, refund immediately.",
-  refund: "Refunds post in 5–10 business days. Pro accounts can be expedited.",
-  export:
-    "The Safari export failure is a known bug (TICKET-4412). Workaround: use Chrome or the CSV export.",
-  pricing:
-    "Team plans are $20/seat/mo with a volume discount at 25+ seats. For 50+ seats, send the pricing PDF.",
-};
-
+// In Lesson 1 the AI SDK ran the tools for us. To make tool calls DURABLE we
+// take execution back: the harness runs each tool itself (see `runTool`), so
+// every call can be wrapped in its own DBOS step and run exactly once.
 export const tools = {
   searchKnowledgeBase: tool({
     description: "Search the support knowledge base for relevant articles.",
-    inputSchema: z.object({
-      query: z.string().describe("what to look up"),
-    }),
-    execute: async ({ query }) => {
-      const hits = Object.entries(KNOWLEDGE_BASE)
-        .filter(([key]) => query.toLowerCase().includes(key))
-        .map(([, article]) => article);
-      return { articles: hits.length ? hits : ["No exact match — use your judgment."] };
-    },
+    inputSchema: z.object({ query: z.string().describe("what to look up") }),
   }),
-
   classifyItem: tool({
     description: "Classify a work item into a category.",
     inputSchema: z.object({
       itemId: z.string(),
       category: z.enum(["billing", "technical", "sales", "other"]),
     }),
-    execute: async ({ itemId, category }) => ({ ok: true, itemId, category }),
   }),
-
   draftReply: tool({
     description: "Write a draft reply for a work item. Does not send anything.",
-    inputSchema: z.object({
-      itemId: z.string(),
-      message: z.string(),
-    }),
-    execute: async ({ itemId }) => ({ ok: true, draftId: `draft-${itemId}` }),
+    inputSchema: z.object({ itemId: z.string(), message: z.string() }),
   }),
-
   sendReply: tool({
     description: "Send the drafted reply to the customer. This really emails them.",
-    inputSchema: z.object({
-      itemId: z.string(),
-      draftId: z.string(),
-    }),
-    // DANGEROUS: an irreversible side effect with zero confirmation.
-    execute: async ({ itemId, draftId }) => ({ sent: true, itemId, draftId }),
+    inputSchema: z.object({ itemId: z.string(), draftId: z.string() }),
   }),
 };
+
+const KNOWLEDGE_BASE: Record<string, string> = {
+  billing:
+    "Double charges are usually a duplicate authorization that drops off in 3–5 days. If it already settled, refund immediately.",
+  refund: "Refunds post in 5–10 business days. Pro accounts can be expedited.",
+  export:
+    "The Safari export failure is a known bug (TICKET-4412). Workaround: use Chrome or the CSV export.",
+  pricing:
+    "Team plans are $20/seat/mo with a volume discount at 25+ seats. For 50+ seats, send the pricing PDF.",
+};
+
+// The harness-owned executor. No sandbox or approval gate yet, but now that
+// each call runs inside a DBOS step, a finished side effect such as `sendReply`
+// is checkpointed and never repeated after a crash.
+export async function runTool(
+  name: string,
+  args: Record<string, unknown>,
+): Promise<Record<string, unknown>> {
+  switch (name) {
+    case "searchKnowledgeBase": {
+      const query = String(args.query ?? "").toLowerCase();
+      const hits = Object.entries(KNOWLEDGE_BASE)
+        .filter(([key]) => query.includes(key))
+        .map(([, article]) => article);
+      return { articles: hits.length ? hits : ["No exact match — use your judgment."] };
+    }
+    case "classifyItem":
+      return { ok: true, itemId: args.itemId, category: args.category };
+    case "draftReply":
+      return { ok: true, draftId: `draft-${args.itemId}` };
+    case "sendReply":
+      return { sent: true, itemId: args.itemId, draftId: args.draftId };
+    default:
+      throw new Error(`unknown tool: ${name}`);
+  }
+}
```

### 4. `harness/runtime.ts`: the durable agent loop

The same while-loop shape as Lesson 1, but every model turn and every tool call is a
`DBOS.runStep(...)`. DBOS checkpoints each step's result. On recovery it returns the cached result
instead of re-running the step.

```diff
@@ -1,90 +1,145 @@
+import { DBOS } from "@dbos-inc/dbos-sdk";
 import { streamText } from "ai";
-import type { ModelMessage } from "ai";
-import { randomUUID } from "node:crypto";
-import { EventType, type Emit } from "@shared/events";
+import type { ModelMessage, JSONValue } from "ai";
+import { EventType } from "@shared/events";
+import { emit } from "./bus";
 import { model } from "./model";
-import { tools } from "./tools";
+import { tools, runTool } from "./tools";
 import { SYSTEM_PROMPT } from "./system-prompt";
 
 // A safety cap so a confused model can't loop forever.
 const MAX_STEPS = 10;
 
-// THE BRITTLE AGENT.
-//
-// This is a script with an LLM in the middle. It works in a demo and dies in
-// production a dozen ways:
+type ToolCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };
+type Turn = { text: string; toolCalls: ToolCall[]; responseMessages: ModelMessage[] };
+
+// One model turn: stream the tokens out as events, then return the assistant's
+// message(s) and any tool calls. We run this as a DBOS step, so a completed turn
+// is checkpointed and never re-called — a crash won't re-bill the LLM.
+async function modelTurn(workflowId: string, messages: ModelMessage[]): Promise<Turn> {
+  const result = streamText({ model, messages, tools });
+
+  for await (const part of result.fullStream) {
+    if (part.type === "text-delta") {
+      await emit({ type: EventType.ModelDelta, workflowId, text: part.text });
+    }
+  }
+
+  const rawCalls = await result.toolCalls;
+  return {
+    text: await result.text,
+    toolCalls: rawCalls.map((c) => ({
+      toolCallId: c.toolCallId,
+      toolName: c.toolName,
+      input: c.input as Record<string, unknown>,
+    })),
+    responseMessages: (await result.response).messages,
+  };
+}
+
+// Execute one tool. We run this as a DBOS step so its side effect (e.g.
+// sendReply actually emailing someone) runs EXACTLY ONCE — a completed tool step
+// is never re-run when DBOS recovers the workflow after a crash.
+async function toolStep(
+  workflowId: string,
+  call: ToolCall,
+): Promise<Record<string, unknown>> {
+  await emit({
+    type: EventType.ToolRequested,
+    workflowId,
+    toolCallId: call.toolCallId,
+    name: call.toolName,
+    args: call.input,
+  });
+  const output = await runTool(call.toolName, call.input);
+  await emit({
+    type: EventType.ToolCompleted,
+    workflowId,
+    toolCallId: call.toolCallId,
+    result: output,
+  });
+  return output;
+}
+
+// THE DURABLE AGENT LOOP.
 //
-//   · the `messages` array lives in memory      → crash = total loss
-//   · tools run with no mediation               → `sendReply` just fires
-//   · history only grows                        → context bloat
-//   · one agent does everything                 → no specialization
+// Structurally it's the same while-loop as Lesson 1 — but every model call and
+// every tool call is a DBOS step. DBOS checkpoints each step's result to
+// Postgres. If the process crashes mid-run, DBOS recovers this workflow on the
+// next launch and resumes from the last completed step: no repeated LLM calls,
+// no duplicate sends, no lost work.
 //
-// Make it work, then look at everything it gets wrong.
-export async function runAgent(opts: { input: string; emit: Emit }): Promise<void> {
-  const { input, emit } = opts;
-  const workflowId = randomUUID();
-  emit({ type: EventType.WorkflowStarted, workflowId, input });
+// The catch: the workflow body itself re-runs on recovery, so it must be
+// deterministic. All non-determinism (the model, the tools, the clock) lives
+// inside steps — the body just orchestrates and rebuilds `messages` from the
+// cached step results.
+async function agentWorkflow(input: string): Promise<string> {
+  const workflowId = DBOS.workflowID ?? "unknown";
+
+  await DBOS.runStep(
+    () => emit({ type: EventType.WorkflowStarted, workflowId, input }),
+    { name: "started" },
+  );
 
-  // BRITTLE STATE: a plain in-memory array. If this process dies, it's gone.
   const messages: ModelMessage[] = [
     { role: "system", content: SYSTEM_PROMPT },
     { role: "user", content: input },
   ];
 
-  // THE LOOP. We drive it ourselves — each pass is exactly one model turn,
-  // because streamText does a single generation by default.
   let step = 0;
   while (step < MAX_STEPS) {
-    const result = streamText({ model, messages, tools });
+    const turn = await DBOS.runStep(() => modelTurn(workflowId, messages), {
+      name: `model-${step}`,
+    });
+    messages.push(...turn.responseMessages);
 
-    // Forward everything the model does onto the harness event stream so the
-    // inspector can render it. (`part.type` here is the AI SDK's, not ours.)
-    for await (const part of result.fullStream) {
-      switch (part.type) {
-        case "text-delta":
-          emit({ type: EventType.ModelDelta, workflowId, text: part.text });
-          break;
-        case "tool-call":
-          emit({
-            type: EventType.ToolRequested,
-            workflowId,
-            toolCallId: part.toolCallId,
-            name: part.toolName,
-            args: part.input,
-          });
-          break;
-        case "tool-result":
-          emit({
-            type: EventType.ToolCompleted,
-            workflowId,
-            toolCallId: part.toolCallId,
-            result: part.output,
-          });
-          break;
-        case "error":
-          emit({ type: EventType.WorkflowFailed, workflowId, error: String(part.error) });
-          return;
-      }
+    if (turn.toolCalls.length === 0) {
+      await DBOS.runStep(
+        () => emit({ type: EventType.ModelCompleted, workflowId, text: turn.text }),
+        { name: `model-done-${step}` },
+      );
+      await DBOS.runStep(
+        () => emit({ type: EventType.WorkflowCompleted, workflowId, output: turn.text }),
+        { name: "completed" },
+      );
+      return turn.text;
     }
 
-    // Append the model's message(s) — including any tool results — to history.
-    messages.push(...(await result.response).messages);
-
-    // No more tool calls means the model answered. We're done.
-    const toolCalls = await result.toolCalls;
-    if (toolCalls.length === 0) {
-      const text = await result.text;
-      emit({ type: EventType.ModelCompleted, workflowId, text });
-      emit({ type: EventType.WorkflowCompleted, workflowId, output: text });
-      return;
+    for (const call of turn.toolCalls) {
+      const output = await DBOS.runStep(() => toolStep(workflowId, call), {
+        name: `tool-${call.toolCallId}`,
+      });
+      // Feed the tool result back to the model on the next turn.
+      messages.push({
+        role: "tool",
+        content: [
+          {
+            type: "tool-result",
+            toolCallId: call.toolCallId,
+            toolName: call.toolName,
+            output: { type: "json", value: output as JSONValue },
+          },
+        ],
+      });
     }
 
     step++;
   }
 
-  emit({
-    type: EventType.WorkflowFailed,
-    workflowId,
-    error: `Hit the ${MAX_STEPS}-step limit without finishing.`,
-  });
+  await DBOS.runStep(
+    () =>
+      emit({
+        type: EventType.WorkflowFailed,
+        workflowId,
+        error: `Hit the ${MAX_STEPS}-step limit without finishing.`,
+      }),
+    { name: "failed" },
+  );
+  return "";
 }
+
+// Register the workflow with DBOS. `runAgentWorkflow` is the durable, recoverable
+// version of Lesson 1's `runAgent`.
+export const runAgentWorkflow = DBOS.registerWorkflow(agentWorkflow, {
+  name: "agentWorkflow",
+});
```

### 5. `server/env.ts`: load `.dev.vars` before anything reads it

`harness/db.ts` reads `DATABASE_URL` at import time, and ES module imports run *before* top-level
statements. So put the dotenv call in its own module and import it first.

```ts
import { config } from "dotenv";

// Load .dev.vars into process.env. This module is imported FIRST in the server
// (before anything that reads env at load time, like harness/db.ts) because ES
// module imports are evaluated before top-level statements.
config({ path: ".dev.vars" });
```

### 6. `server/index.ts`: DBOS lifecycle + the durable bus

```diff
@@ -1,55 +1,74 @@
-import { config } from "dotenv";
-// Load secrets from .dev.vars (OPENAI_API_KEY, ...) before anything else.
-config({ path: ".dev.vars" });
+// MUST be first: loads .dev.vars before any module that reads env at load time.
+import "./env";
 
+import { DBOS } from "@dbos-inc/dbos-sdk";
 import express from "express";
 import { createServer } from "node:http";
 import { WebSocketServer, type WebSocket } from "ws";
-import { EventBus, createEmitter } from "./bus";
-import { runAgent } from "../harness/runtime";
-import { EventType, type ClientMessage } from "@shared/events";
+import { ensureSchema } from "../harness/db";
+import { subscribe, history } from "../harness/bus";
+import { runAgentWorkflow } from "../harness/runtime";
+import type { ClientMessage } from "@shared/events";
 
 const PORT = Number(process.env.PORT ?? 8787);
 
-const app = express();
-app.get("/health", (_req, res) => {
-  res.json({ ok: true });
-});
+async function main() {
+  // Make sure the durable event log exists.
+  await ensureSchema();
 
-const server = createServer(app);
-const wss = new WebSocketServer({ server, path: "/ws" });
-const bus = new EventBus();
+  // Point DBOS at the same Postgres database for its checkpoint store, then
+  // launch it. launch() ALSO recovers any workflows that were mid-flight when
+  // the process last died, resuming them from their last completed step.
+  DBOS.setConfig({ name: "harness", systemDatabaseUrl: process.env.DATABASE_URL });
+  await DBOS.launch();
 
-// Forward every event the harness emits to all connected inspectors.
-bus.subscribe((event) => {
-  const data = JSON.stringify(event);
-  for (const client of wss.clients) {
-    if (client.readyState === client.OPEN) client.send(data);
-  }
-});
+  const app = express();
+  app.get("/health", (_req, res) => {
+    res.json({ ok: true });
+  });
 
-wss.on("connection", (socket: WebSocket) => {
-  // Replay the timeline so far so a fresh inspector isn't blank.
-  for (const event of bus.history()) socket.send(JSON.stringify(event));
+  const server = createServer(app);
+  const wss = new WebSocketServer({ server, path: "/ws" });
 
-  socket.on("message", (raw) => {
-    let message: ClientMessage;
-    try {
-      message = JSON.parse(raw.toString());
-    } catch {
-      return; // ignore anything that isn't valid JSON
+  // Broadcast every emitted event to all connected inspectors.
+  subscribe((event) => {
+    const data = JSON.stringify(event);
+    for (const client of wss.clients) {
+      if (client.readyState === client.OPEN) client.send(data);
     }
+  });
 
-    if (message.type === "submit_task") {
-      const emit = createEmitter(bus);
-      // Fire and forget — the agent reports everything via events, not a return value.
-      runAgent({ input: message.input, emit }).catch((error) => {
-        emit({ type: EventType.Log, level: "error", message: String(error) });
-      });
-    }
+  wss.on("connection", async (socket: WebSocket) => {
+    // Register the message handler FIRST. history() is now an async DB read, and
+    // the client sends submit_task the instant it connects — if we awaited
+    // history() before attaching this listener, that first message would be lost.
+    socket.on("message", async (raw) => {
+      let message: ClientMessage;
+      try {
+        message = JSON.parse(raw.toString());
+      } catch {
+        return; // ignore anything that isn't valid JSON
+      }
+
+      if (message.type === "submit_task") {
+        // Start the durable workflow in the background. It reports progress via
+        // the event stream; we don't wait for the result here.
+        await DBOS.startWorkflow(runAgentWorkflow)(message.input);
+      }
+    });
+
+    // Replay the DURABLE timeline so a fresh inspector shows everything —
+    // including work that happened before a crash, and a workflow DBOS is
+    // currently recovering.
+    for (const event of await history()) socket.send(JSON.stringify(event));
   });
-});
 
-server.listen(PORT, () => {
-  console.log(`harness server listening on http://localhost:${PORT}  (ws: /ws)`);
+  server.listen(PORT, () => {
+    console.log(`harness server listening on http://localhost:${PORT}  (ws: /ws)`);
+  });
+}
+
+main().catch((error) => {
+  console.error("failed to start:", error);
+  process.exit(1);
 });
```

### 7. `scripts/inspect-log.ts`: read the durable log straight from Postgres

A tiny CLI to prove the durability claims from the terminal. It counts events by type and flags any
tool call that was requested more than once (a repeated side effect). Pass `truncate` to wipe the
log between runs.

```ts
import { config } from "dotenv";
config({ path: ".dev.vars" });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

if (process.argv.includes("truncate")) {
  await sql`TRUNCATE event_log`;
  console.log("event_log truncated.");
  await sql.end();
  process.exit(0);
}

const rows = await sql<{ data: any }[]>`SELECT data FROM event_log ORDER BY seq`;
const events = rows.map((r) => r.data);

const byType: Record<string, number> = {};
for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;

// How many times was each tool call REQUESTED? >1 means a side effect was repeated.
const reqByCall: Record<string, number> = {};
for (const e of events) {
  if (e.type === "tool.requested") reqByCall[e.toolCallId] = (reqByCall[e.toolCallId] ?? 0) + 1;
}
const duplicated = Object.entries(reqByCall).filter(([, n]) => n > 1);

console.log("total events:      ", events.length);
console.log("by type:           ", byType);
console.log("distinct tool calls:", Object.keys(reqByCall).length);
console.log("DUPLICATED calls:  ", duplicated.length, duplicated);
console.log("completed:         ", byType["workflow.completed"] ?? 0);

await sql.end();
```

## The demo: crash and resume

1. `npm run dev`, open the inspector, submit the 3-item task. Watch the events stream, and note
   they're now landing in Postgres, not just memory.
2. **Kill the server mid-run** (`Ctrl-C`), somewhere after it's classified/drafted a few items.
3. **Restart it** (`npm run dev`). On launch, DBOS finds the in-flight workflow and **resumes it
   from the last completed step**. The same workflow finishes, and here's the key part: the tool
   calls that already ran (every `sendReply`) are **not** repeated.

In our run the proof was mechanical. At the crash, all 12 tool calls were checkpointed with **zero
duplicates**. After restart, the *same* workflow id resumed and completed, and `sendReply` had
fired **exactly 3 times**. Compare that to Lesson 1, where a restart loses everything and a re-run
double-sends.

The honest fine print, worth saying out loud: a *completed* step is never re-run. A step that was
**in flight** at the moment of the crash *does* re-run on recovery, so the interrupted model turn
re-streamed some tokens. That's at-least-once for the in-flight step. Production systems make the
risky steps idempotent (e.g. an idempotency key on `sendReply`) to get exactly-once all the way
through.

## In production

Temporal, Inngest, Restate, DBOS (what we used), Cloudflare Workflows. They differ in hosting and
ergonomics, but the core idea is identical to what you just built: **event-sourced, checkpointed,
resumable execution.** One DBOS-specific gotcha to remember: it recovers workflows **per code
version**, so a crash and a restart of the *same* build resume cleanly. Change the code first and
the old in-flight workflow won't be picked up.
