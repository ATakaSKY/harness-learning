import { runInSandbox, type SandboxApi } from "../harness/sandbox";

// Demonstrates the sandbox guardrails directly, without needing the agent to
// misbehave. Run: npx tsx scripts/test-sandbox.ts
const api: SandboxApi = {
  getCharges: async () => [
    { id: "ch_001", amount: 4900 },
    { id: "ch_002", amount: 4900 },
  ],
};

const show = (label: string, r: unknown) =>
  console.log(`\n${label}\n`, JSON.stringify(r));

// 1. Code Mode: fetch + compute via the tools API.
show(
  "1) code mode (compute over a tool call):",
  await runInSandbox(
    `const cs = await tools.getCharges();
     const dup = cs.find((c, i) => cs.findIndex(x => x.amount === c.amount) !== i);
     return { duplicateId: dup.id, refund: dup.amount / 100 };`,
    api,
  ),
);

// 2. A runaway sync loop is killed by the timeout.
show(
  "2) infinite loop (killed by timeout):",
  await runInSandbox(`while (true) {}`, api, { timeoutMs: 800 }),
);

// 3. No access to the host: require/fs/process are simply not there.
show(
  "3) require('fs') (blocked):",
  await runInSandbox(`return require("fs").readdirSync(".")`, api),
);

// 4. Errors come back structured, so the model can read them and self-correct.
show(
  "4) a bug (structured error):",
  await runInSandbox(`return totallyUndefined.value`, api),
);

process.exit(0);
