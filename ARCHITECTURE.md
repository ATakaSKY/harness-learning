# Architecture at a glance

A map of this repo for when you come back to it cold. One idea to hold onto:

> **The LLM decides the next semantic step. The harness owns execution.**
> The agent here is deliberately boring support triage. The `harness/` directory is the product.

---

## 1. The big picture

Who talks to whom. Everything runs on your laptop.

```mermaid
flowchart LR
    subgraph BROWSER["Browser — web/ (prebuilt, never taught)"]
        TASK["TaskPane<br/>you type a task"]
        SOCK["useHarnessSocket<br/>one WebSocket"]
        INSP["InspectorPane<br/>renders the timeline"]
    end

    subgraph SERVER["Node server — server/index.ts"]
        WS["Express + ws on /ws<br/>the transport that matters"]
        HTTP["HTTP side door<br/>GET /health, POST /api/clear"]
        BOOT["DBOS.launch on boot<br/>resumes runs killed mid-flight"]
    end

    subgraph HARNESS["The harness — harness/ (this is the course)"]
        RUNTIME["runtime.ts<br/>agentWorkflow = the durable loop<br/>intercepts handoff"]
        AGENTS["agent.ts<br/>named agents: prompt + tools"]
        MEMORY["memory.ts<br/>buildContext + summarize"]
        MODEL["model.ts<br/>Gemini via the AI SDK"]
        TOOLS["tools.ts<br/>tool schemas + runTool executor"]
        SANDBOX["sandbox.ts<br/>node:vm — no fs, no net, 2s timeout"]
        BUS["bus.ts<br/>emit = persist, then broadcast"]
    end

    GEMINI["Google Gemini<br/>gemini-3.5-flash-lite"]
    PG[("Postgres<br/>event_log + DBOS checkpoints")]

    TASK -- "submit_task" --> SOCK
    SOCK -- "command" --> WS
    WS -- "startWorkflow" --> RUNTIME
    WS -- "AgentEvent stream" --> SOCK
    SOCK --> INSP
    INSP -- "Clear button" --> HTTP
    HTTP -- "TRUNCATE event_log" --> PG

    RUNTIME -- "current agent prompt + tools" --> AGENTS
    RUNTIME -- "hydrate the context, compact when over budget" --> MEMORY
    MEMORY -- "one summarizer call" --> MODEL
    RUNTIME -- "one turn over the hydrated context" --> MODEL
    MODEL --> GEMINI
    RUNTIME -- "one tool call at a time" --> TOOLS
    TOOLS -- "runCode ONLY" --> SANDBOX
    RUNTIME -- "every step" --> BUS
    RUNTIME -- "checkpoint every step" --> PG
    BUS -- "durable write" --> PG
    BUS -- "live fan-out" --> WS
    BOOT -.-> RUNTIME

    classDef harness fill:#1e3a5f,stroke:#4a90d9,stroke-width:2px,color:#fff
    classDef infra fill:#2d2d2d,stroke:#888,color:#fff
    classDef ui fill:#3d2d4d,stroke:#a678c9,color:#fff
    class RUNTIME,AGENTS,MEMORY,MODEL,TOOLS,SANDBOX,BUS harness
    class GEMINI,PG,WS,HTTP,BOOT infra
    class TASK,SOCK,INSP ui
```

Two things this diagram is trying to make obvious:

- **Nothing reaches the browser except events.** The UI never calls the model or a tool. It is a
  pure projection of the event stream defined in `shared/events.ts`, which is why invisible infra
  becomes visible on screen.
- **The socket is bidirectional and long-lived.** That's deliberate: a request-scoped transport like
  the AI SDK's `useChat` can't express server-initiated events such as a sub-agent finishing or a
  workflow resuming days later. The HTTP routes are housekeeping only — a health check and the
  inspector's Clear button, which truncates the event log so you can start a demo from empty.

---

## 2. One task, end to end

What actually happens when you hit submit. Each `checkpoint` is a DBOS step boundary — a point the
system can crash and resume from.

```mermaid
sequenceDiagram
    autonumber
    participant U as Browser
    participant S as Server
    participant W as agentWorkflow
    participant M as Gemini
    participant T as runTool
    participant DB as Postgres

    U->>S: submit_task with the work items
    S->>W: DBOS.startWorkflow, does not await the result
    W->>DB: emit workflow.started
    DB-->>U: live event, timeline appears

    loop up to MAX_STEPS = 30
        opt recent turns are over the token budget
            W->>M: summarize the oldest turns
            M-->>W: updated running summary
            W->>DB: checkpoint summarize-N, emit memory.compacted
        end

        W->>W: buildContext → system string + messages (task + recent turns)
        W->>M: streamText(system, messages, current agent's tools)
        M-->>W: streamed text, then any tool calls
        W->>DB: checkpoint step model-N
        Note over W,U: each token becomes a model.delta event

        alt the model asked for tools
            alt handoff (control-plane — not runTool)
                W->>DB: emit agent.handoff
                W->>W: switch current agent, synthetic tool result
            else any other tool
                W->>DB: emit tool.requested
                W->>T: runTool with name and args
                T-->>W: result
                W->>DB: checkpoint step tool-abc123
            end
            W->>W: collect results into this turn, push the turn, loop again
        else the model answered with no tool calls
            W->>DB: emit model.completed, then workflow.completed
        end
    end
```

