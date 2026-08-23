# The Agent Harness

**The pain:** _Why does this agent work in a demo and die in production?_

We're not building an agent today. We're building the thing that could run *any* agent
in production. It's a **harness**, a mini agent runtime. The agent is a boring
crash-test dummy. The harness is the protagonist.

> The line we repeat all day: **agent systems are workflow systems.** The LLM decides the
> next semantic step; the harness owns execution.

## What you start with

The starter already gives you the harness's outer shell, the parts that are plumbing, not
teaching:

- an **Express + WebSocket server** (`server/`) that streams a harness event log to the browser
- an in-memory **event bus** (`server/bus.ts`) and an `emit()` helper
- a prebuilt **inspector UI** (`web/`): a chat pane on the left, the live event stream on the right
- a **stubbed `runAgent`** in `harness/runtime.ts`

Run it now and submit anything:

```bash
npm run dev      # server on :8787, inspector on :5173
```

You'll see three events fire: `workflow.started`, a "no agent yet" log, then `workflow.completed`.
The pipe works; the middle is empty. Today we fill it with the brittle agent, then spend the rest
of the day discovering everything that brittle agent gets wrong.

## The failure mode

A demo agent is a `while` loop with an LLM in the middle:

```ts
while (true) {
  const response = await model(messages);
  if (response.toolCall) {
    const result = await tools[response.toolCall.name](response.toolCall.args);
    messages.push(result);
    continue;
  }
  return response.text;
}
```

That's a script with an LLM in it, and here's where it breaks in production:

- Process crashes → state lost, LLM re-billed
- Tool can do anything → unsafe runtime
- Context grows forever → degraded, expensive
- One agent does everything → bad specialization
- Sub-agents fail or disagree → no recovery
- Approval blocks the server → broken architecture

Each of these is a problem we fix as we go. Let's build that brittle agent for real, so the
failures are concrete.

## Live code

We build three files, in this order.

### 1. `harness/tools.ts`: the tools the agent can call

Fake but realistic support-triage tools. The point for today: they run with **no mediation**.
`sendReply` "emails the customer" the instant the model asks. No sandbox, no policy,
no approval. That recklessness is what the rest of the course fixes.

```ts
import { tool } from "ai";
import { z } from "zod";

// The tools our triage agent can call. They're fake but realistic.
//
// The important thing for Lesson 1: these run with NO mediation. No sandbox,
// no policy, no approval. `sendReply` actually "emails the customer" the moment
// the model asks for it. That recklessness is the whole point — it's what the
// rest of the course exists to fix.

const KNOWLEDGE_BASE: Record<string, string> = {
  billing:
    "Double charges are usually a duplicate authorization that drops off in 3–5 days. If it already settled, refund immediately.",
  refund: "Refunds post in 5–10 business days. Pro accounts can be expedited.",
  export:
    "The Safari export failure is a known bug (TICKET-4412). Workaround: use Chrome or the CSV export.",
  pricing:
    "Team plans are $20/seat/mo with a volume discount at 25+ seats. For 50+ seats, send the pricing PDF.",
};

export const tools = {
  searchKnowledgeBase: tool({
    description: "Search the support knowledge base for relevant articles.",
    inputSchema: z.object({
      query: z.string().describe("what to look up"),
    }),
    execute: async ({ query }) => {
      const hits = Object.entries(KNOWLEDGE_BASE)
        .filter(([key]) => query.toLowerCase().includes(key))
        .map(([, article]) => article);
      return { articles: hits.length ? hits : ["No exact match — use your judgment."] };
    },
  }),

  classifyItem: tool({
    description: "Classify a work item into a category.",
    inputSchema: z.object({
      itemId: z.string(),
      category: z.enum(["billing", "technical", "sales", "other"]),
    }),
    execute: async ({ itemId, category }) => ({ ok: true, itemId, category }),
  }),

  draftReply: tool({
    description: "Write a draft reply for a work item. Does not send anything.",
    inputSchema: z.object({
      itemId: z.string(),
      message: z.string(),
    }),
    execute: async ({ itemId }) => ({ ok: true, draftId: `draft-${itemId}` }),
  }),

  sendReply: tool({
    description: "Send the drafted reply to the customer. This really emails them.",
    inputSchema: z.object({
      itemId: z.string(),
      draftId: z.string(),
    }),
    // DANGEROUS: an irreversible side effect with zero confirmation.
    execute: async ({ itemId, draftId }) => ({ sent: true, itemId, draftId }),
  }),
};
```

A few things worth saying out loud:

- Tools are defined with the AI SDK's `tool()` helper: a `description`, a Zod `inputSchema`, and
  an `execute` function. The model reads the descriptions to decide what to call.
- `searchKnowledgeBase`, `classifyItem`, `draftReply` are harmless. `sendReply` is not, and
  nothing here treats it any differently.

### 2. `harness/system-prompt.ts`: what the agent is told to do

```ts
// What the agent is told to do. Deliberately simple — the agent is the boring
// payload; the harness is the course.
export const SYSTEM_PROMPT = `You are a support triage agent.

For each work item the user gives you:
1. Classify it with classifyItem.
2. Search the knowledge base with searchKnowledgeBase if it helps.
3. Draft a reply with draftReply.
4. Send the reply with sendReply.

