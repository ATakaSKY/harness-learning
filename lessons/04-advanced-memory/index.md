# Memory & Context Hydration

**The pain:** _What happens when context grows forever?_

Look at our durable loop. Every turn we push the model's messages and tool results onto an array
and send the **whole thing** back next turn. For a handful of items it's fine. For a long session
it's a slow-motion failure: the prompt balloons, the bill climbs every turn, and the model
gets worse as the signal drowns in history. This lesson kills the "append everything to `messages`"
habit. **Context is a runtime decision, not a chat log.**

## What the harness adds

Three different things, kept separate on purpose:

- **History**: everything that happened. We already have this, the durable Postgres event log
  from Lesson 2.
- **State**: a compact, running **summary** of older turns (working memory).
- **Context**: what the model actually sees *this* turn, assembled on demand.

A **`ContextHydrator`** builds the context fresh each turn (system + the pinned task + the summary +
only the most recent turns). A **summarizer** compacts old turns into the running summary once
the window gets too big, so what we send the model stays roughly flat no matter how long the
session runs.

Here's a production note we hit live: **compact by token budget, not turn count.** Modern models batch
many tool calls into a single turn, so "turns" is a bad proxy for size. A token estimate is what
actually tracks context bloat.

## Live code

> Files you already have are shown as a diff: red `-` lines come out, green `+` lines go in, everything else is context you leave alone. New files are shown in full.

The `memory.compacted` event type already ships in `shared/events.ts` (events.ts is complete in the
starter on every branch), so we don't touch that file. We just *emit* the event from the runtime.

### 1. `harness/memory.ts`: hydrate and summarize

A new module. It owns the three memory concepts (History / State / Context), a rough token
estimator, the context hydrator, and the summarizer. Create `harness/memory.ts`:

```ts
import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { model } from "./model";
import { SYSTEM_PROMPT } from "./system-prompt";

// Compact once the recent-turns window grows past MAX_CONTEXT_TOKENS, peeling
// the oldest turns into the summary until it's back under KEEP_CONTEXT_TOKENS.
// Token budget — not turn count — is what actually drives context bloat, and it
// holds up even when the model batches many tool calls into one turn.
// (Rough estimate: ~4 chars per token. Kept low so compaction kicks in on a short task.)
export const MAX_CONTEXT_TOKENS = 500;
export const KEEP_CONTEXT_TOKENS = 200;

export function estimateTokens(messages: ModelMessage[]): number {
  const chars = messages.reduce(
    (n, m) =>
      n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
    0,
  );
  return Math.ceil(chars / 4);
}

// Three different things, on purpose:
//   · HISTORY  = everything that happened — the durable event log (Lesson 2).
//   · STATE    = a running SUMMARY of older turns (compacted working memory).
//   · CONTEXT  = what the model actually sees THIS turn, assembled on demand.
//
// buildContext hydrates the context: the system prompt, the pinned task, the
// summary of old work, and only the most recent turns verbatim.
export function buildContext(
  task: string,
  summary: string,
  turns: ModelMessage[][],
): ModelMessage[] {
  const context: ModelMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task }, // the goal is pinned, never summarized away
  ];
  if (summary) {
    context.push({ role: "system", content: `Summary of earlier work so far:\n${summary}` });
  }
  for (const turn of turns) context.push(...turn); // recent turns, verbatim
  return context;
}

// Compress old turns into the running summary. This is an LLM call, so in the
// runtime it's wrapped in a DBOS step — the summary is checkpointed and a crash
// won't re-summarize.
export async function summarize(
  oldTurns: ModelMessage[][],
  priorSummary: string,
): Promise<string> {
  const transcript = oldTurns
    .flat()
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n")
    .slice(0, 6000);

  const { text } = await generateText({
    model,
    messages: [
      {
        role: "system",
        content:
          "You compress an agent's work log into a short running summary. Preserve concrete facts: item ids, categories, draft ids, amounts, and what was already sent. Be terse.",
      },
      {
        role: "user",
        content: `Prior summary:\n${priorSummary || "(none)"}\n\nFold in this newer work:\n${transcript}\n\nReturn the updated summary.`,
      },
    ],
  });
  return text;
}
```

### 2. `harness/runtime.ts`: keep turns, hydrate, compact

The loop now tracks the conversation as a list of **turns** (so we can compact at clean
boundaries), each model call goes over the **hydrated context** instead of the full history, and
`modelTurn` takes that `context` instead of the whole message array. The summarizer and the
`memory.compacted` emit are DBOS steps, so they compose with Lesson 2: the summary is checkpointed
and a crash won't re-summarize. Here's the full file:

