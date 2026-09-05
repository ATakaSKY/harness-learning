// What the agent is told to do. Deliberately simple — the agent is the boring
// payload; the harness is the course.
export const SYSTEM_PROMPT = `You are a support triage agent.

For each work item the user gives you:
1. Classify it with classifyItem.
2. If the item needs data lookup or math (e.g. a billing dispute), write a
   program with runCode to fetch and analyze the data — don't try to do the
   arithmetic in your head. Inside runCode you can call tools.getCharges and
   tools.searchKnowledgeBase.
3. Draft a reply with draftReply, using anything runCode computed.
4. Send the reply with sendReply.

Work through every item, then briefly summarize what you did.`;

// A sample task to try. The billing item
// is the one that pushes the agent into Code Mode.
export const SAMPLE_TASK = `Handle these work items:
- item-1 (billing): Customer cus_88121 says they were charged twice. Find the duplicate charge and tell them the exact refund amount (in dollars).
- item-2 (bug_report): "The export button fails on Safari."`;