The loop is a plain `while` — that's the point. Two things make it a runtime rather than a script.
Every non-deterministic thing (the model, the tools, the summarizer) is wrapped in a DBOS step, so
the workflow body can be safely re-run from the top on recovery while completed steps are served
from their checkpoints. And the loop no longer accumulates one ever-growing `messages` array: it
keeps a list of **turns** plus a running summary, and rebuilds the context from scratch each pass.

---

## 3. Why a crash doesn't hurt

The failure this is built to survive: the process dies right after `sendReply` really emailed a
customer. Naively you re-run and email them twice, and re-pay for every LLM call.

```mermaid
stateDiagram-v2
    [*] --> Running: submit_task
    Running --> Running: step finishes, result checkpointed to Postgres
    Running --> Crashed: process killed, rate limit, deploy
    Crashed --> Running: next DBOS.launch recovers and skips completed steps
    Running --> Completed: model answers with no tool calls
    Running --> Failed: hit the 30-step cap
    Completed --> [*]
    Failed --> [*]
```

Two separate durability mechanisms share one Postgres database, which is easy to conflate:

| Mechanism | Owner | What it buys |
|---|---|---|
| `event_log` table | `harness/db.ts` + `bus.ts` | The timeline survives restarts, so a fresh inspector can replay all history |
| DBOS step checkpoints | `@dbos-inc/dbos-sdk` | Each model call and tool call runs **exactly once**, even across a crash |

---

## 4. Code Mode and the security boundary

Lesson 3's move: rather than chaining a dozen tool calls that each round-trip through the model,
the agent writes **one program** and the harness runs it in a sandbox.

```mermaid
flowchart TD
    MODEL["Model emits runCode<br/>with a JS async function body"]
    EXEC["runTool in tools.ts<br/>the harness mediates"]
    VM["runInSandbox — node:vm context"]
    API["The ONLY globals injected:<br/>tools.getCharges<br/>tools.searchKnowledgeBase<br/>console.log"]
    OUT["SandboxResult<br/>ok, result, logs — or a clean error"]
    HOST["Host process<br/>fs, net, process, env"]

    MODEL --> EXEC --> VM
    VM --- API
    VM --> OUT --> MODEL
    VM -. "no reference exists" .-x HOST

    classDef safe fill:#1e3d2f,stroke:#4caf7d,color:#fff
    classDef danger fill:#4d2222,stroke:#e06c6c,color:#fff
    class VM,API,OUT safe
    class HOST danger
```

The injected API is deliberately **read-only**, which is what lets the whole `runCode` call be a
single durable step: re-running it after a crash can't duplicate a side effect. Side-effecting tools
like `sendReply` stay outside the sandbox as their own steps.

Be honest about the limit, because the lesson notes are: `node:vm` is not a true security boundary,
and its `timeout` can't interrupt async code. The harness's job is to **mediate** the boundary; how
strong that boundary is becomes a deployment choice (e2b, Cloudflare Sandbox SDK, Fly, Daytona).

---

## 5. Memory: what the model actually sees

Lesson 4's move: stop equating the conversation with the context window. `harness/memory.ts` keeps
three things apart, and assembles the third one fresh on every pass of the loop.

```mermaid
flowchart LR
    subgraph SPLIT["Three different things, on purpose"]
        HIST["HISTORY<br/>everything that happened<br/>the Postgres event_log"]
        STATE["STATE<br/>running summary of old turns"]
        RECENT["RECENT TURNS<br/>the newest ones, verbatim"]
    end

    BUDGET["Over MAX_CONTEXT_TOKENS = 500?<br/>peel the oldest turns until back<br/>under KEEP_CONTEXT_TOKENS = 200"]
    CTX["buildContext<br/>system prompt + pinned task<br/>+ summary + recent turns"]
    SEEN["What Gemini sees this turn<br/>roughly flat token count<br/>however long the task runs"]

    RECENT --> BUDGET
    BUDGET -- "summarize: an LLM call,<br/>checkpointed as its own DBOS step" --> STATE
    STATE --> CTX
    RECENT --> CTX
    CTX --> SEEN
    HIST -. "never sent to the model —<br/>replayed to the inspector instead" .-> SEEN

    classDef keep fill:#1e3a5f,stroke:#4a90d9,stroke-width:2px,color:#fff
    classDef cold fill:#2d2d2d,stroke:#888,color:#ccc
    class STATE,RECENT,CTX,SEEN keep
    class HIST,BUDGET cold
```

Details worth remembering when you reread this:

- **The budget is tokens, not turn count.** A turn count breaks the moment the model batches ten
  tool calls into one turn. The estimate is a rough 4-chars-per-token, and the thresholds are
  deliberately tiny so compaction visibly fires during a short workshop demo.
- **The task is pinned.** The original input is re-added to every context and never summarized away,
  so the agent can't forget the goal after compaction.
