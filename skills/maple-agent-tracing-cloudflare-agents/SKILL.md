---
name: maple-agent-tracing-cloudflare-agents
description: "Trace Cloudflare Agents SDK agents (AIChatAgent, Agent on Durable Objects, npm `agents` / `@cloudflare/ai-chat`) with Maple: export the Vercel AI SDK's OpenTelemetry spans from a Worker/Durable Object over fetch, flush per turn, and pass the agent instance name as the conversation id so each chat is one Agent Session with transcript, tool calls, sub-agents and tokens. Triggers on 'trace my cloudflare agent', 'add Maple to cloudflare agents', 'agent sessions for AIChatAgent', 'OpenTelemetry in a durable object agent', 'trace agents sdk on workers'."
---

# Maple agent tracing: Cloudflare Agents SDK

## Goal

One chat (one agent instance) = one Maple Agent Session, one turn per user message, with the transcript, every model call (model, tokens), every tool call (name, args, result, failures), and a lane per sub-agent.

Known gaps (tell the user, don't try to fix): cost shows as "unpriced" (the AI SDK emits no cost). These traces are separate from Cloudflare's native Workers traces (different trace ids); that's expected.

## Step 0: Detect

- `agents` in `package.json`; chat agents extend `AIChatAgent` from `@cloudflare/ai-chat` (or the older `agents/ai-chat-agent`), others extend `Agent` from `agents`. Find every class and every AI SDK call site in them: `streamText(`, `generateText(`, `generateObject(`, `streamObject(`, `new ToolLoopAgent(`, `.generate(`, `.stream(`.
- `ai` version: `>= 7.0.106` required. On 5.x/6.x ask the user to upgrade (`npx @ai-sdk/codemod v7`). `ai@7` also forces `agents >= 0.23`, `@cloudflare/ai-chat >= 0.11`, `@ai-sdk/react@^4`, `workers-ai-provider@^4` (and `@ai-sdk/openai|anthropic@^4`): upgrade them in the same install. On ERESOLVE, regenerate the lockfile. The upgrade can break unrelated agent code (e.g. `chatRecovery = true` now needs `as const`); typecheck and tell the user. Don't use `experimental_telemetry` / `metadata` (v6 API).
- Models via `workers-ai-provider` (`createWorkersAI({ binding: env.AI })`), `@ai-sdk/openai`, `@ai-sdk/anthropic`, AI Gateway: fine at the `^4` majors above; the spans come from the AI SDK, not the provider.
- Agents that call a model without the AI SDK (raw `env.AI.run(...)`, `fetch` to a provider, `@tanstack/ai`): this skill doesn't cover them. Use the `maple-agent-tracing-opentelemetry` skill to write the spans by hand with the same tracer provider from Step 2.
- `wrangler.jsonc`/`wrangler.toml` must have `compatibility_flags: ["nodejs_compat"]` (Agents SDK projects always do; the context manager needs `AsyncLocalStorage`).
- Existing OpenTelemetry in the Worker: search for `@microlabs/otel-cf-workers` (`instrument(`, `instrumentDO(`), `BasicTracerProvider`, `WebTracerProvider`, `registerTelemetry(`, `@sentry/cloudflare`, `@langfuse/otel`, `braintrust`.
  - `registerTelemetry(...)` already exists: extend that call; never call it twice.
  - An existing tracer provider (including otel-cf-workers): add one Maple span processor/exporter to it and pass `tracer: provider.getTracer("gen_ai")` to `OpenTelemetry`; don't build a second provider. Still add the per-turn flush from Step 4 (untested whether otel-cf-workers' own flush covers `AIChatAgent` turns, which run over WebSocket messages and finish after the handler returns). Don't add otel-cf-workers to a project that doesn't have it: this setup doesn't need it (last release May 2025).
  - Cloudflare's native `observability.traces` destinations (Workers Observability) can stay; they export runtime spans (fetch, bindings, DO calls, and the Agents SDK's own `cloudflare.agents.*` spans) but never AI SDK spans, because `@ai-sdk/otel` uses `@opentelemetry/api`, which the native tracer doesn't back.

