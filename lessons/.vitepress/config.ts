import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Harness Engineering",
  description: "Course notes for the Harness Engineering & Agent Orchestration workshop",
  // Lesson notes legitimately link to localhost and similar local addresses
  // that vitepress can't resolve at build time.
  ignoreDeadLinks: [/^https?:\/\/localhost/],
  themeConfig: {
    sidebar: [
      { text: "01. The Agent Harness", link: "/01-intro-to-harness-engineering/" },
      { text: "02. Durable Execution", link: "/02-durable-execution/" },
      { text: "03. Sandboxed Tools", link: "/03-secure-sandboxing/" },
      { text: "04. Memory & Context Hydration", link: "/04-advanced-memory/" },
      { text: "05. Routing & Handoffs", link: "/05-orchestration-routing-handoffs/" },
      { text: "06. Supervision", link: "/06-hierarchical-supervision/" },
      { text: "07. Human-in-the-Loop", link: "/07-human-in-the-loop/" },
    ],
  },
});
