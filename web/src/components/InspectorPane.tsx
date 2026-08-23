import type { AgentEvent } from "@shared/events";
import { cn } from "@/lib/utils";

// The right pane is the harness's observability surface: the raw event stream,
// in order. This is the thing that makes invisible infrastructure visible.
// Every lesson adds richer panels here (checkpoints, sub-agent tree, approvals)
// — all driven by new event types on this same stream.
const groupColor: Record<string, string> = {
  workflow: "text-violet-600",
  model: "text-sky-600",
  tool: "text-emerald-600",
  log: "text-amber-600",
};

export function InspectorPane({ events }: { events: AgentEvent[] }) {
  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-medium">Event stream</h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          {events.length} events
        </span>
      </div>
      <ol className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs">
        {events.length === 0 && (
          <li className="text-muted-foreground p-2">
            Waiting for the harness to emit events…
          </li>
        )}
        {events.map((ev) => (
          <li
            key={ev.id}
            className="hover:bg-muted/50 flex items-start gap-2 rounded px-2 py-1"
          >
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {formatTime(ev.ts)}
            </span>
            <span
              className={cn(
                "shrink-0 font-medium",
                groupColor[ev.type.split(".")[0]] ?? "text-foreground",
              )}
            >
              {ev.type}
            </span>
            <span className="text-muted-foreground min-w-0 flex-1 break-all">
              {summarize(ev)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function summarize(ev: AgentEvent): string {
  const payload: Record<string, unknown> = { ...ev };
  delete payload.id;
  delete payload.ts;
  delete payload.type;
  delete payload.workflowId;
  return JSON.stringify(payload);
}