```diff
@@ -5,19 +5,25 @@ import { EventType } from "@shared/events";
 import { emit } from "./bus";
 import { model } from "./model";
 import { tools, runTool } from "./tools";
-import { SYSTEM_PROMPT } from "./system-prompt";
+import {
+  buildContext,
+  summarize,
+  estimateTokens,
+  MAX_CONTEXT_TOKENS,
+  KEEP_CONTEXT_TOKENS,
+} from "./memory";
 
-// A safety cap so a confused model can't loop forever.
-const MAX_STEPS = 10;
+// A safety cap so a confused model can't loop forever. Higher than Lesson 1 now
+// that one task can span many items (and therefore many turns).
+const MAX_STEPS = 30;
 
 type ToolCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };
 type Turn = { text: string; toolCalls: ToolCall[]; responseMessages: ModelMessage[] };
 
-// One model turn: stream the tokens out as events, then return the assistant's
-// message(s) and any tool calls. We run this as a DBOS step, so a completed turn
-// is checkpointed and never re-called — a crash won't re-bill the LLM.
-async function modelTurn(workflowId: string, messages: ModelMessage[]): Promise<Turn> {
-  const result = streamText({ model, messages, tools });
+// One model turn over the HYDRATED context (not the whole history). Run as a
+// DBOS step so a completed turn is checkpointed and never re-billed.
+async function modelTurn(workflowId: string, context: ModelMessage[]): Promise<Turn> {
+  const result = streamText({ model, messages: context, tools });
 
   for await (const part of result.fullStream) {
     if (part.type === "text-delta") {
@@ -37,13 +43,8 @@ async function modelTurn(workflowId: string, messages: ModelMessage[]): Promise<
   };
 }
 
-// Execute one tool. We run this as a DBOS step so its side effect (e.g.
-// sendReply actually emailing someone) runs EXACTLY ONCE — a completed tool step
-// is never re-run when DBOS recovers the workflow after a crash.
-async function toolStep(
-  workflowId: string,
-  call: ToolCall,
-): Promise<Record<string, unknown>> {
+// Execute one tool. Run as a DBOS step so its side effect runs exactly once.
+async function toolStep(workflowId: string, call: ToolCall): Promise<Record<string, unknown>> {
   await emit({
     type: EventType.ToolRequested,
     workflowId,
@@ -61,37 +62,57 @@ async function toolStep(
   return output;
 }
 
-// THE DURABLE AGENT LOOP.
+// THE DURABLE AGENT LOOP, now with bounded memory.
 //
-// Structurally it's the same while-loop as Lesson 1 — but every model call and
-// every tool call is a DBOS step. DBOS checkpoints each step's result to
-// Postgres. If the process crashes mid-run, DBOS recovers this workflow on the
-// next launch and resumes from the last completed step: no repeated LLM calls,
-// no duplicate sends, no lost work.
+// We keep the conversation as a list of TURNS. Each pass:
+//   1. if we have too many turns, compact the oldest into a running summary
+//   2. hydrate the context (system + task + summary + recent turns)
+//   3. run one model turn over THAT context — not the whole history
 //
-// The catch: the workflow body itself re-runs on recovery, so it must be
-// deterministic. All non-determinism (the model, the tools, the clock) lives
-// inside steps — the body just orchestrates and rebuilds `messages` from the
-// cached step results.
+// So the tokens we send stay roughly flat no matter how long the task runs. The
+// full history still lives, durably, in the Postgres event log.
 async function agentWorkflow(input: string): Promise<string> {
   const workflowId = DBOS.workflowID ?? "unknown";
-
   await DBOS.runStep(
     () => emit({ type: EventType.WorkflowStarted, workflowId, input }),
     { name: "started" },
   );
 
-  const messages: ModelMessage[] = [
-    { role: "system", content: SYSTEM_PROMPT },
-    { role: "user", content: input },
-  ];
+  const turns: ModelMessage[][] = [];
+  let summary = "";
 
   let step = 0;
   while (step < MAX_STEPS) {
-    const turn = await DBOS.runStep(() => modelTurn(workflowId, messages), {
-      name: `model-${step}`,
-    });
-    messages.push(...turn.responseMessages);
+    // 1. Compact: while the recent window is over budget, peel the oldest turns
+    //    into the running summary (keeping at least the last turn verbatim).
+    if (estimateTokens(turns.flat()) > MAX_CONTEXT_TOKENS) {
+      const old: ModelMessage[][] = [];
+      while (turns.length > 1 && estimateTokens(turns.flat()) > KEEP_CONTEXT_TOKENS) {
+        const oldest = turns.shift();
+        if (oldest) old.push(oldest);
+      }
+      if (old.length > 0) {
+        summary = await DBOS.runStep(() => summarize(old, summary), { name: `summarize-${step}` });
+        const contextTokens = estimateTokens(buildContext(input, summary, turns));
+        await DBOS.runStep(
+          () =>
+            emit({
+              type: EventType.MemoryCompacted,
+              workflowId,
+              summarizedTurns: old.length,
+              contextTokens,
+              summary,
+            }),
+          { name: `compacted-${step}` },
+        );
+      }
+    }
+
+    // 2 + 3. Hydrate the context and run one turn over it.
+    const context = buildContext(input, summary, turns);
+    const turn = await DBOS.runStep(() => modelTurn(workflowId, context), { name: `model-${step}` });
+
+    const turnMessages: ModelMessage[] = [...turn.responseMessages];
 
     if (turn.toolCalls.length === 0) {
       await DBOS.runStep(
@@ -109,8 +130,7 @@ async function agentWorkflow(input: string): Promise<string> {
       const output = await DBOS.runStep(() => toolStep(workflowId, call), {
         name: `tool-${call.toolCallId}`,
       });
-      // Feed the tool result back to the model on the next turn.
-      messages.push({
+      turnMessages.push({
         role: "tool",
         content: [
           {
@@ -123,6 +143,7 @@ async function agentWorkflow(input: string): Promise<string> {
       });
     }
 
+    turns.push(turnMessages);
     step++;
   }
 
@@ -138,8 +159,6 @@ async function agentWorkflow(input: string): Promise<string> {
   return "";
 }
 
-// Register the workflow with DBOS. `runAgentWorkflow` is the durable, recoverable
-// version of Lesson 1's `runAgent`.
 export const runAgentWorkflow = DBOS.registerWorkflow(agentWorkflow, {
   name: "agentWorkflow",
 });
```

