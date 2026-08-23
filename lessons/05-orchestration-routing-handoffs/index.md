# Routing & Handoffs

**The pain:** _What happens when one agent handles every kind of task?_

Here's the honest answer most "multi-agent" content skips: usually, nothing bad. Our single
triage agent already handles billing, technical, and sales fine. You've watched it do it. A capable
model with good tools is a generalist, and reaching for "agent swarms" is, more often than not,
over-engineering. So before this lesson teaches you handoffs, let me tell you that you probably
don't need them.

## When a handoff actually earns its keep

It's not about "the agent isn't smart enough." A handoff is worth it when another agent is a
genuinely *different thing*:

- **Least privilege.** A specialist has a capability the generalist *shouldn't* have. Our triage
  agent can explain a refund, but it must not be able to *issue* one. `issueRefund` moves real
  money. Isolate that power in a billing agent and hand off to it.
- **Different guardrails, policy, or model.** The specialist runs a stricter prompt (and,
  optionally, a human-approval gate).
- **Separate ownership.** The billing agent is plausibly built and run by the finance team, used by
  other systems too. You delegate to it rather than reimplementing it.

> **Handoff vs. sub-agent.** A *handoff* (this lesson) transfers **control**: triage hands the
> conversation to billing, and billing takes over. A *sub-agent* is the
> opposite: a parent **calls** a sub-agent like a tool and keeps control, synthesizing the result.
> Lateral transfer vs. hierarchical delegation. The course does both.

## What the harness adds

To run more than one agent, factor the loop so it runs an **`Agent` definition** instead of a
hardcoded prompt + tools. The harness becomes a general agent *runtime*, and a handoff is just
"switch which agent the loop is running, keep the conversation."

## Live code

> Files you already have are shown as a diff: red `-` lines come out, green `+` lines go in, everything else is context you leave alone. New files are shown in full.

### 1. `harness/agents.ts`: an agent is data

An agent is just a name, a system prompt, and the subset of tools it's allowed to use. The runtime
runs **any** agent through the same durable loop, so adding the billing specialist is pure data. No
new machinery. Note what triage does **not** have: `issueRefund`. It can talk about a refund, but it
can't move money, which is the whole reason it hands off.

```ts
import type { ToolSet } from "ai";
import { tools } from "./tools";

// An agent is just a name, a system prompt, and the subset of tools it's allowed
// to use. The runtime runs ANY agent through the same durable loop — so adding a
// specialist is data, not new machinery.
export type Agent = {
  name: string;
  systemPrompt: string;
  tools: ToolSet;
};

// The generalist. Note what it does NOT have: issueRefund. It can talk about a
// refund, but it isn't allowed to move money — that's the whole reason it hands
// off.
export const triageAgent: Agent = {
  name: "triage",
  systemPrompt: `You are a support triage agent.

For each work item:
1. Classify it with classifyItem.
2. If it needs data lookup or math, use runCode (you have tools.getCharges and tools.searchKnowledgeBase inside it).
3. Draft a reply with draftReply, then send it with sendReply.

IMPORTANT: you are NOT allowed to issue refunds. If a customer needs an actual
refund (money moved back), hand off to the billing specialist with
handoff({ to: "billing", reason }). Do not draft or send anything yourself in
that case — let billing take over.

Handle the items, then briefly summarize what you did.`,
  tools: {
    classifyItem: tools.classifyItem,
    runCode: tools.runCode,
    draftReply: tools.draftReply,
    sendReply: tools.sendReply,
    handoff: tools.handoff,
  },
};

// The specialist. It has the privileged issueRefund tool and a stricter policy.
// Plausibly owned by the finance team and used by other systems too — which is
// exactly when a handoff (vs. just adding a tool) is worth it.
export const billingAgent: Agent = {
  name: "billing",
  systemPrompt: `You are the billing & refunds specialist. You can issue refunds —
issueRefund is IRREVERSIBLE and moves real money, so be careful.

For a refund request:
1. Use runCode (tools.getCharges) to verify the duplicate charge and the exact amount.
2. Issue the refund with issueRefund (customerId, chargeId, amountCents).
3. Draft and send a confirmation with draftReply + sendReply.

Then briefly summarize what you did.`,
  tools: {
    runCode: tools.runCode,
    issueRefund: tools.issueRefund,
    draftReply: tools.draftReply,
    sendReply: tools.sendReply,
  },
};

export const agents: Record<string, Agent> = {
  triage: triageAgent,
  billing: billingAgent,
};
```

### 2. `harness/tools.ts`: the privileged tool plus the handoff tool