## Step 1: Key and region

- US `https://ingest.maple.dev/v1/traces`, EU `https://ingest.eu.maple.dev/v1/traces`. The exporter takes the full URL (`/v1/traces` included). Header `authorization: Bearer <key>`.
- Key from the user's prompt; no key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Store it as a Worker secret: `npx wrangler secret put MAPLE_INGEST_KEY`, and `MAPLE_INGEST_KEY=<key>` in `.dev.vars` for `wrangler dev` (check `.dev.vars` is gitignored). Re-run the repo's own type generation afterwards if it uses generated `Env` types (its `types` script, e.g. `npm run types`, or `npx wrangler types <file>`; the output may be `worker-configuration.d.ts`, `env.d.ts`...); otherwise add `MAPLE_INGEST_KEY: string` to the `Env` interface.
- An unset secret becomes `Bearer undefined` and every export 401s with no other hint: confirm the key is in `.dev.vars` (and `npx wrangler secret list` for deploys) before the verification run.
- A 401 `ingest_unauthorized` / "Invalid ingest key" with a key you trust usually means the key belongs to the other region (keys are region-bound): try the other endpoint.
- Follow the repo's existing secret naming if it has one.

## Step 2: Install and create the tracer provider

```bash
npm install ai@^7.0.106 @ai-sdk/otel @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/context-async-hooks
```

Use the repo's package manager. `telemetry.ts` next to the agent classes:

```ts
import { OpenTelemetry } from "@ai-sdk/otel"
import { context, diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { registerTelemetry } from "ai"
import { env } from "cloudflare:workers"

// surfaces export failures
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR)
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

// A missing key disables export; it never stops the Worker.
if (!env.MAPLE_INGEST_KEY) console.warn("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled")

export const tracerProvider = new BasicTracerProvider({
	resource: resourceFromAttributes({
		"service.name": "support-agent",
		"deployment.environment.name": "production",
	}),
	spanProcessors: env.MAPLE_INGEST_KEY
		? [
				new BatchSpanProcessor(
					new OTLPTraceExporter({
						url: "https://ingest.maple.dev/v1/traces",
						headers: { authorization: `Bearer ${env.MAPLE_INGEST_KEY}` },
					}),
				),
			]
		: [],
})

registerTelemetry(
	new OpenTelemetry({
		tracer: tracerProvider.getTracer("gen_ai"),
		usage: true,
		runtimeContext: true,
	}),
)
```

