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
| `user_agent.original`       | The client: Claude Code, Cursor, Codex, curl...                                       |
| `mcp.session.id`            | Groups a stateful server's requests into sessions.                                    |
| `user.id` (or `enduser.id`) | The end user: a column, a filter, user counts, and sessions on a stateless server.    |
| `user.name`, `user.email`   | How the user is shown; the id when neither is set.                                    |

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

A server on a stateful transport issues an `Mcp-Session-Id`. Record it as `mcp.session.id` on every server span and each client's requests group into one session.

A stateless server issues no session. Its calls still form sessions when they carry `user.id`: Maple joins one user's calls from one client and starts a new session after 30 minutes without a request. Calls with neither a session id nor a user belong to no session.

Each session lists its requests in order, the tools it called, and the trace behind every request. When the client sends its trace context in `params._meta`, the session also links to the [Agent Session](/docs/agent-sessions/overview) that made each call.