Add two schemas to the `tools` object: the privileged `issueRefund` (only billing gets it) and the
special `handoff`. Then add a `case "issueRefund"` to `runTool`. `runTool` handles `issueRefund` like any
other side-effecting tool. It does **not** handle `handoff`. That one gets intercepted by the runtime, which
switches the running agent instead of executing a tool. Here's the full file:

```diff
@@ -75,6 +75,24 @@ export const tools = {
     description: "Send the drafted reply to the customer. This really emails them.",
     inputSchema: z.object({ itemId: z.string(), draftId: z.string() }),
   }),
+
+  // Privileged: only the billing specialist gets this. Moves real money.
+  issueRefund: tool({
+    description: "Issue a refund to the customer. IRREVERSIBLE — this moves real money.",
+    inputSchema: z.object({
+      customerId: z.string(),
+      chargeId: z.string(),
+      amountCents: z.number(),
+    }),
+  }),
+
+  // Hand the conversation to a specialist agent. The harness intercepts this —
+  // it switches the running agent rather than executing a tool.
+  handoff: tool({
+    description:
+      "Hand off the conversation to a specialist agent when the task needs a capability you don't have (e.g. issuing a refund → billing).",
+    inputSchema: z.object({ to: z.enum(["billing"]), reason: z.string() }),
+  }),
 };
 
 // ── The harness-owned executor ──────────────────────────────────────────────
@@ -98,6 +116,13 @@ export async function runTool(
       return { ok: true, draftId: `draft-${args.itemId}` };
     case "sendReply":
       return { sent: true, itemId: args.itemId, draftId: args.draftId };
+    case "issueRefund":
+      return {
+        refunded: true,
+        customerId: args.customerId,
+        chargeId: args.chargeId,
+        amountCents: args.amountCents,
+      };
     default:
       throw new Error(`unknown tool: ${name}`);
   }
```

### 3. `harness/system-prompt.ts`: prompts move out, a sample task stays

The agent prompts now live in `agents.ts` (one per agent), so this file shrinks to a single sample
task to try:

```diff
@@ -1,24 +1,6 @@
-// What the agent is told to do. Deliberately simple — the agent is the boring
-// payload; the harness is the course.
-export const SYSTEM_PROMPT = `You are a support triage agent.
-
-For each work item:
-1. Classify it with classifyItem.
-2. If the item needs data lookup or math (e.g. a billing dispute), write a
-   program with runCode to fetch and analyze the data — don't try to do the
-   arithmetic in your head. Inside runCode you can call tools.getCharges and
-   tools.searchKnowledgeBase.
-3. Draft a reply with draftReply, using anything runCode computed.
-4. Send the reply with sendReply.
-
-Handle the items one at a time — finish all four steps for an item before
-starting the next. When every item is done, briefly summarize what you did.`;
-
-// A sample task to try. The billing item
-// is the one that pushes the agent into Code Mode.
-export const SAMPLE_TASK = `Handle these work items:
-- item-1 (billing): Customer cus_88121 says they were charged twice. Find the duplicate charge and tell them the exact refund amount (in dollars).
-- item-2 (bug_report): "The export button fails on Safari."
-- item-3 (sales): "Can you send pricing for 50 seats?"
-- item-4 (technical): "I can't log in after resetting my password."
-- item-5 (billing): "When will my refund post?"`;
+// Agent prompts now live in agents.ts (one per agent). This file just holds a
+// sample task to try.
+//
+// A single refund request: triage will recognize it can't issue refunds and
+// hand off to the billing specialist.
+export const SAMPLE_TASK = `Customer cus_88121 says they were charged twice and wants the duplicate charge refunded. Sort it out.`;
```

### 4. `harness/memory.ts`: `buildContext` takes the current agent's prompt

`buildContext` no longer reads a single hardcoded `SYSTEM_PROMPT`; it takes a `systemPrompt`
parameter so the runtime can hydrate context for whichever agent is currently driving. The full file:

```diff
@@ -1,7 +1,6 @@
 import { generateText } from "ai";
 import type { ModelMessage } from "ai";
 import { model } from "./model";
-import { SYSTEM_PROMPT } from "./system-prompt";
 
 // Compact once the recent-turns window grows past MAX_CONTEXT_TOKENS, peeling
 // the oldest turns into the summary until it's back under KEEP_CONTEXT_TOKENS.
@@ -28,12 +27,13 @@ export function estimateTokens(messages: ModelMessage[]): number {
 // buildContext hydrates the context: the system prompt, the pinned task, the
 // summary of old work, and only the most recent turns verbatim.
 export function buildContext(
+  systemPrompt: string,
   task: string,
   summary: string,
   turns: ModelMessage[][],
 ): ModelMessage[] {
   const context: ModelMessage[] = [
-    { role: "system", content: SYSTEM_PROMPT },
+    { role: "system", content: systemPrompt }, // the CURRENT agent's prompt
     { role: "user", content: task }, // the goal is pinned, never summarized away
   ];
   if (summary) {
```

