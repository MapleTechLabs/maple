---
title: "See how agents use your MCP server"
description: "A new MCP servers page shows the tools agents call, the clients calling them, why calls fail, and each session and user, from the spans your server already sends."
date: 2026-11-01
category: ai
authors: [makisuo]
---

If you run an **MCP server**, **Explore → MCP servers** now shows how agents use it. Maple reads
the spans your server already emits under the OpenTelemetry MCP conventions. There is no extra SDK
or second call to make.

- **The list** has every service that answers MCP tool calls, with calls, failure rate, p95,
  tool count, top client and a volume sparkline.
- **A server's page** charts calls, failures, latency and clients, and breaks them down by tool,
  client (Claude, Cursor and so on), failure kind and MCP method.
- **A tool's page** groups its errors by type and message, and lists the slowest, failed and
  recent calls, each linking to its trace.
- **Sessions** group a server's requests by MCP session, in order, linked to the agent session
  that made them and to the user behind it.

A server that doesn't send what a view needs gets a checklist of the attributes to add, not an
empty table.

Connecting your own agent to Maple is also quicker: the **Connect** panel in the top bar has a
copy-paste command for Claude Code and one-click install links for Cursor and VS Code.

Read more in [MCP servers](/docs/mcp-servers/overview).
