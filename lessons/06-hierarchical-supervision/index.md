# Supervision

**The pain:** _What happens when sub-agents fail or disagree?_

Same honesty as the last lesson: **you usually don't need this either.** A single agent can work
through a multi-part request serially and do fine. Supervision earns its keep for the reasons you'd
expect, and like every orchestration pattern, **whether it actually makes your agent better depends
on your evals and goals**, not on it being "multi-agent."

When it *does* help:

- **Context isolation.** Each sub-agent investigates in its **own** context window and returns a
  compact result, so the parent isn't drowning in three areas' worth of tool noise.
- **Parallelism.** Independent sub-tasks run concurrently instead of one after another.
- **Synthesis.** Merge the results when they're all back, and survive one coming back broken.

> **Sub-agent vs. handoff (recap).** A handoff (Lesson 5) *transfers control*. Supervision *keeps*
> it: the parent **calls** sub-agents like functions, waits, and synthesizes. Lateral vs.
> hierarchical.

## What the harness adds

A **supervisor** that runs: **plan → dispatch (parallel) → fan-in → synthesize**, reusing the
agent runtime for the sub-agents. Two design choices worth calling out:

- **The plan is a first-class artifact.** Not ephemeral reasoning. It's a structured object the
  supervisor emits (`plan.created`), the inspector renders, the synthesis step reads, and that
  survives a crash in the durable log.
- **It's opt-in.** A **"Supervised"** toggle in the UI picks the supervisor workflow vs. the normal
  single-agent loop, so you can run the same task both ways and judge whether the orchestration
  was worth it.

> Note: this lesson *plans*, it doesn't *gate*. "Plan mode" in the Claude-Code sense (stop and let
> a human approve the plan before executing) is the same durable suspend/resume idea, applied to
> the plan.

## Live code

> Files you already have are shown as a diff: red `-` lines come out, green `+` lines go in, everything else is context you leave alone. New files are shown in full.

### 1. `harness/tools.ts`: export the read data and `searchKB`

The investigators reuse the same canned data and knowledge-base search the main agent uses. The
only change here is making `CHARGES` and `searchKB` `export`ed so `investigators.ts` can import
them.

```diff
@@ -7,7 +7,7 @@ import { runInSandbox, type SandboxApi } from "./sandbox";
 type Charge = { id: string; amount: number; date: string; description: string };
 
 // Note the planted duplicate: ch_001 and ch_002 are the same charge.
-const CHARGES: Record<string, Charge[]> = {
+export const CHARGES: Record<string, Charge[]> = {
   cus_88121: [
     { id: "ch_001", amount: 4900, date: "2026-05-01", description: "Pro plan — monthly" },
     { id: "ch_002", amount: 4900, date: "2026-05-01", description: "Pro plan — monthly" },
@@ -25,7 +25,7 @@ const KNOWLEDGE_BASE: Record<string, string> = {
     "Team plans are $20/seat/mo with a volume discount at 25+ seats. For 50+ seats, send the pricing PDF.",
 };
 
-function searchKB(query: string): string[] {
+export function searchKB(query: string): string[] {
   const q = query.toLowerCase();
   const hits = Object.entries(KNOWLEDGE_BASE)
     .filter(([key]) => q.includes(key))
```

### 2. `harness/investigators.ts`: read-only sub-agents

Sub-agents are lightweight investigators. Their tools have `execute`, so the AI SDK runs the tool
loop inline and each sub-agent is **one bounded interaction** we can run as a single durable step.
It's read-only, so it's safe to re-run. The `CHAOS_FAIL` hook lets us crash one investigator on
demand for the graceful-degradation demo.

