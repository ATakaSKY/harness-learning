# Harness Engineering & Agent Orchestration

> Stop building scripts. Start building durable multi-agent systems.

A one-day, hands-on workshop on the infrastructure layer around an LLM — the **harness** — that
makes agents survive production. Move past basic while-loops and API wrappers and learn the
patterns that keep agents durable, isolated, memory-aware, and coordinated.

Instead of one large cumulative project, each lesson tackles a **new architectural pattern**: you
see it introduced, watch it live-coded in TypeScript/Node.js, and move on.

## What you'll learn

1. **The Agent Harness** — the middleware that gives an LLM its context, tools, and guardrails.
2. **Durable Execution** — checkpoint agent steps so a crash or rate limit resumes exactly where it left off.
3. **Secure Sandboxing** — run untrusted, agent-generated code in an isolated runtime with timeouts.
4. **Advanced Memory** — hydrate the right context with state stores, sliding windows, and summarization.
5. **Orchestration** — route intent and hand off context between a triage agent and specialists.
6. **Hierarchical Supervision** — a supervisor that plans, spawns parallel sub-agents, and merges results.
7. **Human-in-the-Loop** — durable suspend/resume to wait minutes or days for human approval.

## How the course is organized

Each lesson is its own git branch:

```
lesson-1 → lesson-2 → ... → lesson-7 (latest)
```

Each lesson branch contains:

- The solution for the **previous** lesson (so you can catch up if you fall behind).
- The notes for the **current** lesson under `lessons/<lesson-name>/index.md`.

Two convenience branches:

- **`main`** — points at the latest lesson. This is what you see on the GitHub landing page.
- **`complete`** — same as `main`, an explicit name for "everything that exists right now."

So if you fall behind in lesson 4, `git checkout lesson-5` to grab the lesson 4 solution and pick
up from there.

### Reading the lesson notes

Notes live alongside the code under `lessons/`. You can read them three ways:

- **On GitHub or in your editor** — they're plain markdown.
- **In Obsidian** — open the `lessons/` directory as a vault.
- **As a local site** — run `npm run docs` to serve them with VitePress at http://localhost:5173.

## Setup

### 1. Clone and install

```bash
git clone <this repo url>
cd harness-engineering
npm install
```

### 2. Configure environment variables

Copy `.dev.vars.example` to `.dev.vars` and fill in your keys. A Gemini API key is the only
hard requirement; individual lessons note any extra services they need.

```
GOOGLE_GENERATIVE_AI_API_KEY=your-key-here
```

### 3. Run things

```bash
npm run dev    # start the app: harness server (:8787) + inspector UI (:5173)
npm run docs   # serve the lesson notes with VitePress
npm run typecheck
```

`npm run dev` boots the **Harness Inspector** — a chat pane on the left and a live
event-stream pane on the right. Out of the box the agent is a stub: submit a task and
you'll see the harness emit `workflow.started` → a "no agent yet" log → `workflow.completed`.
You build the real (brittle) agent loop in Lesson 1.

## Prerequisites

- Comfortable with TypeScript and Node.js.
- Basic understanding of LLM APIs and standard agent loops (receive → think → act → respond).
- Familiarity with asynchronous programming and API integrations.

## Tech stack

- **Runtime:** Node.js + TypeScript, run with `tsx` (no build step for the server).
- **Server:** Express + `ws` — hosts the harness and streams its event log to the browser over one WebSocket.
- **LLM:** Google Gemini (gemini-3.5-flash-lite) via the Vercel AI SDK (server-side only; the harness owns the transport).
- **UI:** Vite + React, styled with prompt-kit (shadcn/ui + Tailwind). The inspector renders the harness event stream; **students don't build the UI.**
- **Notes:** VitePress.
- Libraries for durable execution, sandboxing, and state are introduced per lesson.

Everything runs locally. No deployment needed.
