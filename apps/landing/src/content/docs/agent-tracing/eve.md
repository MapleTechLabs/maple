---
title: "Trace eve agents with OpenTelemetry"
description: "Send your eve agent's traces to Maple and see each conversation as one Agent Session."
group: "AI Frameworks"
order: 17
navLabel: "eve"
icon: "vercel"
---

Send your eve agent's traces to Maple and see each conversation as an Agent Session, with its messages, model calls, tool calls, subagents and token usage. The setup is one package and two files.

To see message text from a deployed agent, you also [mark its conversations public](#show-message-text-in-production).

You need `eve` 0.62 or newer and Node.js 24 or newer. On eve 0.61 or older, [upgrade first](#upgrade-from-eve-061-or-older).

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It loads the [maple-agent-tracing-eve](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-eve) skill and follows it.

```text
Set up Maple agent tracing for eve in this project.

Load the skill, then follow it:
npx skills use MapleTechLabs/maple/skills --skill maple-agent-tracing-eve

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Use the **Public key** (`maple_pk_…`) from **Settings → Ingestion**. The agent may write the key into your source code, and a public key can only send telemetry, so it is safe to commit. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Install the exporter

```bash
npm install @vercel/otel
```

## Send traces to Maple

Create `agent/instrumentation/maple.ts`:

```ts
// agent/instrumentation/maple.ts
import { OTLPHttpProtoTraceExporter } from "@vercel/otel"
import { disableInstrumentation } from "eve/instrumentation"
import { otelIntegration } from "eve/instrumentation/otel"

// A missing key disables export; it never stops the agent.
const mapleKey = process.env.MAPLE_INGEST_KEY
if (!mapleKey) console.warn("MAPLE_INGEST_KEY is not set; Maple telemetry export is disabled")

export default mapleKey
	? otelIntegration({
			traceExporter: new OTLPHttpProtoTraceExporter({
				url: "https://ingest.maple.dev/v1/traces", // EU: https://ingest.eu.maple.dev/v1/traces
				headers: { authorization: `Bearer ${mapleKey}` },
			}),
			// Leave out eve's internal workflow spans
			exportPolicy: { span: ({ attributes }) => ({ emit: "gen_ai.conversation.id" in attributes }) },
		})
	: disableInstrumentation()
```

In deployments, set `MAPLE_INGEST_KEY` in your host's environment variables. For local runs, see [Verify](#verify).

Keep the `exportPolicy` line. Without it, eve's internal workflow spans make up most of the data you send.

## Name the service

Without this step, the service in Maple is named after your `package.json`. To choose the name and add the environment, create `agent/instrumentation/otel.ts`:

```ts
// agent/instrumentation/otel.ts
import { otel } from "eve/instrumentation/otel"

export default otel({
	resource: {
		"service.name": "support-agent",
		// Outside Vercel, use your host's environment variable
		"deployment.environment.name": process.env.VERCEL_ENV ?? "development",
	},
})
```

If the project already has an `otel()` file, add the two attributes to it instead. eve allows only one.

## Show message text in production

In `eve dev`, Maple shows every message, reply and tool call. A deployed agent sends that text only for conversations eve treats as public. Other conversations still appear with their turns, model calls, tools and tokens, but without any text.

eve's Slack channel treats public channels as public, and DMs and private channels as private. Its HTTP channel treats no conversation as public until you mark it:

```ts
// agent/channels/eve.ts
import { localDev, vercelOidc } from "eve/channels/auth"
import { eveChannel } from "eve/channels/eve"

export default eveChannel({
	auth: [vercelOidc(), localDev()],
	audience: "public",
})
```

Keep the `auth` list your project already uses. A public channel sends its message text to every trace destination, including Vercel Agent Runs, so mark it public only if storing those conversations is acceptable. For other channels, see [eve's audience docs](https://eve.dev/docs/channels/overview#audience).

## Verify

1. Copy the public ingest key (`maple_pk_…`) from **Settings → Ingestion** ([US](https://app.maple.dev/settings?tab=ingestion) or [EU](https://app.eu.maple.dev/settings?tab=ingestion)) and add it to `.env.local` in your project:

    ```env
    MAPLE_INGEST_KEY=maple_pk_...
    ```

2. Start the agent with `eve dev` and send it two messages, one of which uses a tool. eve sends the traces to Maple a few seconds after each reply.
3. Open **Agent Sessions** in Maple ([US](https://app.maple.dev/agent-sessions) or [EU](https://app.eu.maple.dev/agent-sessions)).

You should see one session for the conversation with framework **eve**, titled with its first message, with one turn per message and the messages, replies and tool calls in its transcript. Subagents show up as separate lanes inside the turn that called them.

Cost shows for models that run through Vercel AI Gateway. With a model called directly at its provider, cost shows as unpriced because eve doesn't report it.

## Upgrade from eve 0.61 or older

eve 0.61 and older ignore the files in this guide without showing an error. Upgrade eve:

```bash
npm install eve@latest
```

Then:

1. Delete `agent/instrumentation.ts`. Newer eve versions refuse to build while it exists.
2. If `agent.ts` sets `experimental: { instrumentationProviders: true }`, remove it.
3. Add the two files from this guide.
4. If the old file did more than send traces to Maple, move each part:

| In the old `agent/instrumentation.ts`                 | After the upgrade                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Another exporter in `registerOTel({ traceExporter })` | Its own file with `otelIntegration({ traceExporter })`                                                     |
| `serviceName`                                         | `service.name` in [`otel.ts`](#name-the-service)                                                           |
| `functionId`                                          | `otel({ functionId })`                                                                                     |
| `recordInputs`, `recordOutputs`                       | Not needed: message text depends on [whether the conversation is public](#show-message-text-in-production) |
| `events["step.started"]` returning `runtimeContext`   | `otelIntegration({ runtimeContext })`                                                                      |

## Troubleshooting

- **Nothing arrives.** eve doesn't report failed exports, so check the key. The startup log must not say `MAPLE_INGEST_KEY is not set`. Then send this request with your key in place of `YOUR_INGEST_KEY`. `200` means the key works; `401` says what is wrong, including a key from the other region:

    ```bash
    curl -s -w "%{http_code}\n" -X POST https://ingest.maple.dev/v1/traces \
      -H "Authorization: Bearer YOUR_INGEST_KEY" \
      -H "Content-Type: application/json" -d '{"resourceSpans":[]}'
    ```

- **Sessions have no message text.** The conversation isn't public. [Mark the channel public](#show-message-text-in-production). Setting a `tracePolicy` in `otel()` doesn't change this.
- **Thousands of `workflow.*`, `world.*` and `step.*` spans.** The `exportPolicy` line is missing from `maple.ts`.
- **A failed tool shows as successful.** The tool returned an error instead of throwing one. Throw from `execute`.

## Next steps

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [eve: OpenTelemetry](https://eve.dev/docs/observability/otel)