```ts
import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { z } from "zod";
import { model } from "./model";
import { CHARGES, searchKB } from "./tools";

// Sub-agents are read-only INVESTIGATORS. Their tools have `execute`, so the AI
// SDK runs the tool loop inline and each sub-agent is one bounded interaction we
// can run as a single durable step. Read-only → a re-run on recovery is safe.
const getCharges = tool({
  description: "Look up a customer's charges.",
  inputSchema: z.object({ customerId: z.string() }),
  execute: async ({ customerId }) => CHARGES[customerId] ?? [],
});

const searchKnowledgeBase = tool({
  description: "Search the support knowledge base.",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => searchKB(query),
});

type Investigator = { systemPrompt: string; tools: ToolSet };

const INVESTIGATORS: Record<string, Investigator> = {
  billing: {
    systemPrompt:
      "You are a billing investigator. Use getCharges to find duplicate or erroneous charges. Report the charge ids, the amount, and the refund you'd recommend — concisely.",
    tools: { getCharges },
  },
  technical: {
    systemPrompt:
      "You are a technical investigator. Use searchKnowledgeBase to find known bugs and workarounds. Report the issue, any ticket, and the workaround — concisely.",
    tools: { searchKnowledgeBase },
  },
  sales: {
    systemPrompt:
      "You are a sales investigator. Use searchKnowledgeBase for pricing guidance, then state the relevant numbers and next step — concisely.",
    tools: { searchKnowledgeBase },
  },
};

// Run one investigator over its objective in its OWN context. Returns findings.
export async function runInvestigator(agent: string, objective: string): Promise<string> {
  // A chaos hook so the failure-handling demo is reproducible:
  // CHAOS_FAIL=technical npm run dev  → the technical investigator always fails.
  if (process.env.CHAOS_FAIL === agent) {
    throw new Error(`investigator '${agent}' crashed (CHAOS_FAIL)`);
  }

  const investigator = INVESTIGATORS[agent];
  if (!investigator) throw new Error(`unknown investigator: ${agent}`);

  const { text } = await generateText({
    model,
    system: investigator.systemPrompt,
    prompt: objective,
    tools: investigator.tools,
    stopWhen: stepCountIs(5),
  });
  return text;
}
```

### 3. `harness/supervisor.ts`: plan, dispatch, fan in, synthesize

The supervisor runs four phases. `makePlan` decomposes the task into a structured plan.
`Promise.allSettled` over `DBOS.runStep` dispatches the investigators concurrently as durable
steps. The fan-in loop keeps the successes and records the failures. And `synthesize` merges the
surviving findings into one reply.

```ts
import { DBOS } from "@dbos-inc/dbos-sdk";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { EventType } from "@shared/events";
import { emit } from "./bus";
import { model } from "./model";
import { runInvestigator } from "./investigators";

// The PLAN is a first-class artifact: a structured object the supervisor emits,
// the inspector renders, the synthesis step reads, and that survives a crash.
const PlanSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string().describe("short id, e.g. 'billing'"),
      agent: z.enum(["billing", "technical", "sales"]),
      objective: z.string().describe("what this investigator should find out"),
    }),
  ),
});
type Plan = z.infer<typeof PlanSchema>;

async function makePlan(task: string): Promise<Plan> {
  const { object } = await generateObject({
    model,
    schema: PlanSchema,
    system:
      "Decompose a customer escalation into independent sub-tasks — one per area the message actually raises (billing / technical / sales). Only include relevant areas.",
    prompt: task,
  });
  return object;
}

async function synthesize(
  task: string,
  findings: { agent: string; findings: string }[],
): Promise<string> {
  const { text } = await generateText({
    model,
    system:
      "You are a support lead. Using your investigators' findings, write ONE clear, friendly reply to the customer that addresses every point they raised. If an area's investigation is missing, acknowledge it briefly and say you'll follow up.",
    prompt: `Customer escalation:\n${task}\n\nInvestigator findings:\n${
      findings.map((f) => `[${f.agent}] ${f.findings}`).join("\n\n") || "(none)"
    }`,
  });
  return text;
}

// THE SUPERVISOR. Plan → dispatch sub-agents in parallel → fan in → synthesize.
// Unlike a handoff, the supervisor keeps control the whole time.
async function supervisorWorkflow(task: string): Promise<string> {
  const workflowId = DBOS.workflowID ?? "unknown";
  await DBOS.runStep(
    () => emit({ type: EventType.WorkflowStarted, workflowId, input: task }),
    { name: "started" },
  );

  // PLAN.
  const plan = await DBOS.runStep(() => makePlan(task), { name: "plan" });
  await DBOS.runStep(
    () => emit({ type: EventType.PlanCreated, workflowId, steps: plan.steps }),
    { name: "plan-emit" },
  );

  // DISPATCH — every sub-agent runs in parallel, each in its own context window.
  const settled = await Promise.allSettled(
    plan.steps.map((s) =>
      DBOS.runStep(
        async () => {
          await emit({
            type: EventType.SubagentStarted,
            workflowId,
            stepId: s.id,
            agent: s.agent,
            objective: s.objective,
          });
          const findings = await runInvestigator(s.agent, s.objective);
          await emit({
            type: EventType.SubagentCompleted,
            workflowId,
            stepId: s.id,
            agent: s.agent,
            findings,
          });
          return { agent: s.agent, findings };
        },
        { name: `subagent-${s.id}` },
      ),
    ),
  );

  // FAN-IN — collect successes, record failures, and keep going (degrade).
  const findings: { agent: string; findings: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const step = plan.steps[i];
    if (result.status === "fulfilled") {
      findings.push(result.value);
    } else {
      await DBOS.runStep(
        () =>
          emit({
            type: EventType.SubagentFailed,
            workflowId,
            stepId: step.id,
            agent: step.agent,
            error: String(result.reason),
          }),
        { name: `subagent-failed-${step.id}` },
      );
    }
  }

  // SYNTHESIZE.
  const reply = await DBOS.runStep(() => synthesize(task, findings), { name: "synthesize" });
  await DBOS.runStep(
    () => emit({ type: EventType.ModelCompleted, workflowId, text: reply }),
    { name: "synth" },
  );
  await DBOS.runStep(
    () => emit({ type: EventType.WorkflowCompleted, workflowId, output: reply }),
    { name: "completed" },
  );
  return reply;
}

export const runSupervisorWorkflow = DBOS.registerWorkflow(supervisorWorkflow, {
  name: "supervisorWorkflow",
});
```

