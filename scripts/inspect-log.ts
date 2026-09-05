import { config } from "dotenv";
config({ path: ".dev.vars" });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

if (process.argv.includes("truncate")) {
  await sql`TRUNCATE event_log`;
  console.log("event_log truncated.");
  await sql.end();
  process.exit(0);
}

const rows = await sql<
  { data: any }[]
>`SELECT data FROM event_log ORDER BY seq`;
const events = rows.map((r) => r.data);

const byType: Record<string, number> = {};
for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;

// How many times was each tool call REQUESTED? >1 means a side effect was repeated.
const reqByCall: Record<string, number> = {};
for (const e of events) {
  if (e.type === "tool.requested")
    reqByCall[e.toolCallId] = (reqByCall[e.toolCallId] ?? 0) + 1;
}
const duplicated = Object.entries(reqByCall).filter(([, n]) => n > 1);

console.log("total events:      ", events.length);
console.log("by type:           ", byType);
console.log("distinct tool calls:", Object.keys(reqByCall).length);
console.log("DUPLICATED calls:  ", duplicated.length, duplicated);
console.log("completed:         ", byType["workflow.completed"] ?? 0);

await sql.end();
