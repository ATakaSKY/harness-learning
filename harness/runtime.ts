import { streamText } from "ai";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { JSONValue, ModelMessage } from "ai";
import { EventType } from "@shared/events";
import { model } from "./model";
import { runTool, tools } from "./tools";
import { SYSTEM_PROMPT } from "./system-prompt";
import { emit } from "./bus";

// A safety cap so a confused model can't loop forever.
const MAX_STEPS = 10;

type ToolCall = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};
type Turn = {
  text: string;
  toolCalls: ToolCall[];
  responseMessages: ModelMessage[];
};

// One model turn: stream the tokens out as events, then return the assistant's
// message(s) and any tool calls. We run this as a DBOS step, so a completed turn
// is checkpointed and never re-called — a crash won't re-bill the LLM.
async function modelTurn(
  workflowId: string,
  messages: ModelMessage[],
): Promise<Turn> {
  const result = streamText({ model, messages, tools });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      await emit({ type: EventType.ModelDelta, workflowId, text: part.text });
    }
  }

  const rawCalls = await result.toolCalls;
  return {
    text: await result.text,
    toolCalls: rawCalls.map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input as Record<string, unknown>,
    })),
    responseMessages: (await result.response).messages,
  };
}

// Execute one tool. We run this as a DBOS step so its side effect (e.g.
// sendReply actually emailing someone) runs EXACTLY ONCE — a completed tool step
// is never re-run when DBOS recovers the workflow after a crash.
async function toolStep(
  workflowId: string,
  call: ToolCall,
): Promise<Record<string, unknown>> {
  await emit({
    type: EventType.ToolRequested,
    workflowId,
    toolCallId: call.toolCallId,
    name: call.toolName,
    args: call.input,
  });
  const output = await runTool(call.toolName, call.input);
  await emit({
    type: EventType.ToolCompleted,
    workflowId,
    toolCallId: call.toolCallId,
    result: output,
  });
  return output;
}

// THE DURABLE AGENT LOOP.
//
// Structurally it's the same while-loop as first commit — but every model call and
// every tool call is a DBOS step. DBOS checkpoints each step's result to
// Postgres. If the process crashes mid-run, DBOS recovers this workflow on the
// next launch and resumes from the last completed step: no repeated LLM calls,
// no duplicate sends, no lost work.
//
// The catch: the workflow body itself re-runs on recovery, so it must be
// deterministic. All non-determinism (the model, the tools, the clock) lives
// inside steps — the body just orchestrates and rebuilds `messages` from the
// cached step results.
async function agentWorkflow(input: string): Promise<string> {
  const workflowId = DBOS.workflowID ?? "unknown";

  await DBOS.runStep(
    () => emit({ type: EventType.WorkflowStarted, workflowId, input }),
    { name: "started" },
  );

  const messages: ModelMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: input },
  ];

  let step = 0;
  while (step < MAX_STEPS) {
    const turn = await DBOS.runStep(() => modelTurn(workflowId, messages), {
      name: `model-${step}`,
    });
    messages.push(...turn.responseMessages);

    if (turn.toolCalls.length === 0) {
      await DBOS.runStep(
        () =>
          emit({ type: EventType.ModelCompleted, workflowId, text: turn.text }),
        { name: `model-done-${step}` },
      );
      await DBOS.runStep(
        () =>
          emit({
            type: EventType.WorkflowCompleted,
            workflowId,
            output: turn.text,
          }),
        { name: "completed" },
      );
      return turn.text;
    }

    for (const call of turn.toolCalls) {
      const output = await DBOS.runStep(() => toolStep(workflowId, call), {
        name: `tool-${call.toolCallId}`,
      });
      // Feed the tool result back to the model on the next turn.
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: "json", value: output as JSONValue },
          },
        ],
      });
    }

    step++;
  }

  await DBOS.runStep(
    () =>
      emit({
        type: EventType.WorkflowFailed,
        workflowId,
        error: `Hit the ${MAX_STEPS}-step limit without finishing.`,
      }),
    { name: "failed" },
  );
  return "";
}

// Register the workflow with DBOS. `runAgentWorkflow` is the durable, recoverable
// version of first commit's `runAgent`.
export const runAgentWorkflow = DBOS.registerWorkflow(agentWorkflow, {
  name: "agentWorkflow",
});