Work through every item, then briefly summarize what you did.`;

// A sample task to try.
export const SAMPLE_TASK = `Handle these work items:
- item-1 (customer_message): "I was charged twice and need help."
- item-2 (bug_report): "The export button fails on Safari."
- item-3 (sales_request): "Can you send pricing for 50 seats?"`;
```

Notice we *tell* it to send. So the brittle agent will dutifully email three customers with no
human in the loop. That's exactly the kind of thing we fix later.

### 3. `harness/runtime.ts`: the brittle agent loop

Now replace the stub. This is the agent: an in-memory message array and a hand-rolled loop. We
drive the loop ourselves because `streamText` does **one** model turn by default. If the model
calls a tool, that turn ends and we decide what happens next.

```ts
import { streamText } from "ai";
import type { ModelMessage } from "ai";
import { randomUUID } from "node:crypto";
import { EventType, type Emit } from "@shared/events";
import { model } from "./model";
import { tools } from "./tools";
import { SYSTEM_PROMPT } from "./system-prompt";

// A safety cap so a confused model can't loop forever.
const MAX_STEPS = 10;

// THE BRITTLE AGENT.
//
// This is a script with an LLM in the middle. It works in a demo and dies in
// production a dozen ways:
//
//   · the `messages` array lives in memory      → crash = total loss
//   · tools run with no mediation               → `sendReply` just fires
//   · history only grows                        → context bloat
//   · one agent does everything                 → no specialization
//
// Make it work, then look at everything it gets wrong.
export async function runAgent(opts: { input: string; emit: Emit }): Promise<void> {
  const { input, emit } = opts;
  const workflowId = randomUUID();
  emit({ type: EventType.WorkflowStarted, workflowId, input });

  // BRITTLE STATE: a plain in-memory array. If this process dies, it's gone.
  const messages: ModelMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: input },
  ];

  // THE LOOP. We drive it ourselves — each pass is exactly one model turn,
  // because streamText does a single generation by default.
  let step = 0;
  while (step < MAX_STEPS) {
    const result = streamText({ model, messages, tools });

    // Forward everything the model does onto the harness event stream so the
    // inspector can render it. (`part.type` here is the AI SDK's, not ours.)
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          emit({ type: EventType.ModelDelta, workflowId, text: part.text });
          break;
        case "tool-call":
          emit({
            type: EventType.ToolRequested,
            workflowId,
            toolCallId: part.toolCallId,
            name: part.toolName,
            args: part.input,
          });
          break;
        case "tool-result":
          emit({
            type: EventType.ToolCompleted,
            workflowId,
            toolCallId: part.toolCallId,
            result: part.output,
          });
          break;
        case "error":
          emit({ type: EventType.WorkflowFailed, workflowId, error: String(part.error) });
          return;
      }
    }

    // Append the model's message(s) — including any tool results — to history.
    messages.push(...(await result.response).messages);

    // No more tool calls means the model answered. We're done.
    const toolCalls = await result.toolCalls;
    if (toolCalls.length === 0) {
      const text = await result.text;
      emit({ type: EventType.ModelCompleted, workflowId, text });
      emit({ type: EventType.WorkflowCompleted, workflowId, output: text });
      return;
    }

    step++;
  }

  emit({
    type: EventType.WorkflowFailed,
    workflowId,
    error: `Hit the ${MAX_STEPS}-step limit without finishing.`,
  });
}
```

Walk through the loop:

- **State is a plain array** in memory. Hold that thought.
- **`streamText` runs one turn.** We iterate `result.fullStream` and forward each part onto the
  harness event stream: text deltas, tool calls, tool results. The inspector renders all of it for
  free, because everything is an event.
- **We append `result.response.messages`** to history so the next turn sees what happened.
- **We stop when the model stops calling tools.** Until then, loop.

### Run it

You'll need an API key. Copy `.dev.vars.example` to `.dev.vars` and set `OPENAI_API_KEY`.
Then `npm run dev`, open the inspector, and paste the sample task:

```
Handle these work items:
- item-1 (customer_message): "I was charged twice and need help."
- item-2 (bug_report): "The export button fails on Safari."
- item-3 (sales_request): "Can you send pricing for 50 seats?"
```

**Success looks like:** the left pane streams the agent's reasoning and tool calls; the right pane
fills with `tool.requested` / `tool.completed` events as it classifies, searches, drafts, and
sends each item, ending in `workflow.completed`. You built a working agent.

## The demo: now break it

It works, so why isn't it production-grade? Here are the cracks:

1. **Kill it mid-run.** Submit the task, and while it's working, stop the server (`Ctrl-C`). The
   in-memory `messages` array is gone. Restart and it has no idea anything happened, and any
   `sendReply` it already fired can't be un-fired.
2. **It emailed three customers with no approval.** `sendReply` ran the instant the model asked.
   In a real system that's a refund issued, a message sent, a record changed, irreversibly.
3. **Give it 50 items.** The `messages` array, and the token bill, grow every turn until the
   model degrades or you blow the context window.
4. **It's one agent doing billing, bug triage, and sales.** No specialization, no isolation.

None of these are bugs in our code. They're the difference between a script and a harness. We
spend the rest of the course closing the gap.

## In production

This outer layer (a loop, tools, a message history, an event stream) is what LangGraph,
Mastra, and the agent SDKs hand you. Today you built the tiny version so the rest of the course can
show you what those frameworks are actually doing underneath.
