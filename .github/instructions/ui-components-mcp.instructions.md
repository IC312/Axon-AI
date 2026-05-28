---
description: "Use when user asks to find, compare, add, install, or wire UI components, animations, backgrounds, shadcn, or React Bits. Prioritize MCP tools for component discovery and usage."
---

# UI Components via MCP

## Goal
Use MCP servers first so UI component requests are handled automatically with fewer manual steps.

## Workflow
1. For discovery, call MCP tools to list or search component catalogs before writing custom UI code.
2. Prefer `reactbits` MCP for animated/background/visual effect components.
3. Prefer `shadcn` MCP for install and project wiring from configured registries (including `@react-bits`).
4. When user asks to "add/install/apply" a component, perform installation and integration directly.
5. Return a concise result with what was added and where it was wired.

## Guardrails
- Reuse existing styles and architecture in this repository.
- Do not add unnecessary dependencies when an MCP-provided component already fits.
- If MCP server is unavailable, state it clearly and fall back to manual implementation.
