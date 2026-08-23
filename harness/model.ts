import { createGoogleGenerativeAI } from "@ai-sdk/google";

// The one place the model is configured.
// Default: gemini-3.5-flash-lite — lightest Gemini model, best free-tier headroom.
// For stronger reasoning: "gemini-3-flash" or "gemini-2.5-pro" (lower limits).
//
// Reads GOOGLE_GENERATIVE_AI_API_KEY from the environment (or GEMINI_API_KEY as
// a fallback). The server loads .dev.vars on startup via dotenv.
const google = createGoogleGenerativeAI({
  apiKey:
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
});

export const model = google("gemini-3.5-flash-lite");
