---
title: "MCP Servers"
description: "See the tools agents call on your MCP server, the clients calling them, why calls fail, and each session and user, from the OpenTelemetry spans your server already emits."
group: "MCP Servers"
order: 1
navLabel: "Overview"
---

**MCP servers** lists every service that answers MCP requests. For each one it shows the tools agents call, the clients calling them, why calls fail, and the sessions and users behind the calls. Maple reads the spans your server emits under the [OpenTelemetry MCP conventions](https://semconv.com/domains/mcp). There is no separate SDK and no second call to make.

## What Maple reads

Every request is a `SERVER` span carrying `mcp.method.name`.

| Attribute                   | What Maple does with it                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `mcp.method.name`           | Marks the span as an MCP request: `tools/call`, `initialize`, `tools/list`...         |
| `gen_ai.tool.name`          | The tool a `tools/call` called.                                                       |
| `error.type`                | Set when a call failed: `tool_error` for an `isError` result, else the JSON-RPC code. |
| `error.message`             | Why it failed, to group failures by cause. The span's status message also works.      |
| `user_agent.original`       | The client: Claude Code, Cursor, Codex, curl...                                       |
| `user.id` (or `enduser.id`) | The end user: a column, a filter, user counts, and sessions.                          |
| `user.name`, `user.email`   | How the user is shown; the id when neither is set.                                    |
| `mcp.session.id`            | Groups an older, stateful server's requests into its own sessions.                    |

## Identify the user

Set `user.id` on each MCP request's span, in the handler that already knows who is calling: the one that checks the API key or the OAuth token. It is the standard OpenTelemetry attribute, so nothing Maple-specific goes into your server.

```ts
span.setAttributes({
	"user.id": user.id, // required to count and group by user
	"user.name": user.name, // optional, shown instead of the id
	"user.email": user.email, // optional, shown when there is no name
})
```

With the Effect SDK the same keys go through `Effect.annotateCurrentSpan`:

```ts
yield * Effect.annotateCurrentSpan({ "user.id": user.id, "user.name": user.name })
```

Send an id you already use for the user, never a secret: it is stored with the span and shown on the page.

## Sessions

MCP is stateless from spec version 2026-07-28: there is no `initialize` handshake and no `Mcp-Session-Id`, and every request is authenticated on its own. Maple builds sessions from `user.id` instead. It joins one user's calls from one client and starts a new session after 30 minutes without a request, so the attribute from [Identify the user](#identify-the-user) is all a session needs.

A server on an earlier spec version that issues an `Mcp-Session-Id` can record it as `mcp.session.id` on every server span. Those requests group into the session the server issued, and both kinds list side by side. Calls with neither a user nor a session id belong to no session.

Each session lists its requests in order, the tools it called, and the trace behind every request. When the client sends its trace context in `params._meta`, the session also links to the [Agent Session](/docs/agent-sessions/overview) that made each call.
