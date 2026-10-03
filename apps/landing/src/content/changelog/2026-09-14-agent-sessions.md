---
title: "Agent Sessions is available to every organization"
description: "See an AI agent conversation as one session: every turn, model call and tool call, with its cost, timing and failures."
date: 2026-09-14
category: agent-sessions
authors: [jeremyfunk]
---

**Agent Sessions** is now under **Explore** for every organization. It turns the OpenTelemetry
traces your AI agent already sends into sessions you can read turn by turn, so you can see why an
agent was slow, what it cost, and which tool call went wrong.

Sessions are built from spans that follow the OpenTelemetry GenAI semantic conventions. There is
no extra SDK to install, and common agent frameworks are recognized automatically.

For each session you get:

- an overview that splits the wall clock into model time, tool time and idle time, and rolls up
  cost and tokens per model
- the transcript, with each model call's model, tokens, cost and finish reason
- the trace, grouped by turn

A **Tools** view ranks every tool across sessions by call volume, failure rate and latency. The
same data is available to AI assistants through the Maple MCP server.

Get started with the [Agent Sessions guide](/docs/agent-sessions/overview).
