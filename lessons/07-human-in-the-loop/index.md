# Human-in-the-Loop

**The pain:** _What happens when an agent needs approval tomorrow?_

This is where the whole day comes together. Back in Lesson 5 we gave the billing agent `issueRefund`,
a privileged, **irreversible** tool that moves real money. Right now it just runs. In production you
want a human to approve a refund first. And the naive version is a disaster:

```ts
const approved = await askUser(); // holds the server open; dies on restart; can't wait days
```

A human might approve in thirty seconds or three days. You can't hold a process open that long, and
if it crashes mid-wait, the whole task is gone. **A human pause has to be a first-class, durable
workflow state**, not a blocked function call.

## What the harness adds

We already have the primitive. It's Lesson 2's durable execution. DBOS workflows can **suspend** on
`DBOS.recv(topic)`: the workflow parks itself in Postgres and the process is free to exit. Then it
**resumes** when someone calls `DBOS.send(workflowId, decision, topic)`, even after a restart, even
days later.

So the harness gates the privileged action. When the agent calls a tool that `NEEDS_APPROVAL`, the
harness emits an `approval.requested` event, **suspends the workflow**, and only runs the tool if a
human approves.

## Live code

> Files you already have are shown as a diff: red `-` lines come out, green `+` lines go in, everything else is context you leave alone. New files are shown in full.

The `approval.requested` / `approval.resolved` event types already live in `shared/events.ts`
(it ships complete on every branch), so we just emit them here.

### 1. `harness/runtime.ts`: gate the privileged tool

