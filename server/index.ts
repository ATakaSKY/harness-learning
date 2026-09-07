// MUST be first: loads .dev.vars before any module that reads env at load time.
import "./env";

import { DBOS } from "@dbos-inc/dbos-sdk";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { clearEventLog, ensureSchema } from "../harness/db";
import { subscribe, history } from "../harness/bus";
import { runAgentWorkflow } from "../harness/runtime";
import type { ClientMessage } from "@shared/events";

const PORT = Number(process.env.PORT ?? 8787);

async function main() {
  // Make sure the durable event log exists.
  await ensureSchema();

  // Point DBOS at the same Postgres database for its checkpoint store, then
  // launch it. launch() ALSO recovers any workflows that were mid-flight when
  // the process last died, resuming them from their last completed step.
  DBOS.setConfig({
    name: "harness",
    systemDatabaseUrl: process.env.DATABASE_URL,
  });
  await DBOS.launch();

  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*"); // inspector runs on a different port
    next();
  });

  app.post("/api/clear", async (_req, res) => {
    await clearEventLog();
    res.json({ ok: true });
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Forward every emitted event to all connected inspectors.
  subscribe((event) => {
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  });

  wss.on("connection", async (socket: WebSocket) => {
    // Register the message handler FIRST. history() is now an async DB read, and
    // the client sends submit_task the instant it connects — if we awaited
    // history() before attaching this listener, that first message would be lost.
    socket.on("message", async (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return; // ignore anything that isn't valid JSON
      }

      if (message.type === "submit_task") {
        // Start the durable workflow in the background. It reports progress via
        // the event stream; we don't wait for the result here.
        await DBOS.startWorkflow(runAgentWorkflow)(message.input);
      }
    });

    // Replay the DURABLE timeline so a fresh inspector shows everything —
    // including work that happened before a crash, and a workflow DBOS is
    // currently recovering.
    for (const event of await history()) socket.send(JSON.stringify(event));
  });

  server.listen(PORT, () => {
    console.log(
      `harness server listening on http://localhost:${PORT}  (ws: /ws)`,
    );
  });
}

main().catch((error) => {
  console.error("failed to start:", error);
  process.exit(1);
});