### 3. `harness/system-prompt.ts`: a multi-item task

Memory only matters when the session is long, so we grow the agent's job. It now handles a list of
work items one at a time, and the `SAMPLE_TASK` ships with five of them (enough to trigger
compaction). Replace `harness/system-prompt.ts` with:

```diff
@@ -11,10 +11,14 @@ For each work item:
 3. Draft a reply with draftReply, using anything runCode computed.
 4. Send the reply with sendReply.
 
-Work through every item, then briefly summarize what you did.`;
+Handle the items one at a time — finish all four steps for an item before
+starting the next. When every item is done, briefly summarize what you did.`;
 
 // A sample task to try. The billing item
 // is the one that pushes the agent into Code Mode.
 export const SAMPLE_TASK = `Handle these work items:
 - item-1 (billing): Customer cus_88121 says they were charged twice. Find the duplicate charge and tell them the exact refund amount (in dollars).
-- item-2 (bug_report): "The export button fails on Safari."`;
+- item-2 (bug_report): "The export button fails on Safari."
+- item-3 (sales): "Can you send pricing for 50 seats?"
+- item-4 (technical): "I can't log in after resetting my password."
+- item-5 (billing): "When will my refund post?"`;
```

### 4. Reset the durable log: wire up the inspector's **Clear** button

Long sessions need a reset. The inspector already ships a **Clear** button (the eraser icon), now
give it a backend. Memory you can't wipe isn't memory you control, so add a `clearEventLog()` to
`harness/db.ts` that truncates the durable log. Update `harness/db.ts` (the new function goes at the bottom):

```diff
@@ -31,3 +31,9 @@ export async function ensureSchema(): Promise<void> {
     )
   `;
 }
+
+// Wipe the durable log (the "Clear" button in the inspector). Wired up in the
+// memory lesson.
+export async function clearEventLog(): Promise<void> {
+  await client`TRUNCATE event_log`;
+}
```

Then expose it as a route. The inspector (`:5173`) and the server (`:8787`) are on different ports,
so the browser's `fetch` is cross-origin. We add one permissive CORS header so the call goes
through. Update `server/index.ts`:

```diff
@@ -5,7 +5,7 @@ import { DBOS } from "@dbos-inc/dbos-sdk";
 import express from "express";
 import { createServer } from "node:http";
 import { WebSocketServer, type WebSocket } from "ws";
-import { ensureSchema } from "../harness/db";
+import { ensureSchema, clearEventLog } from "../harness/db";
 import { subscribe, history } from "../harness/bus";
 import { runAgentWorkflow } from "../harness/runtime";
 import type { ClientMessage } from "@shared/events";
@@ -13,24 +13,31 @@ import type { ClientMessage } from "@shared/events";
 const PORT = Number(process.env.PORT ?? 8787);
 
 async function main() {
-  // Make sure the durable event log exists.
   await ensureSchema();
 
-  // Point DBOS at the same Postgres database for its checkpoint store, then
-  // launch it. launch() ALSO recovers any workflows that were mid-flight when
-  // the process last died, resuming them from their last completed step.
+  // Point DBOS at the same Postgres for its checkpoint store, then launch it.
+  // launch() ALSO recovers any workflows that were mid-flight when the process
+  // last died, resuming each from its last completed step.
   DBOS.setConfig({ name: "harness", systemDatabaseUrl: process.env.DATABASE_URL });
   await DBOS.launch();
 
   const app = express();
-  app.get("/health", (_req, res) => {
+  app.use((_req, res, next) => {
+    res.setHeader("Access-Control-Allow-Origin", "*"); // inspector runs on a different port
+    next();
+  });
+  app.get("/health", (_req, res) => res.json({ ok: true }));
+
+  // Clear the durable log. The inspector calls this, then reloads.
+  app.post("/api/clear", async (_req, res) => {
+    await clearEventLog();
     res.json({ ok: true });
   });
 
   const server = createServer(app);
   const wss = new WebSocketServer({ server, path: "/ws" });
 
-  // Broadcast every emitted event to all connected inspectors.
+  // Forward every emitted event to all connected inspectors.
   subscribe((event) => {
     const data = JSON.stringify(event);
     for (const client of wss.clients) {
@@ -39,27 +46,22 @@ async function main() {
   });
 
   wss.on("connection", async (socket: WebSocket) => {
-    // Register the message handler FIRST. history() is now an async DB read, and
-    // the client sends submit_task the instant it connects — if we awaited
-    // history() before attaching this listener, that first message would be lost.
+    // Register the message handler FIRST — history() is an async DB read, and the
+    // client sends as soon as it connects.
     socket.on("message", async (raw) => {
       let message: ClientMessage;
       try {
         message = JSON.parse(raw.toString());
       } catch {
-        return; // ignore anything that isn't valid JSON
+        return;
       }
 
       if (message.type === "submit_task") {
-        // Start the durable workflow in the background. It reports progress via
-        // the event stream; we don't wait for the result here.
         await DBOS.startWorkflow(runAgentWorkflow)(message.input);
       }
     });
 
-    // Replay the DURABLE timeline so a fresh inspector shows everything —
-    // including work that happened before a crash, and a workflow DBOS is
-    // currently recovering.
+    // Replay the durable timeline (including a workflow DBOS is recovering).
     for (const event of await history()) socket.send(JSON.stringify(event));
   });
```

Now the **Clear** button wipes the durable log and the inspector reloads into a clean session,
handy between demo runs. The agent loop itself is untouched. This is pure operator ergonomics.

## The demo

Submit a multi-item task (the sample task ships with five). As the agent works, watch the
**`memory.compacted`** events fire in the inspector. In our run the context held flat, around
**500 to 730 tokens every turn**, across an 11-tool-call session, instead of growing without bound.
And the agent still finished correctly, because the running summary preserved the facts. Here's a
real one it produced (≈550 tokens of context behind it):

```
Item-1 classified billing. For cus_88121, charges: ch_001 $49.00 2026-05-01 "Pro plan — monthly",
ch_002 $49.00 same, ch_003 $15.00 "Extra seats". Duplicate ch_001/ch_002; refund $49.00. Drafted
draft-item-1 explaining the duplicate and $49 refund, then sent it.
Item-2 classified technical. Drafted draft-item-2 re Safari export bug, sent it.
Item-3 classified sales.
```

The whole history is still in Postgres (Lesson 2). We just stopped *sending* all of it.

> Tuning note: the thresholds are intentionally small so a short task triggers compaction. In
> production you'd set them near the model's real context budget, and you'd likely keep a small
> structured **State** object (per-item status) alongside the prose summary.

## In production

This is the heart of "context engineering." Real systems layer: a sliding window, an LLM
summarization buffer (what we built), a structured state store, and **retrieval** (pull only the
memories relevant to the current step from a vector store). LangGraph and Mastra ship memory
modules, and `mem0` is a dedicated memory layer. The teaching point holds across all of them: **memory
is not one thing.** Separate what's true (State), what happened (History), and what the model
needs right now (Context).