In the tool loop we add a third branch alongside `handoff`. We intercept anything in
`NEEDS_APPROVAL`, **suspend** the durable workflow on `DBOS.recv` until a human decides, and then
run or refuse the tool. (We also firm up the handoff tool-result message to the "You are now the
`${to}` specialist…" form so the receiving agent actually takes over.)

```diff
@@ -16,6 +16,11 @@ import {
 
 const MAX_STEPS = 30;
 
+// Tools that require a human's go-ahead before they run. (Just the irreversible
+// one for now — the billing agent's refund.)
+const NEEDS_APPROVAL = new Set(["issueRefund"]);
+const APPROVAL_TIMEOUT_S = 86_400; // up to a day — a human approval is an unbounded wait
+
 type ToolCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };
 type Turn = { text: string; toolCalls: ToolCall[]; responseMessages: ModelMessage[] };
 
@@ -152,7 +157,51 @@ async function agentWorkflow(input: string): Promise<string> {
           { name: `handoff-${call.toolCallId}` },
         );
         currentAgent = agents[to] ?? currentAgent;
-        turnMessages.push(toolResultMessage(call, { ok: true, handedOffTo: to }));
+        turnMessages.push(
+          toolResultMessage(call, {
+            ok: true,
+            message: `You are now the ${to} specialist. Take over and FINISH the task by calling the tools you need — do the work, don't just acknowledge the handoff.`,
+          }),
+        );
+      } else if (NEEDS_APPROVAL.has(call.toolName)) {
+        // HUMAN-IN-THE-LOOP. Ask, then SUSPEND the (durable) workflow until a
+        // human decides. recv() can wait minutes or days — and because the
+        // workflow is durable, the process can crash and resume right here.
+        await DBOS.runStep(
+          () =>
+            emit({
+              type: EventType.ApprovalRequested,
+              workflowId,
+              toolCallId: call.toolCallId,
+              action: call.toolName,
+              args: call.input,
+            }),
+          { name: `approval-req-${call.toolCallId}` },
+        );
+
+        const decision = await DBOS.recv<{ approved: boolean }>("approval", APPROVAL_TIMEOUT_S);
+        const approved = decision?.approved ?? false;
+
+        await DBOS.runStep(
+          () =>
+            emit({ type: EventType.ApprovalResolved, workflowId, toolCallId: call.toolCallId, approved }),
+          { name: `approval-res-${call.toolCallId}` },
+        );
+
+        if (approved) {
+          const output = await DBOS.runStep(() => toolStep(workflowId, call), {
+            name: `tool-${call.toolCallId}`,
+          });
+          turnMessages.push(toolResultMessage(call, output as JSONValue));
+        } else {
+          turnMessages.push(
+            toolResultMessage(call, {
+              approved: false,
+              message:
+                "A human did NOT approve this action. Do not retry — tell the customer it needs manual review.",
+            }),
+          );
+        }
       } else {
         const output = await DBOS.runStep(() => toolStep(workflowId, call), {
           name: `tool-${call.toolCallId}`,
```

`recv` is a durable workflow primitive, not a step. The received message gets checkpointed, so on
recovery the workflow either gets the decision it already received or keeps waiting.

### 2. `harness/agents.ts`: make billing insist on acting

The billing agent kept *describing* a refund instead of calling `issueRefund`. So we rewrite its
system prompt to always act. (The triage agent is unchanged from Lesson 5; here's the full file.)

```diff
@@ -42,15 +42,15 @@ Handle the items, then briefly summarize what you did.`,
 // exactly when a handoff (vs. just adding a tool) is worth it.
 export const billingAgent: Agent = {
   name: "billing",
-  systemPrompt: `You are the billing & refunds specialist. You can issue refunds —
-issueRefund is IRREVERSIBLE and moves real money, so be careful.
+  systemPrompt: `You are the billing & refunds specialist. issueRefund is
+IRREVERSIBLE and moves real money, so be careful — but it IS your job.
 
-For a refund request:
+When a refund is needed, ALWAYS do all of this — never just describe it:
 1. Use runCode (tools.getCharges) to verify the duplicate charge and the exact amount.
-2. Issue the refund with issueRefund (customerId, chargeId, amountCents).
+2. Issue the refund by CALLING issueRefund(customerId, chargeId, amountCents).
 3. Draft and send a confirmation with draftReply + sendReply.
 
-Then briefly summarize what you did.`,
+Then briefly summarize what you did. Do not stop after only acknowledging — act.`,
   tools: {
     runCode: tools.runCode,
     issueRefund: tools.issueRefund,
```

### 3. `harness/memory.ts`: tune the compaction budget

So compaction kicks in on a short task, we drop the token thresholds. The rest of the file is unchanged from
Lesson 4, so here it is in full.

```diff
@@ -7,8 +7,8 @@ import { model } from "./model";
 // Token budget — not turn count — is what actually drives context bloat, and it
 // holds up even when the model batches many tool calls into one turn.
 // (Rough estimate: ~4 chars per token. Kept low so compaction kicks in on a short task.)
-export const MAX_CONTEXT_TOKENS = 500;
-export const KEEP_CONTEXT_TOKENS = 200;
+export const MAX_CONTEXT_TOKENS = 3000;
+export const KEEP_CONTEXT_TOKENS = 1500;
 
 export function estimateTokens(messages: ModelMessage[]): number {
   const chars = messages.reduce(
```

### 4. `server/index.ts`: deliver the decision

We add `express.json()`, CORS headers plus an `OPTIONS` preflight (the inspector POSTs from a
different port), and the `POST /api/approve/:workflowId` route that wakes the suspended workflow.
Here's the full file:

```diff
@@ -23,8 +23,12 @@ async function main() {
   await DBOS.launch();
 
   const app = express();
-  app.use((_req, res, next) => {
+  app.use(express.json());
+  app.use((req, res, next) => {
     res.setHeader("Access-Control-Allow-Origin", "*"); // inspector runs on a different port
+    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
+    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
+    if (req.method === "OPTIONS") return res.sendStatus(204);
     next();
   });
   app.get("/health", (_req, res) => res.json({ ok: true }));
@@ -35,6 +39,14 @@ async function main() {
     res.json({ ok: true });
   });
 
+  // Human-in-the-loop: deliver an approval decision to a suspended workflow.
+  // DBOS.send wakes its recv() — even days later, even after a restart.
+  app.post("/api/approve/:workflowId", async (req, res) => {
+    const approved = Boolean(req.body?.approved);
+    await DBOS.send(req.params.workflowId, { approved }, "approval");
+    res.json({ ok: true });
+  });
+
   const server = createServer(app);
   const wss = new WebSocketServer({ server, path: "/ws" });
```

`DBOS.send` writes the message to Postgres and wakes the suspended workflow, even if it's running
on a different process than the one that suspended it.

### The UI

The inspector already ships an approval card (remember, you don't build UI in this course). On
`approval.requested` it shows the pending action with **Approve / Reject** buttons that POST to the
route. On `approval.resolved` it flips to ✓ Approved / ✗ Rejected.

## The demo

Submit a refund: _"Customer cus_88121 was charged twice, refund the duplicate."_ Triage hands off
to billing, billing verifies the duplicate and calls `issueRefund`, and the inspector pops an
**Approval required** card while the workflow **suspends**. Nothing is refunded yet. Click
**Approve** and it resumes and issues the refund. Click **Reject** and it tells the customer it needs
manual review, and no money moves.

Now the part that makes it real. **Kill the server while it's waiting:**

```
classifyItem → HANDOFF → runCode → approval.requested
   ↓ [Ctrl-C — the process is gone]
   ↓ [npm run dev → "Recovering 1 workflows from application version …"]
   ↓ [click Approve]
approval.resolved → issueRefund → draftReply → sendReply → workflow.completed
```

The suspended workflow **survived the crash**, DBOS recovered it on restart, and the approval
(which could have arrived days later) resumed it. `issueRefund` ran *only after* the human said yes.
That's the payoff of Lesson 2's durability, applied to a human.

## In production

Temporal signals, Inngest `waitForEvent`, durable promises, and dedicated HITL layers like
HumanLayer all do this same thing: a human decision as a first-class, durable, resumable workflow
state. (The same primitive gates a **plan** instead of a tool. That's "approve the plan" mode from
Lesson 6.)

---

## You built a harness

Seven lessons, one runtime. Starting from a brittle `while`-loop, you built a small but real agent
harness: an **event log**, **checkpointing and crash-recovery**, **sandboxed code execution**,
**memory & context hydration**, **routing and handoffs**, **supervised parallel sub-agents**, and
**durable human approval**. You don't have *an agent*. You have the **runtime that can run any of
them in production**, plus the judgment to know which of Temporal, Inngest, DBOS, e2b, Firecracker,
LangGraph, Mastra, or A2A you're actually reaching for when you do.
