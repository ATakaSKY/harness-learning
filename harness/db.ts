import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { pgTable, bigserial, jsonb } from "drizzle-orm/pg-core";
import type { AgentEvent } from "@shared/events";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set — copy .dev.vars.example to .dev.vars.",
  );
}

// postgres.js connection (Neon requires SSL, carried in the URL). We keep the
// pool small — this is the durable event log, not a high-traffic app DB.
const client = postgres(connectionString, { max: 5 });
export const db = drizzle(client);

// The DURABLE event log. In first commit the event stream lived in a memory array
// that vanished on restart. Now every event is a row here, so the inspector can
// replay the whole timeline — including work that happened before a crash.
export const eventLog = pgTable("event_log", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(), // global order
  data: jsonb("data").$type<AgentEvent>().notNull(),
});

// Create the table on boot. Keeps the workshop migration-free; in a real app
// you'd use Drizzle migrations instead.
export async function ensureSchema(): Promise<void> {
  await client`
    CREATE TABLE IF NOT EXISTS event_log (
      seq  bigserial PRIMARY KEY,
      data jsonb NOT NULL
    )
  `;
}
