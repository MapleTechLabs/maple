---
title: "Claude Code sessions show tokens, tools and prompts"
description: "Send Claude Code's telemetry to Maple and Agent Sessions shows each turn's prompt, token usage per model call, and every tool call once."
date: 2026-09-24
category: agent-sessions
authors: [jeremyfunk]
---

Claude Code sessions in **Agent Sessions** now carry the detail you need to review them. Claude
Code's OpenTelemetry output uses its own attribute names, so until now its sessions showed zero
tokens and counted each tool call up to three times. Maple now maps those attributes when the
data arrives:

- Each model call shows input, output and cache tokens, and time to first token.
- Each tool call counts once, with its arguments and result. A failed run marks its tool call as
  failed, with the error.
- Each turn opens with the user's prompt, when Claude Code is set to export prompts
  (`OTEL_LOG_USER_PROMPTS=1`).

Sessions ingested before this change keep their old numbers. Cost is not shown in the session
views yet: Claude Code reports it only on its log events, which you can search under **Logs**.

Get started with the [Claude Code setup](/docs/agent-sessions/overview#claude-code).