### 5. The `agent.handoff` event

No change to `shared/events.ts`. It ships complete on every branch and already defines
`EventType.AgentHandoff` (`from`/`to`/`reason`). The runtime just **emits** it when a handoff
happens, and the inspector renders it as a divider in the chat pane so you can see the transfer.

### 6. `harness/runtime.ts`: run the current agent, intercept handoff

The loop now carries `currentAgent` (starting at triage), runs **its** prompt and tools, and treats
`handoff` specially. Instead of executing it as a tool, the harness emits an `AgentHandoff` event and
swaps `currentAgent`, keeping the conversation. `currentAgent` is rebuilt deterministically on
recovery (the handoff is a consequence of a cached model decision), so this composes with Lesson 2's
durability for free. The `toolResultMessage` helper (used both for normal tools and the synthetic
handoff result) lives here too. The full file:

```diff
@@ -1,10 +1,11 @@
 import { DBOS } from "@dbos-inc/dbos-sdk";
 import { streamText } from "ai";
-import type { ModelMessage, JSONValue } from "ai";
+import type { ModelMessage, JSONValue, ToolSet } from "ai";
 import { EventType } from "@shared/events";
 import { emit } from "./bus";
 import { model } from "./model";
-import { tools, runTool } from "./tools";
+import { runTool } from "./tools";
+import { triageAgent, agents } from "./agents";
 import {
   buildContext,
   summarize,
@@ -13,17 +14,18 @@ import {
   KEEP_CONTEXT_TOKENS,
 } from "./memory";
 
-// A safety cap so a confused model can't loop forever. Higher than Lesson 1 now
-// that one task can span many items (and therefore many turns).
 const MAX_STEPS = 30;
 
 type ToolCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };
 type Turn = { text: string; toolCalls: ToolCall[]; responseMessages: ModelMessage[] };
 
-// One model turn over the HYDRATED context (not the whole history). Run as a
-// DBOS step so a completed turn is checkpointed and never re-billed.
-async function modelTurn(workflowId: string, context: ModelMessage[]): Promise<Turn> {
-  const result = streamText({ model, messages: context, tools });
+// One model turn over the hydrated context, using the CURRENT agent's tools.
+async function modelTurn(
+  workflowId: string,
+  context: ModelMessage[],
+  agentTools: ToolSet,
+): Promise<Turn> {
+  const result = streamText({ model, messages: context, tools: agentTools });
 
   for await (const part of result.fullStream) {
     if (part.type === "text-delta") {
@@ -62,15 +64,24 @@ async function toolStep(workflowId: string, call: ToolCall): Promise<Record<stri
   return output;
 }
 
-// THE DURABLE AGENT LOOP, now with bounded memory.
+function toolResultMessage(call: ToolCall, value: JSONValue): ModelMessage {
+  return {
+    role: "tool",
+    content: [
+      { type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "json", value } },
+    ],
+  };
+}
+
+// THE DURABLE AGENT LOOP — now a general RUNTIME that runs any agent.
 //
-// We keep the conversation as a list of TURNS. Each pass:
-//   1. if we have too many turns, compact the oldest into a running summary
-//   2. hydrate the context (system + task + summary + recent turns)
-//   3. run one model turn over THAT context — not the whole history
+// The loop is identical to before, with two additions:
+//   · it runs the CURRENT agent's prompt + tools (start: triage)
+//   · the `handoff` tool isn't executed — the harness intercepts it and SWITCHES
+//     the running agent, keeping the conversation. Control transfers laterally.
 //
-// So the tokens we send stay roughly flat no matter how long the task runs. The
-// full history still lives, durably, in the Postgres event log.
+// `currentAgent` is rebuilt deterministically on recovery (the handoff is a
+// consequence of a cached model decision), so this composes with durability.
 async function agentWorkflow(input: string): Promise<string> {
   const workflowId = DBOS.workflowID ?? "unknown";
   await DBOS.runStep(
@@ -78,13 +89,13 @@ async function agentWorkflow(input: string): Promise<string> {
     { name: "started" },
   );
 
+  let currentAgent = triageAgent;
   const turns: ModelMessage[][] = [];
   let summary = "";
 
   let step = 0;
   while (step < MAX_STEPS) {
-    // 1. Compact: while the recent window is over budget, peel the oldest turns
-    //    into the running summary (keeping at least the last turn verbatim).
+    // 1. Compact old turns once the window is over budget.
     if (estimateTokens(turns.flat()) > MAX_CONTEXT_TOKENS) {
       const old: ModelMessage[][] = [];
       while (turns.length > 1 && estimateTokens(turns.flat()) > KEEP_CONTEXT_TOKENS) {
@@ -93,7 +104,9 @@ async function agentWorkflow(input: string): Promise<string> {
       }
       if (old.length > 0) {
         summary = await DBOS.runStep(() => summarize(old, summary), { name: `summarize-${step}` });
-        const contextTokens = estimateTokens(buildContext(input, summary, turns));
+        const contextTokens = estimateTokens(
+          buildContext(currentAgent.systemPrompt, input, summary, turns),
+        );
         await DBOS.runStep(
           () =>
             emit({
@@ -108,9 +121,11 @@ async function agentWorkflow(input: string): Promise<string> {
       }
     }
 
-    // 2 + 3. Hydrate the context and run one turn over it.
-    const context = buildContext(input, summary, turns);
-    const turn = await DBOS.runStep(() => modelTurn(workflowId, context), { name: `model-${step}` });
+    // 2 + 3. Hydrate the CURRENT agent's context and run one turn over it.
+    const context = buildContext(currentAgent.systemPrompt, input, summary, turns);
+    const turn = await DBOS.runStep(() => modelTurn(workflowId, context, currentAgent.tools), {
+      name: `model-${step}`,
+    });
 
     const turnMessages: ModelMessage[] = [...turn.responseMessages];
 
@@ -127,20 +142,23 @@ async function agentWorkflow(input: string): Promise<string> {
     }
 
     for (const call of turn.toolCalls) {
-      const output = await DBOS.runStep(() => toolStep(workflowId, call), {
-        name: `tool-${call.toolCallId}`,
-      });
-      turnMessages.push({
-        role: "tool",
-        content: [
-          {
-            type: "tool-result",
-            toolCallId: call.toolCallId,
-            toolName: call.toolName,
-            output: { type: "json", value: output as JSONValue },
-          },
-        ],
-      });
+      if (call.toolName === "handoff") {
+        // The harness intercepts handoff: switch the running agent, don't run a tool.
+        const to = String(call.input.to ?? "");
+        const reason = String(call.input.reason ?? "");
+        const from = currentAgent.name;
+        await DBOS.runStep(
+          () => emit({ type: EventType.AgentHandoff, workflowId, from, to, reason }),
+          { name: `handoff-${call.toolCallId}` },
+        );
+        currentAgent = agents[to] ?? currentAgent;
+        turnMessages.push(toolResultMessage(call, { ok: true, handedOffTo: to }));
+      } else {
+        const output = await DBOS.runStep(() => toolStep(workflowId, call), {
+          name: `tool-${call.toolCallId}`,
+        });
+        turnMessages.push(toolResultMessage(call, output as JSONValue));
+      }
     }
 
     turns.push(turnMessages);
```

