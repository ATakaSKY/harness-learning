import { randomUUID } from "node:crypto";
import type { AgentEvent, EventInput, Emit } from "@shared/events";

// A tiny in-memory event bus. The harness emits events here; the WebSocket
// layer subscribes and forwards them to every connected inspector.
//
// We keep a short ring buffer so a browser that connects late still sees the
// timeline so far.
type Listener = (event: AgentEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private buffer: AgentEvent[] = [];
  private readonly max = 1000;

  emit(input: EventInput): AgentEvent {
    const event: AgentEvent = { ...input, id: randomUUID(), ts: Date.now() };
    this.buffer.push(event);
    if (this.buffer.length > this.max) this.buffer.shift();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  history(): AgentEvent[] {
    return [...this.buffer];
  }
}

// Hand harness code a plain `emit(...)` function bound to this bus.
export function createEmitter(bus: EventBus): Emit {
  return (input) => {
    bus.emit(input);
  };
}
