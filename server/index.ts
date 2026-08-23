import { config } from "dotenv";
// Load secrets from .dev.vars (GOOGLE_GENERATIVE_AI_API_KEY, ...) before anything else.
config({ path: ".dev.vars" });

import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { EventBus, createEmitter } from "./bus";
import { runAgent } from "../harness/runtime";
import { EventType, type ClientMessage } from "@shared/events";

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const bus = new EventBus();

// Forward every event the harness emits to all connected inspectors.
bus.subscribe((event) => {
  const data = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
});

wss.on("connection", (socket: WebSocket) => {
  // Replay the timeline so far so a fresh inspector isn't blank.
  for (const event of bus.history()) socket.send(JSON.stringify(event));

  socket.on("message", (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return; // ignore anything that isn't valid JSON
    }

    if (message.type === "submit_task") {
      const emit = createEmitter(bus);
      // Fire and forget — the agent reports everything via events, not a return value.
      runAgent({ input: message.input, emit }).catch((error) => {
        emit({ type: EventType.Log, level: "error", message: String(error) });
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`harness server listening on http://localhost:${PORT}  (ws: /ws)`);
});