## The demo

Submit a refund: _"Customer cus_88121 was charged twice and wants the duplicate refunded."_ Watch
the trace. This is verbatim from our run:

```
triage:  classifyItem
triage:  runCode            # finds the duplicate ch_001/ch_002, $49.00
↪ HANDOFF triage → billing  # "refund action is required, which must be handled by billing"
billing: runCode            # independently re-verifies the duplicate
billing: issueRefund        # { customerId: cus_88121, chargeId: ch_002, amountCents: 4900 }
billing: draftReply → sendReply
```

Triage never touches `issueRefund`. It doesn't have it. It recognizes the boundary and hands the
conversation to the agent that's *allowed* to cross it, which re-verifies and acts. The chat pane
shows the `↪ handed off triage → billing` divider so the user knows who's driving.

## In production

Our agents are in-process, so a handoff is just swapping an object. When the specialist lives on
another server or is owned by another team, you reach for a protocol: **A2A** (Agent2Agent) or
MCP-style remote tools/agents. Framework handoffs look just like ours. The OpenAI Agents SDK and
LangGraph model a handoff as a tool the model calls that swaps the active agent. The teaching point
holds: routing is a control-plane decision, and a handoff is a typed transfer of control. Reach
for it for isolation and ownership, not because one agent "can't cope."
