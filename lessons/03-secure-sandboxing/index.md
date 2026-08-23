# Sandboxed Tools & Code Mode

**The pain:** _What happens when the model asks to run dangerous code?_

The harness is the **security boundary**. The model should never touch the host process directly.
But there's a more interesting reason to care about code execution than "block the bad stuff."
Sometimes the best thing an agent can do *is* write and run code.

## Why the agent should write code at all (Code Mode)

Our agent has been calling tools one at a time. For a billing dispute it would need: look up the
charges → (model reads them) → compare them → (model reads result) → compute the refund →
(model reads result) → … Every intermediate result round-trips *through the model* just to get
copied into the next call. That's slow, it's expensive, and it's right where LLMs are weakest
(multi-step arithmetic over data).

**Code Mode** flips it. Give the model the tools as a typed API and let it write **one program**
that does the whole thing. This is what Cloudflare's
[Code Mode](https://blog.cloudflare.com/code-mode/) and Hugging Face's
[CodeAct / smolagents](https://huggingface.co/papers/2402.01030) found:

- LLMs have seen millions of lines of real code but only contrived tool-call examples. They're
  just **better at writing code**.
- Composing many calls (loops, conditionals, data flow) is natural in code and awkward as a chain
  of tool calls. CodeAct reports **~30% fewer steps** and meaningfully higher success on complex
  tasks.
- The agent writes the orchestration once and only reads back the **final** result.

And here's the catch that lands us right in this lesson: **now you're running model-written code, so
you have to sandbox it.** Code Mode is *why* the sandbox exists. It's not a side feature.

## What the harness adds

- A **sandbox** (`harness/sandbox.ts`). One place model-written code runs, with no host access
  and a timeout. We use `node:vm`, and the notes are honest about its limits.
- A **`runCode` tool**: the agent's "write a program" action.
- A small **read/compute API** exposed *into* the sandbox (`getCharges`, `searchKnowledgeBase`).

Note the split that keeps Lesson 2 intact: the code only calls **read** tools, so a re-run after a
crash is harmless. The **side-effecting** `sendReply` stays a normal durable tool call. It runs
exactly once, and we can gate it later.

And because `runCode` is just another tool, **the durable loop from Lesson 2 doesn't change at
all.** It already dispatches every tool through `runTool`. Code Mode is a sandbox plus two tools plus
a prompt.

## Live code

> Files you already have are shown as a diff: red `-` lines come out, green `+` lines go in, everything else is context you leave alone. New files are shown in full.

### 1. `harness/sandbox.ts`: the boundary

```ts
import vm from "node:vm";

// The harness is the security boundary. When the agent writes code (Code Mode),
// it runs HERE — never with raw access to the process.
//
// This is `node:vm`, which is deliberately minimal:
//   · the context has NO `require`, `process`, `fs`, `fetch`, ... — only what we
//     hand in (a small `tools` API + `console.log`)
//   · the `timeout` option kills runaway SYNCHRONOUS code (e.g. `while(true){}`)
//
// Be honest about the limit: `vm` is NOT a true security sandbox, and its
// timeout can't interrupt async code. That's exactly why production systems run
// untrusted code in a hosted sandbox (e2b, Cloudflare's Sandbox SDK, Fly,
// Vercel, Daytona). The harness's job is to MEDIATE the boundary; the strength
// of the boundary is a deployment choice.

export type SandboxResult =
  | { ok: true; result: unknown; logs: string[] }
  | { ok: false; error: string; logs: string[] };

export type SandboxApi = Record<string, (...args: any[]) => unknown>;

export async function runInSandbox(
  code: string,
  api: SandboxApi,
  opts: { timeoutMs?: number } = {},
): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const logs: string[] = [];

  // The ENTIRE global the code can see. Frozen so the code can't add to it.
  const context = vm.createContext({
    tools: api,
    console: { log: (...args: unknown[]) => logs.push(args.map(String).join(" ")) },
  });

  // Run the model's code as the body of an async function so it can `await`
  // tool calls and `return` a result.
  const wrapped = `(async () => { ${code} })()`;

  try {
    // `timeout` bounds the SYNCHRONOUS portion (a sync infinite loop dies here).
    const pending = vm.runInContext(wrapped, context, { timeout: timeoutMs }) as Promise<unknown>;
    // Backstop for async hangs. (vm can't actually KILL the leaked async work —
    // a real isolate can. We surface a clean error to the model regardless.)
    const result = await withTimeout(pending, timeoutMs);
    return { ok: true, result, logs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), logs };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`execution timed out after ${ms}ms`)), ms),
    ),
  ]);
}
```

### 2. `harness/tools.ts`: the read API, the `runCode` tool, and routing

```diff
@@ -1,16 +1,65 @@
 import { tool } from "ai";
 import { z } from "zod";
+import { runInSandbox, type SandboxApi } from "./sandbox";
 
-// The tool SCHEMAS the model sees. Note there's no `execute` anymore.
+// ── Canned data the read tools serve ────────────────────────────────────────
+
+type Charge = { id: string; amount: number; date: string; description: string };
+
+// Note the planted duplicate: ch_001 and ch_002 are the same charge.
+const CHARGES: Record<string, Charge[]> = {
+  cus_88121: [
+    { id: "ch_001", amount: 4900, date: "2026-05-01", description: "Pro plan — monthly" },
+    { id: "ch_002", amount: 4900, date: "2026-05-01", description: "Pro plan — monthly" },
+    { id: "ch_003", amount: 1500, date: "2026-04-18", description: "Extra seats" },
+  ],
+};
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
+function searchKB(query: string): string[] {
+  const q = query.toLowerCase();
+  const hits = Object.entries(KNOWLEDGE_BASE)
+    .filter(([key]) => q.includes(key))
+    .map(([, article]) => article);
+  return hits.length ? hits : ["No exact match — use your judgment."];
+}
+
+// ── The read/compute API exposed INTO the sandbox (Code Mode) ────────────────
 //
-// In Lesson 1 the AI SDK ran the tools for us. To make tool calls DURABLE we
-// take execution back: the harness runs each tool itself (see `runTool`), so
-// every call can be wrapped in its own DBOS step and run exactly once.
+// When the agent writes code, these are the functions it can call. They're
+// read-only: a re-run (after a crash) is harmless, so the whole runCode step can
+// stay a single durable unit without risking duplicate side effects.
+const sandboxApi: SandboxApi = {
+  getCharges: async (customerId: string) => CHARGES[customerId] ?? [],
+  searchKnowledgeBase: async (query: string) => searchKB(query),
+};
+
+// ── The tool SCHEMAS the model sees ─────────────────────────────────────────
+
 export const tools = {
-  searchKnowledgeBase: tool({
-    description: "Search the support knowledge base for relevant articles.",
-    inputSchema: z.object({ query: z.string().describe("what to look up") }),
+  // Code Mode: instead of chaining a dozen tool calls (each round-tripping
+  // through the model), the agent writes ONE program that fetches and analyzes.
+  runCode: tool({
+    description: [
+      "Run a JavaScript program (an async function body) to fetch and analyze data.",
+      "Available inside the program:",
+      "  • await tools.getCharges(customerId) → [{ id, amount (cents), date, description }]",
+      "  • await tools.searchKnowledgeBase(query) → string[]",
+      "  • console.log(...) for debugging",
+      "Use `return` to return your result (any JSON value).",
+    ].join("\n"),
+    inputSchema: z.object({ code: z.string() }),
   }),
+
   classifyItem: tool({
     description: "Classify a work item into a category.",
     inputSchema: z.object({
@@ -28,31 +77,21 @@ export const tools = {
   }),
 };
 
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
-// The harness-owned executor. No sandbox or approval gate yet, but now that
-// each call runs inside a DBOS step, a finished side effect such as `sendReply`
-// is checkpointed and never repeated after a crash.
+// ── The harness-owned executor ──────────────────────────────────────────────
+//
+// `runCode` is mediated: it never runs in the host process, only in the sandbox.
+// The side-effecting tools (sendReply) still run here as normal durable steps.
 export async function runTool(
   name: string,
   args: Record<string, unknown>,
 ): Promise<Record<string, unknown>> {
   switch (name) {
-    case "searchKnowledgeBase": {
-      const query = String(args.query ?? "").toLowerCase();
-      const hits = Object.entries(KNOWLEDGE_BASE)
-        .filter(([key]) => query.includes(key))
-        .map(([, article]) => article);
-      return { articles: hits.length ? hits : ["No exact match — use your judgment."] };
-    }
+    case "runCode":
+      return runInSandbox(String(args.code ?? ""), sandboxApi);
+    case "getCharges":
+      return { charges: CHARGES[String(args.customerId)] ?? [] };
+    case "searchKnowledgeBase":
+      return { articles: searchKB(String(args.query ?? "")) };
     case "classifyItem":
       return { ok: true, itemId: args.itemId, category: args.category };
     case "draftReply":
```

### 3. `harness/system-prompt.ts`: tell the agent to reach for code

Both exports change. `SYSTEM_PROMPT` now points the agent at `runCode`, and `SAMPLE_TASK`
includes the billing item that pushes it into Code Mode.

```diff
@@ -2,16 +2,19 @@
 // payload; the harness is the course.
 export const SYSTEM_PROMPT = `You are a support triage agent.
 
-For each work item the user gives you:
+For each work item:
 1. Classify it with classifyItem.
-2. Search the knowledge base with searchKnowledgeBase if it helps.
-3. Draft a reply with draftReply.
+2. If the item needs data lookup or math (e.g. a billing dispute), write a
+   program with runCode to fetch and analyze the data — don't try to do the
+   arithmetic in your head. Inside runCode you can call tools.getCharges and
+   tools.searchKnowledgeBase.
+3. Draft a reply with draftReply, using anything runCode computed.
 4. Send the reply with sendReply.
 
 Work through every item, then briefly summarize what you did.`;
 
-// A sample task to try.
+// A sample task to try. The billing item
+// is the one that pushes the agent into Code Mode.
 export const SAMPLE_TASK = `Handle these work items:
-- item-1 (customer_message): "I was charged twice and need help."
-- item-2 (bug_report): "The export button fails on Safari."
-- item-3 (sales_request): "Can you send pricing for 50 seats?"`;
+- item-1 (billing): Customer cus_88121 says they were charged twice. Find the duplicate charge and tell them the exact refund amount (in dollars).
+- item-2 (bug_report): "The export button fails on Safari."`;
```

### 4. `scripts/test-sandbox.ts`: exercise the boundary directly

A tiny script that drives the sandbox without needing the agent. We run it in the demo to *see*
the guardrails: a runaway loop dies on the timeout, `require` isn't there, and a bug comes back as
a structured error.

```ts
import { runInSandbox, type SandboxApi } from "../harness/sandbox";

// Demonstrates the sandbox guardrails directly, without needing the agent to
// misbehave. Run: npx tsx scripts/test-sandbox.ts
const api: SandboxApi = {
  getCharges: async () => [
    { id: "ch_001", amount: 4900 },
    { id: "ch_002", amount: 4900 },
  ],
};

const show = (label: string, r: unknown) => console.log(`\n${label}\n`, JSON.stringify(r));

// 1. Code Mode: fetch + compute via the tools API.
show(
  "1) code mode (compute over a tool call):",
  await runInSandbox(
    `const cs = await tools.getCharges();
     const dup = cs.find((c, i) => cs.findIndex(x => x.amount === c.amount) !== i);
     return { duplicateId: dup.id, refund: dup.amount / 100 };`,
    api,
  ),
);

// 2. A runaway sync loop is killed by the timeout.
show("2) infinite loop (killed by timeout):", await runInSandbox(`while (true) {}`, api, { timeoutMs: 800 }));

// 3. No access to the host: require/fs/process are simply not there.
show("3) require('fs') (blocked):", await runInSandbox(`return require("fs").readdirSync(".")`, api));

// 4. Errors come back structured, so the model can read them and self-correct.
show("4) a bug (structured error):", await runInSandbox(`return totallyUndefined.value`, api));

process.exit(0);
```

**`harness/runtime.ts` doesn't change.** That's the whole point. The durable loop already runs every
tool through `runTool`, and `runCode` is just a tool.

## The demo

**Code Mode in action.** Submit the billing task ("Customer cus_88121 says they were charged
twice. Find the duplicate and tell them the refund amount."). In the inspector you'll see the agent
classify, then make **one `runCode` call** whose argument is a real program. Here's what
ours wrote:

```js
const charges = await tools.getCharges('cus_88121');
const groups = {};
for (const c of charges) {
  const key = `${c.amount}|${c.description}`;
  (groups[key] ??= []).push(c);
}
const duplicates = [];
for (const [key, arr] of Object.entries(groups)) {
  if (arr.length > 1) {
    duplicates.push({ refundAmountDollars: (arr[0].amount / 100).toFixed(2), charges: arr });
  }
}
return { duplicates };
```

One program (fetch, group, dedupe, compute) instead of four tool calls round-tripping through the
model. It returns `$49.00`, then the agent drafts and sends. The irreversible `sendReply` is still a
normal durable tool call.

**The guardrails.** You don't need the agent to misbehave to see them. Run the sandbox directly:

```bash
npx tsx scripts/test-sandbox.ts
```

- a sync `while (true) {}` → **killed by the timeout** (`execution timed out…`)
- `require("fs")` → **blocked** (`require is not defined`, because it's just not in the context)
- a bug (`totallyUndefined.value`) → a **structured error**, which the harness feeds back to the
  model so it can read it and rewrite the program. That self-correction loop is free: a failed
  `runCode` is just a tool result the model gets to react to.

## In production

Let's be honest about `node:vm`. It is **not** a true security boundary (code can escape a context),
and its `timeout` can't interrupt **async** code, only synchronous loops. That's not a flaw in the
lesson. It's the reason real systems run untrusted code in a hosted sandbox, a throwaway micro-VM or
container you don't mind someone breaking out of:

- [e2b](https://e2b.dev), code sandboxes built for AI agents
- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [Fly sandboxes](https://fly.io/learn/virtual-sandbox/)
- [Vercel Sandbox](https://vercel.com/docs/sandbox)
- [Daytona](https://www.daytona.io/)

The harness's job is the same whichever you pick: **route every dangerous capability through one
mediated boundary.** How strong that boundary is, is a deployment choice.