- `service.name`: the Worker's name from the Wrangler config unless the user wants something else. `deployment.environment.name`: take it from an existing env var if the repo has environments; else `production`.
- Import `tracerProvider` from `./telemetry` in every module that defines an agent class (that import also runs `registerTelemetry` at module load). Registration only has to happen before the first AI SDK call, which is always at request time.
- `import { env } from "cloudflare:workers"` at module scope works (secrets included). If the repo's compatibility date or style prevents it, build the provider lazily on first use from `this.env` instead, once per isolate (module-level `let`), never per request.
- `tracer: tracerProvider.getTracer("gen_ai")`: the scope name must stay `gen_ai` (Maple's Vercel AI SDK detection keys on scope `gen_ai`/`ai`). Alternative: `trace.setGlobalTracerProvider(tracerProvider)` and omit `tracer`; both verified.
- The context manager is required for sub-agents: without it, a `generateText` inside a tool's `execute` starts a new trace with no conversation id, which Maple shows as a separate `trace:<id>` session. With it, the sub-agent's `invoke_agent` nests under the parent's `execute_tool` (verified).
- Keep `usage: true` (adds the reasoning-token breakdown, `ai.usage.*`) and `runtimeContext: true` (records the included runtime context keys; Maple reads the conversation id from them).
- The exporter resolves to its browser build under wrangler/esbuild (`workerd`/`browser` conditions), which posts `application/json` via `fetch` with `keepalive`; Maple ingest accepts OTLP JSON. Don't switch to `exporter-trace-otlp-proto` (pulls Node transports) or gRPC (not supported by ingest).
- Don't use `@opentelemetry/sdk-node`, `NodeSDK`, `NodeTracerProvider` or `OTEL_EXPORTER_OTLP_*` env vars: the Node SDK doesn't run on Workers and the browser exporter doesn't read env vars.
- Don't set attribute length limits: they cut the message JSON.

## Step 3: Conversation id

The agent instance name is the conversation id: `this.name` (the DO name from `useAgent({ agent, name })`, `getAgentByName(ns, name)`, or the URL `/agents/<class>/<name>`).

Every AI SDK call in the agent must pass both:

```ts
runtimeContext: { conversationId: this.name },
telemetry: { functionId: "support_agent", includeRuntimeContext: { conversationId: true } },
```

AIChatAgent (the common case):

```ts
import { AIChatAgent } from "@cloudflare/ai-chat"
import { convertToModelMessages, streamText } from "ai"
import { tracerProvider } from "./telemetry"

export class ChatAgent extends AIChatAgent<Env> {
	async onChatMessage() {
		const result = streamText({
			model,
			messages: await convertToModelMessages(this.messages),
			tools,
			runtimeContext: { conversationId: this.name },
			telemetry: { functionId: "support_agent", includeRuntimeContext: { conversationId: true } },
		})
		return result.toUIMessageStreamResponse()
	}

	protected async onChatResponse() {
		await tracerProvider.forceFlush()
	}
}
```

- Check the client: `useAgent({ agent: "ChatAgent" })` without `name` connects every user to the `default` instance, so all chats share one DO, one message history and one session. That's an app bug beyond tracing; tell the user and pass a per-chat id as `name` if they agree.
- If the app keeps several conversations inside one agent instance (for example one agent per user with a thread list), use the thread id instead of `this.name` (from `options.body` of `onChatMessage(onFinish, options)` if the client sends it, or from the app's own state). It must be stable for the whole conversation and differ between conversations.
- If `runtimeContext` already exists, add `conversationId` to it and to `includeRuntimeContext`; keep other keys excluded (they may hold secrets).
- `ToolLoopAgent` inside an agent: add `callOptionsSchema: z.object({ conversationId: z.string() })` + `prepareCall: ({ options, ...rest }) => ({ ...rest, runtimeContext: { conversationId: options.conversationId } })` + the `telemetry` above, and call it with `options: { conversationId: this.name }`.
- Tool approvals / client-side tools: the continuation after the approval or client tool result is a new `onChatMessage` call (`options.continuation === true`) and a new trace. It uses the same `this.name`, so it lands in the same session as an extra turn. `onChatResponse` fires for it too.
- Sub-agents called from a tool's `execute`: give each its own `functionId`; it doesn't need the conversation id (the context manager nests it). Agents SDK sub-agents that are separate agent instances (`this.subAgent(...)`, `getAgentByName` from inside a tool) are reached over RPC; don't rely on trace context crossing that boundary (untested). Pass the parent's conversation id as an RPC argument, use it in the child's `runtimeContext`, and flush in the child. Expect the child's calls as separate turns of the same session rather than a nested lane.

## Step 4: Flush

A DO with hibernatable WebSockets (every `AIChatAgent`) can be evicted between messages; the `BatchSpanProcessor`'s 5 s timer is not guaranteed to fire. Flush at the end of every turn.

- `AIChatAgent`: `protected async onChatResponse() { await tracerProvider.forceFlush() }` (the base declares it `protected`). It runs after the stream finished and the assistant message was persisted, so every span of the turn has ended (verified: all of a turn's spans have arrived by the end of the turn; turns over 5 s may span several POSTs). If the class already overrides `onChatResponse`, add the flush at its end.
- `Agent` methods that call a model (`onRequest`, `onMessage`, `@callable()` methods, `schedule` callbacks, `onEmail`, queue/workflow steps): wrap in `try { ... } finally { this.ctx.waitUntil(tracerProvider.forceFlush()) }`, or `await tracerProvider.forceFlush()` in the `finally` if the method returns after the stream is fully read.
- Streams returned to the client from an `Agent.onRequest` or a Worker `fetch` (`toUIMessageStreamResponse()` / `toTextStreamResponse()`): the spans end only after the stream has been read, after any `finally` ran. Use `this.ctx.waitUntil(result.consumeStream().then(() => tracerProvider.forceFlush()))` before returning the response (verified: one POST with every span, client still receives the full stream). Flushing from `streamText({ onFinish })` or `onEnd` is too early: the root `invoke_agent` span ends after those callbacks and misses the flush.
- Worker `fetch` handlers (outside a DO) that call a model without streaming the reply: `ctx.waitUntil(tracerProvider.forceFlush())` after building the response.
- Never `shutdown()` the provider per request; it's shared by the isolate.

## Step 5: Content, tools, errors

- Content (prompts, replies, tool args/results) is recorded by default. Only set `recordInputs: false` / `recordOutputs: false` in a call's `telemetry` if the user asks; the transcript is empty for those calls.
- Tool failures must throw from `execute` to show as failed. If a tool returns `{ error }` for real failures, change it to throw (ask first if the model relies on the payload).
- Set a distinct `telemetry.functionId` on every call/agent (snake_case). It becomes `gen_ai.agent.name`. The class name isn't exported.
- Don't pass `telemetry.integrations` on a call unless it includes the `OpenTelemetry` instance: it replaces the global integrations for that call.
- Images/files in messages are recorded as base64 on every step; if exports fail with 413, suggest `recordInputs: false` on those calls.

## Step 6: Verify

Local, with no Maple key needed: run a throwaway OTLP receiver (e.g. a `Bun.serve` on `127.0.0.1:<free port>` that appends each `POST /v1/traces` JSON body to a file), point the exporter `url` at `http://127.0.0.1:<port>/v1/traces` temporarily, `npx wrangler dev`, and drive the agent:

- `AIChatAgent` without a browser: open `ws://127.0.0.1:8787/agents/<kebab-class-name>/<name>` and send `{"type":"cf_agent_use_chat_request","id":"<uuid>","init":{"method":"POST","body":"{\"messages\":[{\"id\":\"m1\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"...\"}]}]}"}}`; the turn is done at the `cf_agent_use_chat_response` frame with that `id` and `done: true`. Turn 2+ must send the full history: the last `cf_agent_chat_messages` broadcast's messages plus the new user message, with `"trigger":"submit-message"` in the body. The server replaces its stored history with what it receives, so sending only the new message drops turn 1.
- Put this in a small driver script: one conversation id (instance name), 2+ turns, at least one tool call.
- Model without keys: `MockLanguageModelV4` from `ai/test` with a `doStream` that returns a `tool-call` chunk when the last prompt message isn't a tool result, then text.

Check in the received spans: scope `gen_ai`; per turn one trace with `invoke_agent` (root) → `step n` → `chat` + `execute_tool`; `ai.settings.context.conversationId` = the instance name on `invoke_agent`, same across turns and different per chat; `gen_ai.agent.name` = the `functionId` on `invoke_agent` (only there); `gen_ai.input.messages` on turn 2 contains turn 1's history; `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` on `execute_tool`; `gen_ai.usage.input_tokens` / `output_tokens` on every `chat`; all of a turn's spans have arrived by the end of the turn (flush works; turns over 5 s may span several POSTs); a sub-agent's `invoke_agent` has the parent's `execute_tool` as parent. Restore the Maple URL afterwards.

Then against Maple: the `wrangler dev` output shows no export errors (the diag logger prints 401 / `export response failure` lines); silence without the local receiver check proves nothing (no spans also looks silent). With the Maple MCP, `list_agent_sessions` with `search=<instance name>` returns one row; `get_agent_session` (or the Agent Sessions page, ~30 s after a run) shows one session per chat named after the instance name, framework **Vercel AI SDK**, turns = user messages (plus approval continuations), transcript with prompts/replies/tool calls, tokens on every model call, cost unpriced (expected), no attribute containing the provider API key or `Bearer `.

## Do not

- Do not add a second AI SDK tracer that also exports to Maple (Langfuse/Braintrust/Sentry AI integrations): every model call gets recorded twice.