`Promise.allSettled` over `DBOS.runStep` is the whole trick. The sub-agents run **concurrently** as
durable steps, and a thrown one becomes a `rejected` we handle. It never takes the supervisor down.

### 4. `server/index.ts`: route supervised mode

The server picks the runtime from `message.mode`. `"supervised"` runs the supervisor, anything else
runs the normal single-agent loop. That's the only change in this file. The CORS header and the
`POST /api/clear` route already landed in the memory lesson; here we just thread `mode` through.

```diff
@@ -8,6 +8,7 @@ import { WebSocketServer, type WebSocket } from "ws";
 import { ensureSchema, clearEventLog } from "../harness/db";
 import { subscribe, history } from "../harness/bus";
 import { runAgentWorkflow } from "../harness/runtime";
+import { runSupervisorWorkflow } from "../harness/supervisor";
 import type { ClientMessage } from "@shared/events";
 
 const PORT = Number(process.env.PORT ?? 8787);
@@ -57,7 +58,10 @@ async function main() {
       }
 
       if (message.type === "submit_task") {
-        await DBOS.startWorkflow(runAgentWorkflow)(message.input);
+        // Pick the runtime: the single-agent loop, or the supervisor.
+        const workflow =
+          message.mode === "supervised" ? runSupervisorWorkflow : runAgentWorkflow;
+        await DBOS.startWorkflow(workflow)(message.input);
       }
     });
```

> **No `shared/events.ts` or UI work.** The `plan.created` and `subagent.*` event types and the
> client `mode` field already ship in `shared/events.ts`, so we just emit them. And the prebuilt
> inspector already renders the plan and sub-agent events, and its **"Supervised"** toggle already
> sends `mode: "supervised"`. You write zero UI code.

## The demo

Tick **Supervised** and submit a multi-area escalation. _"Customer cus_88121: double-charged, the
export feature is broken in Safari, and they want 50-seat pricing."_

```
PLAN: billing, technical, sales        # the first-class plan artifact
  started technical                    # all three fire together — parallel
  started sales
  started billing
  ✓ billing : duplicate ch_001/ch_002, refund $49.00
  ✓ sales   : 50 seats, Team plan pricing + PDF
  ✓ technical: Safari export bug TICKET-4412, workaround Chrome
→ one synthesized reply covering all three
```

Then run it again with the chaos hook to see graceful degradation:

```bash
CHAOS_FAIL=technical npm run dev
```

```
  ✓ billing
  ✓ sales
  ✗ technical FAILED
status: workflow.completed             # the supervisor did NOT crash
→ reply still covers billing + sales, and acknowledges the export issue
```

And flip the toggle **off** to run the same task through the single agent. That's the honest
comparison.

## In production

This is the **orchestrator-worker** pattern (Anthropic's term); LangGraph ships supervisor graphs,
CrewAI ships crews. For real scale you'd run sub-agents as **durable child workflows on a queue**
(bounded concurrency, independent retries) rather than parallel steps. But the shape is exactly
what you built: plan, fan out, fan in, synthesize, and survive partial failure. The lesson, again:
reach for it when sub-tasks are independent and your evals say it helps, not by default.
