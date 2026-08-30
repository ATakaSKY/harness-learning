import { config } from "dotenv";

// Load .dev.vars into process.env. This module is imported FIRST in the server
// (before anything that reads env at load time, like harness/db.ts) because ES
// module imports are evaluated before top-level statements.
config({ path: ".dev.vars" });
