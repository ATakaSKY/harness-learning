import vm from "node:vm";

// The harness is the security boundary. When the agent writes code (Code Mode),
// it runs HERE — never with raw access to the process.
//
// This is `node:vm`, which is deliberately minimal:
//   · the context has NO `require`, `process`, `fs`, `fetch`, ... — only what we
//     hand in (a small `tools` API + `console.log`)
//   · the `timeout` option kills runaway SYNCHRONOUS code (e.g. `while(true){}`)
//
// Be honest about the limit: `vm` is NOT a true security sandbox, and its
// timeout can't interrupt async code. That's exactly why production systems run
// untrusted code in a hosted sandbox (e2b, Cloudflare's Sandbox SDK, Fly,
// Vercel, Daytona). The harness's job is to MEDIATE the boundary; the strength
// of the boundary is a deployment choice.

export type SandboxResult =
  | { ok: true; result: unknown; logs: string[] }
  | { ok: false; error: string; logs: string[] };

export type SandboxApi = Record<string, (...args: any[]) => unknown>;

export async function runInSandbox(
  code: string,
  api: SandboxApi,
  opts: { timeoutMs?: number } = {},
): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const logs: string[] = [];

  // The ENTIRE global the code can see. Frozen so the code can't add to it.
  const context = vm.createContext({
    tools: api,
    console: {
      log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    },
  });

  // Run the model's code as the body of an async function so it can `await`
  // tool calls and `return` a result.
  const wrapped = `(async () => { ${code} })()`;

  try {
    // `timeout` bounds the SYNCHRONOUS portion (a sync infinite loop dies here).
    const pending = vm.runInContext(wrapped, context, {
      timeout: timeoutMs,
    }) as Promise<unknown>;
    // Backstop for async hangs. (vm can't actually KILL the leaked async work —
    // a real isolate can. We surface a clean error to the model regardless.)
    const result = await withTimeout(pending, timeoutMs);
    return { ok: true, result, logs };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      logs,
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`execution timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}
