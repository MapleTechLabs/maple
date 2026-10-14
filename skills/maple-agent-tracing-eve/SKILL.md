---
name: maple-agent-tracing-eve
description: "Trace eve agents (Vercel's eve framework, npm `eve`) with Maple: add one OpenTelemetry destination file under agent/instrumentation/ so each eve session is one Maple Agent Session with transcript, tool calls, subagent lanes, approvals and tokens. Covers eve dev, eve start, the channel audience that gates message content, and dropping the workflow engine's spans. Triggers on 'trace my eve agent', 'add Maple to eve', 'agent sessions for eve', 'OpenTelemetry for eve'."
---

# Maple agent tracing: eve

## Goal

One eve session (`wrun_...`) = one Maple Agent Session. One user message = one turn = one trace rooted at `invoke_agent <agent>`, with `agent.step` spans holding a `chat <model>` span (model, provider, tokens, messages) and `execute_tool <tool>` spans (arguments, result, failures). Subagents nest inside the caller's trace and show as their own lanes.

eve owns the tracer provider and writes `gen_ai.conversation.id` (the root session id) on every agent span. You add a destination; you never start an SDK and never pass a conversation id.

Known gaps (tell the user, don't try to fix):

- Outside `eve dev`, message content is exported only for `public` conversations (Step 4).
- Cost shows as unpriced with a model called directly at its provider. With Vercel AI Gateway, eve writes `gen_ai.usage.cost` on the `agent.step` span; Maple counts it in the session total (the per-model table has tokens, not cost).
- eve does not log failed exports (Step 6).

## Step 0: Detect

- `eve` version in `package.json` / lockfile.
  - `>= 0.62`: this skill. Exercised on 0.62.0, 0.70.3, 0.72.1, 0.77.0 and 0.78.0 with the Step 2/3 files unchanged; every version produced complete sessions in Maple.
  - `0.62` to `0.71`: each tool call is an `agent.action` span wrapping `execute_tool`. Maple shows the wrapper as a structure row and counts one tool call. Expected.
  - `< 0.62`: telemetry lives in `agent/instrumentation.ts` (`defineInstrumentation({ setup })` calling `registerOTel`), and eve ignores `agent/instrumentation/` without an error: the Step 2 files export nothing (tested on 0.61.1). With `experimental: { instrumentationProviders: true }` in `agent.ts` they export, but the `exportPolicy` is ignored and every workflow span goes out. Don't use the flag: upgrade (`npm install eve@latest`), delete `agent/instrumentation.ts` (until then `eve build` fails with `Found removed instrumentation file`), remove the flag, then do Steps 2-3. Move every other exporter from the old `setup` into its own `otelIntegration({ traceExporter })` file; `serviceName` becomes `otel({ resource })`, `functionId` becomes `otel({ functionId })`, `events["step.started"]` runtime context becomes `otelIntegration({ runtimeContext })`. See https://eve.dev/docs/observability/instrumentation-migration.
  - Tell the user: from 0.35 to 0.61 the old file recorded no content unless `recordInputs`/`recordOutputs` were set (before 0.35 it recorded content by default); after the upgrade, content is recorded during `eve dev` and for `public` conversations (Step 4). The first `eve dev` after the upgrade deletes the local `.eve/.workflow-data` (incompatible storage layout), so open local dev sessions are lost.
- Node.js `>= 24` at runtime; eve enforces it. bun or pnpm as the package manager is fine.
- Layout: one agent in `agent/`, or a workspace with `agents/<name>/agent/`. In a workspace add the files to each member's `agent/instrumentation/` (not exercised; run Step 7 per member).
- Existing files in `agent/instrumentation/`:
  - An `otel()` file: add the resource attributes from Step 3 to it. Two `otel()` files are a boot error.
  - Other `otelIntegration()` files (Honeycomb, Braintrust, Datadog...): keep them. Maple is one more file; each destination has its own `exportPolicy`.
  - `agent-runs.ts`, `local.ts`: leave them.
- Search for `NodeSDK`, `registerOTel(`, `registerTelemetry(`, `@ai-sdk/otel`, `NodeTracerProvider`. eve replaces all of them with `otelIntegration()`; don't add one, and tell the user if one exists.
- `eve` depends on `ai`. Use this skill, not `maple-agent-tracing-vercel-ai-sdk`.
- `agent/skills/maple-agent-tracing-eve/` exists (an `npx skills add` run in an eve project installs into the eve agent's own skills, and `skills-lock.json` records it): it would ship with the agent as a runtime skill. Tell the user and remove both the directory and its `skills-lock.json` entry once setup is done, unless they want it there.
- Models: a string id in `agent.ts` (`model: "openai/gpt-…"`) runs through Vercel AI Gateway; a provider object (`openai()` from `eve/models/openai`, `createOpenRouter(...)`, `anthropic()`) calls the provider directly. This decides the cost line in Step 7.

## Step 1: Key and region

- US `https://ingest.maple.dev/v1/traces`, EU `https://ingest.eu.maple.dev/v1/traces`. The exporter takes the full URL. Header `authorization: Bearer <key>`.
- Key in the user's prompt: use it. No key: use the literal `MAPLE_TEST` (ingest accepts and discards it) and tell the user to replace it with their key from Settings → Ingestion.
- Private `maple_sk_` keys never go in browser code. Ingest keys are write-only.
- eve loads `.env.local` for `eve dev` and `eve start`: put `MAPLE_INGEST_KEY=<key>` there (check it is gitignored). Deployments read the host's environment variables.
- Instrumentation files run at server start, not at build: `eve build` works without the key.
- Never let an unset variable become `Bearer undefined`. When the key is missing, log one warning and export `disableInstrumentation()` so the agent runs normally (Step 2 does this).
- A 401 `ingest_unauthorized` with a key you trust usually means the key belongs to the other region: try the other endpoint.

## Step 2: Install and add the destination

```bash
npm install @vercel/otel
```

Use the repo's package manager. Create `agent/instrumentation/maple.ts`:

```ts
import { OTLPHttpProtoTraceExporter } from "@vercel/otel"
import { disableInstrumentation } from "eve/instrumentation"
import { otelIntegration } from "eve/instrumentation/otel"

// A missing key disables export; it never stops the agent.
const mapleKey = process.env.MAPLE_INGEST_KEY
if (!mapleKey) console.warn("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled")

export default mapleKey
	? otelIntegration({
			traceExporter: new OTLPHttpProtoTraceExporter({
				url: "https://ingest.maple.dev/v1/traces",
				headers: { authorization: `Bearer ${mapleKey}` },
			}),
			// Keep the spans of a conversation; drop the workflow engine's own
			exportPolicy: { span: ({ attributes }) => ({ emit: "gen_ai.conversation.id" in attributes }) },
		})
	: disableInstrumentation()
```

- The file name is free; it must default-export the integration.
- eve wraps `traceExporter` in its own batch processor (5 s delay, flushes on shutdown). Don't wrap it in a `BatchSpanProcessor` yourself.
- The `exportPolicy` is required in practice. eve's second scope, `workflow`, is the durable-execution engine: `workflow.*`, `world.*`, `step.*`, `hook.resume`, `queue.publish`, including one `workflow.stream.flush` span per streamed chunk. In two test runs it was 1,031 of 1,060 and 1,794 of 1,829 spans, all in traces of their own with no `gen_ai.conversation.id`.
- The policy decides at span start. Every eve agent span has `gen_ai.conversation.id` at start. Per eve's docs the id is also on third-party instrumentation spans created during model, tool and memory execution; spans outside those (for example `agent.channel.request` with `traceChannelRequests: true`) are dropped by this policy.
- The user wants the workflow spans too: remove `exportPolicy` and tell them the volume.

## Step 3: Service name and environment

Without settings, `service.name` is the `package.json` name. Create `agent/instrumentation/otel.ts`, or extend the existing `otel()` file:

```ts
import { otel } from "eve/instrumentation/otel"

export default otel({
	resource: {
		"service.name": "support-agent",
		"deployment.environment.name": process.env.VERCEL_ENV ?? "development",
	},
})
```

- Use the app's own environment variable for the environment (`VERCEL_ENV` on Vercel).
- `gen_ai.agent.name` is the `package.json` name for the root agent and the directory name for a declared subagent (`agent/subagents/<name>/`). They are the lane names in Maple.

## Step 4: Content and audience

eve attaches content to spans only when the conversation's audience allows it. The channel assigns the audience once, when the session starts:

| Runs as | Audience | Content exported |
| --- | --- | --- |
| `eve dev` | any | yes |
| preview / production (`eve start`, Vercel) | `public` | yes |
| preview / production | `private` / `unknown` | no |

- Without content the session still has turns, model calls, tools, tokens and failures. Missing: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, the session title and the turn labels.
- Defaults: HTTP channel (`eveChannel`): authenticated `user`/`service`/`runtime` principals are `private`, anonymous callers `unknown`. Slack: public channels `public`; DMs, group DMs and private channels `private`.
- `otel({ tracePolicy })` cannot widen this. Tested on `eve start` with a `private` caller and a policy returning `{ emit: true, recordInputs: true, recordOutputs: true }`: the spans say `agent.trace.content.input=true` and still carry no content. The policy only narrows.
- The lever is the channel. HTTP channel: `eveChannel({ auth: [...], audience: "public" })` in `agent/channels/eve.ts`. The file replaces the whole default channel, so keep the `auth` list the project already uses. `audience` also takes a function; a custom channel has an `audience()` hook. See https://eve.dev/docs/channels/overview#audience.
- Ask the user before setting `audience: "public"`. It is a data decision: it applies to every trace destination, including Vercel Agent Runs, not only Maple. Don't set it on your own.
- To keep content out of Maple while other destinations keep it, add a second policy to the Maple destination:

```ts
exportPolicy: [
	{ span: ({ attributes }) => ({ emit: "gen_ai.conversation.id" in attributes }) },
	{ span: () => ({ redact: true, inputs: true, outputs: true }) },
],
```

- Each content attribute is capped at 32,768 characters by eve.

## Step 5: Tools, subagents, approvals

- A tool's span name and `gen_ai.tool.name` are its file name under `agent/tools/`.
- Failures must throw. Thrown: span status ERROR with the message, `error.type=ACTION_RESULT_FAILED`, an `exception` event; Maple counts the tool call as failed. A returned `{ error }` counts as success.
- Declared subagents: the call is `execute_tool <subagent>` and returns a task receipt within ~0.1 s; the child's `invoke_agent <subagent>` nests under it in the same trace. In Maple the lane's result is the receipt text ("Started task ..."), and the real result arrives through the framework tool `eve__task_wait`. Expected.
- Framework tools (`eve__task_wait`, `bash`, `read_file`...) are tool calls like any other.
- Approvals (`approval: always()` and friends): eve adds an `agent.approval` span under the tool call. The turn stays open while it waits, so the wait counts toward the turn's and the tool call's duration. A denied call is a failed tool call with `error.type=TOOL_EXECUTION_DENIED`, which raises Maple's "Tool errors" check. Expected.
- Tokens: `invoke_agent` spans repeat the turn total and `agent.step` repeats the call's usage under `agent.usage.*`. Maple counts the `chat` spans only; totals are not doubled.

## Step 6: Flush and silent failures

- Add no flush code. On `eve start`, a SIGTERM right after a turn still delivered every span. Vercel deployments were not exercised.
- eve does not report a failed export, also not with `EVE_LOG_LEVEL=warn`. A wrong key or region looks exactly like no traffic. Test the key directly:

```bash
curl -s -w "%{http_code}\n" -X POST https://ingest.maple.dev/v1/traces \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" -d '{"resourceSpans":[]}'
```

`200` = valid. `401` prints the reason, including the right endpoint when the key is from the other region.

## Step 7: Verify

Run one real conversation: `eve dev` (or `eve dev --no-ui` plus a script on `eve/client`), 2+ messages in one session, one of them calling a tool; plus a second session. If the project has subagents or an approval-gated tool, exercise each once. Then check (Maple MCP `list_agent_sessions` filtered by service, `get_agent_session_transcript`, or the Agent Sessions page, ~30 s after the run):

- The startup log has no `MAPLE_INGEST_KEY is not set`.
- One session per eve session, id `wrun_...`; the second session is separate; no `trace:<id>` sessions.
- One turn per user message, labeled with the message. A turn paused for an approval is still one turn.
- Transcript shows user messages, the system instructions, assistant replies and tool calls with arguments and results.
- Every `chat <model>` span has model, provider, input and output tokens. LLM calls = number of `chat` spans.
- A throwing tool is failed with its message; successful tools are not.
- Subagents show as lanes named after their directory, inside the calling turn.
- No span named `workflow.*`, `world.*`, `step.*`, `hook.*` or `queue.*` for the service (Maple MCP `search_traces`, or the Traces page).
- Framework shows **eve**, not Unidentified.
- Cost: present for AI Gateway models, unpriced for direct provider models (see Known gaps).
- Then start the production build once (`eve build && eve start`) and send one message. Expect the session without content unless the audience is `public`; tell the user which it is.

Without Maple access: the curl check in Step 6 returns `200`, the startup log is clean, and a conversation ran. That shows delivery is possible, not that spans arrived; say so.

## Do not

- Do not start `NodeSDK`, `registerOTel` or `registerTelemetry`, and do not add `@ai-sdk/otel`, OpenLLMetry or OpenInference: eve already traces every model call.
- Do not stamp `gen_ai.conversation.id` or `maple_ai.session.id` yourself.
- Do not add a second `otel()` file.
- Do not set `audience: "public"` without the user's decision.