- **Summarizing is itself a durable step.** A crash won't re-summarize or re-pay for it, and the
  `memory.compacted` event puts the whole thing on the inspector timeline.
- **Wire format vs. concepts.** Gemini (via the AI SDK) accepts system content only at the top of a
  call. Hydration still assembles the same four pieces — agent instructions, pinned task, summary,
  recent turns — but maps them to `streamText({ system, messages })`: one merged `system` string
  (prompt + summary) and `messages` that are only user / assistant / tool turns.

---

## 5b. Routing and handoffs (L5)

Lesson 5's move: the runtime stays one loop; **specialists are data**, not new machinery. Each agent
is a name, a system prompt, and a tool subset in `harness/agent.ts`. The model may call `handoff`;
the harness **intercepts** that call, emits `agent.handoff`, swaps the running agent, and appends a
synthetic tool result — same conversation, new prompt and tools on the next turn. `currentAgent` is
rebuilt deterministically on DBOS recovery because the handoff is a cached model decision.

```mermaid
flowchart LR
    TRIAGE["triage agent<br/>no issueRefund"]
    HANDOFF["model calls handoff<br/>runtime intercepts"]
    BILLING["billing agent<br/>issueRefund + stricter tools"]
    TURNS["turns[] unchanged<br/>context re-hydrated with new system prompt"]

    TRIAGE --> HANDOFF --> BILLING
    HANDOFF --> TURNS --> BILLING

    classDef harness fill:#1e3a5f,stroke:#4a90d9,stroke-width:2px,color:#fff
    class TRIAGE,BILLING,HANDOFF,TURNS harness
```

---

## 6. The seven lessons, as modules

Each lesson adds one module to the same runtime. Solid = on `main` today, dashed = later lessons.

```mermaid
flowchart TD
    subgraph BUILT["Built"]
        L1["L1 Intro to Harness Engineering<br/>runtime.ts, tools.ts, bus.ts, shared/events.ts<br/>fixes: a demo agent is a while-loop that dies seven ways"]
        L2["L2 Durable Execution<br/>db.ts, DBOS steps<br/>fixes: crash loses state, re-bills the LLM, double-sends"]
        L3["L3 Secure Sandboxing<br/>sandbox.ts, runCode<br/>fixes: model-written code runs unmediated"]
        L4["L4 Memory and Context Hydration<br/>memory.ts, buildContext + summarize<br/>fixes: appending everything bloats the context window"]
        L5["L5 Routing and Handoffs<br/>agent.ts + runtime handoff intercept<br/>fixes: one overloaded agent conflates intents"]
    end

    subgraph TODO["Planned — the rest of the control plane"]
        L6["L6 Hierarchical Supervision<br/>supervisor.ts<br/>fixes: parallel work done serially, partial failure"]
        L7["L7 Human-in-the-Loop<br/>approvals.ts<br/>fixes: waiting on a human blocks and dies on restart"]
    end

    L1 --> L2 --> L3 --> L4 --> L5 --> L6 --> L7

    classDef built fill:#1e3a5f,stroke:#4a90d9,stroke-width:2px,color:#fff
    classDef planned fill:#2d2d2d,stroke:#888,stroke-dasharray:5 3,color:#ccc
    class L1,L2,L3,L4,L5 built
    class L6,L7 planned
```

`shared/events.ts` already declares the event types for all seven lessons — handoffs, plans,
sub-agents, approvals. Reading that enum top to bottom is the fastest way to see where the course
is going.

---

## 7. File map

| Path | What it is |
|---|---|
| `harness/runtime.ts` | The durable agent loop. Intercepts `handoff`. The spine of the course |
| `harness/agent.ts` | Named agents: each is a system prompt plus an allowed tool subset |
| `harness/memory.ts` | Token budget, `buildContext` hydration, and the summarizer |
| `harness/bus.ts` | `emit` writes the event to Postgres, then fans it out to listeners |
| `harness/db.ts` | Drizzle + postgres.js; owns the `event_log` table and clears it |
| `harness/tools.ts` | Tool schemas the model sees, plus the harness-owned `runTool` executor |
| `harness/sandbox.ts` | `node:vm` isolation for model-written code |
| `harness/model.ts` | The single place the Gemini model is configured |
| `harness/system-prompt.ts` | Sample task string for demos (`SAMPLE_TASK`); agent prompts live in `agent.ts` |
| `shared/events.ts` | `AgentEvent` — the contract between harness and UI |
| `server/index.ts` | Express + ws, DBOS launch and recovery, `submit_task`, `/api/clear` |
| `web/` | The prebuilt inspector. Renders events, never calls the harness directly |
| `lessons/` | VitePress notes, one folder per lesson |
| `scripts/` | `test-sandbox.ts` and `inspect-log.ts` — poke at pieces in isolation |

## 8. Running it

```bash
npm run dev        # harness server on :8787 + inspector on :5173
npm run docs       # lesson notes via VitePress on :5174
npm run typecheck
```

Needs `.dev.vars` with `GOOGLE_GENERATIVE_AI_API_KEY` and `DATABASE_URL` (any Postgres; Neon works).
