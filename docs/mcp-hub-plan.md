# MCP Hub plan

Observability for any MCP server that sends OpenTelemetry to Maple: which tools get called, by
which clients, how they fail, how slow they are and what they cost the agent in tokens. Maple's own
MCP server (`maple-ai`) is the first server in the hub.

Status: plan, nothing built. Mockup built from real `maple-ai` data (Oct 25 to Nov 1, 2026).

## The spec

MCP conventions live in the GenAI registry
([`semantic-conventions-genai/docs/gen-ai/mcp.md`](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md)),
split out of semantic-conventions at v1.44.0. The registry has no releases; everything is
`development`. semconv.com/domains/mcp lists the attributes, spans, metrics and the prose rules.

| Concept         | Attribute / rule                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Span            | `{mcp.method.name} {target}` (`tools/call run_sql`), kind SERVER on the server                                            |
| Method          | `mcp.method.name` (required)                                                                                              |
| Tool / prompt   | `gen_ai.tool.name`, `gen_ai.prompt.name`; `gen_ai.operation.name = execute_tool` on tool calls only                       |
| Session         | `mcp.session.id` (recommended)                                                                                            |
| Protocol        | `mcp.protocol.version`, `jsonrpc.request.id`, `network.transport` (`tcp` / `pipe`), `client.address`                      |
| Tool failure    | `isError: true` → `error.type = tool_error`                                                                               |
| JSON-RPC error  | `rpc.response.status_code` and `error.type` = the code; `-32700/-32600/-32601/-32602/-32002` are NOT errors on the server |
| Parent          | from `params._meta` `traceparent` (we ignore `tracestate`/`baggage`); the HTTP span is a **link**                         |
| Opt-in payloads | `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.prompt.variable.<name>`                                  |
| Metrics         | `mcp.server.operation.duration`, `mcp.server.session.duration`: histograms, seconds, buckets `[0.01 … 300]`               |
| Client identity | **not in the spec.** No `clientInfo` attribute exists                                                                     |

## What `maple-ai` sends today

- `McpServer.@effect/mcp/2025-06-18/<method>` SERVER spans with `rpc.method` and `rpc.system.name`.
- `McpToolDispatcher.call`: `maple.mcp.tool`, `result.isError`, `maple.mcp.error.category`,
  `maple.mcp.error.message`, `maple.mcp.result.chars`.
- HTTP `POST /mcp` parent span: `user_agent.original`, `client.address`, country, rate-limit outcome.

Findings from that data:

- 590 tool calls returned `isError` in 7 days, only 121 had span status Error. Status code alone
  makes an MCP server look healthy.
- 343 of the 590 were bad input from the agent (mostly `run_sql`), 121 real query errors.
- 2.2 `initialize` per `tools/call` was our own transport: it synthesises a handshake before every
  non-initialize request (stateless Workers). Phase 1 stops recording that synthetic span.
- 21 of 101 tools were never called.
- Response size is a usable proxy for tokens the agent reads (`list_error_issues` ≈ 1.5k/call).

## Phase 1: emit the spec from `apps/ai/src/mcp` (built)

Implemented in `apps/ai/src/mcp/transport/span-conventions.ts` with no Effect patch: the transport
gives each message a tracer that renames and annotates the `RpcServer` span, sets the message's
`traceId`/`spanId` from `params._meta` (`RpcServer` then parents and links), and drops the synthetic
handshake's span. Caller trace context is always recorded, whatever its sampled flag. The stateless
transport issues no session, so there is no `mcp.session.id`, and `clientInfo` is only on real
`initialize` spans; per-call client identity is `user_agent.original`. Ingest skips SERVER spans with
`mcp.method.name` in AI vendor detection (`apps/ingest/src/ai_session.rs`), otherwise every
spec-following MCP server became an `unknown:genai` agent session.

Original plan:

- Server spans: name `{method} {tool}`, `mcp.method.name`, `gen_ai.tool.name`,
  `gen_ai.operation.name = execute_tool` (tools/call only), `mcp.protocol.version`,
  `mcp.session.id`, `jsonrpc.request.id`, `network.transport = tcp`, `client.address`.
- Failures: `error.type = tool_error` for `isError`; keep `maple.mcp.error.category` for the finer
  split. JSON-RPC errors set `rpc.response.status_code`; the caller-error codes stay status Unset.
- Context: extract `params._meta` as parent and link the HTTP span. **This breaks the
  user-agent join through the trace**, so copy client identity onto the MCP span:
  `maple.mcp.client.name` / `maple.mcp.client.version` from `initialize` `clientInfo` (keyed by
  session), falling back to `user_agent.original`.
- Keep `maple.mcp.tool` and `result.isError` until the hub no longer reads old data.
- **Agent Sessions gotcha:** the agent classifier counts `gen_ai.operation.name = execute_tool`
  as an agent tool call. Exclude SERVER spans with `mcp.method.name`, or every MCP server tool call
  shows up as an agent tool call.

## Phase 2: queries and pages

Queries in `packages/query-engine/src/ch/queries/mcp.ts`, each with one coalesced expression:

- tool: `gen_ai.tool.name`, then `maple.mcp.tool`
- failed: `error.type = 'tool_error'` or `result.isError = 'true'` or a JSON-RPC error code outside
  the caller-error list
- client: `maple.mcp.client.name`, then a user-agent family

Pages (Foldkit, reuse `agent-sessions/tools-kit`):

1. `/mcp`: servers (services with `mcp.method.name` SERVER spans), calls, failure rate, p95, top client.
2. `/mcp/:service`: metric strip, calls with tool errors over time, tools table (calls, failed,
   top failure kind, p50/p95, response tokens), clients, why calls fail (agent input vs server),
   protocol methods, never-called tools, data coverage checklist.
3. `/mcp/:service/tools/:tool`: latency and failures, error samples, slowest calls → trace.
4. `/mcp/:service/sessions/:id`: needs `mcp.session.id`; links to the matching Agent Session via
   `params._meta` parentage.

Raw `traces` first; measure with `bun run bench:queries`, then decide on an hourly `mcp_calls`
rollup (`docs/warehouse-rollups.md`).

## Phase 3+

- Sessions view and the Agent Sessions cross-link.
- Alert templates: tool failure rate, p95 per tool.
- MCP tools: `list_mcp_servers`, `mcp_tool_overview`.
- Setup docs for TypeScript, Python and Go MCP servers, linking semconv.com/domains/mcp; decide
  whether to ship an `instrumentMcpServer(server)` wrapper (customer-facing SDK, own review bar).

## Open questions

- Nav: own "MCP" item, or one "AI" area with Agent Sessions?
- Hide or group internal clients (`executor` is 140k of ~200k requests).
- Plan gating for the hub.
