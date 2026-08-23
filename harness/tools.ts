import { tool } from "ai";
import { z } from "zod";

// The tools our triage agent can call. They're fake but realistic.
//
// The important thing for Lesson 1: these run with NO mediation. No sandbox,
// no policy, no approval. `sendReply` actually "emails the customer" the moment
// the model asks for it. That recklessness is the whole point — it's what the
// rest of the course exists to fix.

const KNOWLEDGE_BASE: Record<string, string> = {
  billing:
    "Double charges are usually a duplicate authorization that drops off in 3–5 days. If it already settled, refund immediately.",
  refund: "Refunds post in 5–10 business days. Pro accounts can be expedited.",
  export:
    "The Safari export failure is a known bug (TICKET-4412). Workaround: use Chrome or the CSV export.",
  pricing:
    "Team plans are $20/seat/mo with a volume discount at 25+ seats. For 50+ seats, send the pricing PDF.",
};

export const tools = {
  searchKnowledgeBase: tool({
    description: "Search the support knowledge base for relevant articles.",
    inputSchema: z.object({
      query: z.string().describe("what to look up"),
    }),
    execute: async ({ query }) => {
      const hits = Object.entries(KNOWLEDGE_BASE)
        .filter(([key]) => query.toLowerCase().includes(key))
        .map(([, article]) => article);
      return {
        articles: hits.length ? hits : ["No exact match — use your judgment."],
      };
    },
  }),

  classifyItem: tool({
    description: "Classify a work item into a category.",
    inputSchema: z.object({
      itemId: z.string(),
      category: z.enum(["billing", "technical", "sales", "other"]),
    }),
    execute: async ({ itemId, category }) => ({ ok: true, itemId, category }),
  }),

  draftReply: tool({
    description: "Write a draft reply for a work item. Does not send anything.",
    inputSchema: z.object({
      itemId: z.string(),
      message: z.string(),
    }),
    execute: async ({ itemId }) => ({ ok: true, draftId: `draft-${itemId}` }),
  }),

  sendReply: tool({
    description:
      "Send the drafted reply to the customer. This really emails them.",
    inputSchema: z.object({
      itemId: z.string(),
      draftId: z.string(),
    }),
    // DANGEROUS: an irreversible side effect with zero confirmation.
    execute: async ({ itemId, draftId }) => ({ sent: true, itemId, draftId }),
  }),
};
