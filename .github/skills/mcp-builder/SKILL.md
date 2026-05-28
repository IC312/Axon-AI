---
name: mcp-builder
description: "Build or improve MCP servers and MCP integration. Use when user asks to create tools/resources/prompts via MCP, configure mcp.json, map tool schemas, or debug MCP server behavior."
---

# MCP Builder

## When to use
- Add a new MCP server to workspace/user config.
- Create or refine MCP tools for external systems.
- Troubleshoot MCP startup, tool discovery, or configuration issues.

## Procedure
1. Define the target workflows first (what tasks the tool must unlock).
2. Configure transport and server command cleanly in `mcp.json`.
3. Design tool inputs/outputs with strict schemas and actionable errors.
4. Validate discoverability: names, descriptions, and safe defaults.

## Quality criteria
- Clear tool naming and minimal ambiguity.
- Structured responses for reliable agent usage.
- No secrets hardcoded; use env variables or secure inputs.
