---
title: "Trace eve agents with OpenTelemetry"
description: "Send eve's built-in OpenTelemetry spans to Maple with one instrumentation file and see each eve session as one Agent Session."
group: "AI Agents"
order: 17
navLabel: "eve"
icon: "vercel"
---

eve traces every turn, model call, tool call and subagent itself. One file under `agent/instrumentation/` sends those spans to Maple. You don't start an OpenTelemetry SDK, and you don't pass a conversation id, because eve puts its session id on every span.

Outside `eve dev`, eve only exports prompts, replies and tool payloads for conversations its channel classifies as `public`. A deployed agent can show complete sessions with an empty transcript until you [set the audience](#set-the-audience-to-get-a-transcript-in-production).

You need `eve` 0.78 or newer and Node.js 24 or newer.

## Quick setup with a coding agent

Copy this prompt into a coding agent that can run shell commands, such as Claude Code, Codex or Cursor. It installs the [maple-agent-tracing-eve](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-agent-tracing-eve) skill and follows it.

```text
Set up Maple agent tracing for eve in this project.

Install the skill with `npx skills add MapleTechLabs/maple/skills --skill maple-agent-tracing-eve -y`, then follow it.

My Maple ingest key is maple_pk_... and my organization is in the US region.
```

Your ingest key is in **Settings → Ingestion**. If your organization is in the EU region, change `US` to `EU` in the prompt.

## Install the exporter

```bash
npm install @vercel/otel
```

## Add the Maple destination

eve loads every file in `agent/instrumentation/` at startup. Create one for Maple:

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
			// Keep the spans of a conversation; drop the workflow engine's own
			exportPolicy: { span: ({ attributes }) => ({ emit: "gen_ai.conversation.id" in attributes }) },
		})
	: disableInstrumentation()
```

Set `MAPLE_INGEST_KEY` to your ingest key from **Settings → Ingestion**: in `.env.local` for local runs, and in your host's environment variables for deployments.

Keep the `exportPolicy`. Without it eve also exports the spans of its workflow engine, which were 1,031 of the 1,060 spans in a six-message test conversation.

An `agent/instrumentation.ts` left over from eve 0.61 or older fails the build. [Split it into files](https://eve.dev/docs/observability/instrumentation-migration) first.

## Name the service and environment

eve names the service after your `package.json`. To choose the name and add the environment, create the shared settings file:

```ts
// agent/instrumentation/otel.ts
import { otel } from "eve/instrumentation/otel"

export default otel({
	resource: {
		"service.name": "support-agent",
		"deployment.environment.name": "production",
	},
})
```

A project can have only one `otel()` file. If you already have one, add the two attributes to its `resource`.

## Set the audience to get a transcript in production

Every eve channel gives a conversation an audience when the session starts, and the audience decides whether eve exports its content:

| Where it runs | Audience | Maple receives |
| --- | --- | --- |
| `eve dev` | any | Prompts, replies, tool arguments and results |
| Preview or production | `public` | Prompts, replies, tool arguments and results |
| Preview or production | `private` or `unknown` | Turns, model calls, tools, tokens and failures, without their content |

The Slack channel treats public channels as `public`, and DMs, group DMs and private channels as `private`. The HTTP channel treats authenticated callers as `private` and anonymous callers as `unknown`.

To record the content of every conversation on the HTTP channel, set the audience on it:

```ts
// agent/channels/eve.ts
import { localDev, vercelOidc } from "eve/channels/auth"
import { eveChannel } from "eve/channels/eve"

export default eveChannel({
	auth: [vercelOidc(), localDev()],
	audience: "public",
})
```

Keep the `auth` entries your project already uses. The audience doesn't change who may call the agent. It applies to every trace destination, including Vercel Agent Runs, so set it only when recording those conversations is acceptable. For other channels, see [eve's audience docs](https://eve.dev/docs/channels/overview#audience).

A `tracePolicy` in `otel()` can't widen this. It only narrows what the audience allows.

## Check that it works

Run `eve dev`, send two messages with one that calls a tool, then open **Agent Sessions** in Maple. You should see one session per eve session, titled with its first message, one turn per message, and a transcript with the prompts, replies and tool calls. Subagents show as their own lanes inside the turn that called them.

Maple lists the framework as Unidentified for now. With a model called directly at its provider, cost shows as unpriced because eve doesn't report it.

## Troubleshooting

- **Nothing arrives.** eve doesn't log failed exports. Check the startup log for `MAPLE_INGEST_KEY is not set`, then send the key to the endpoint yourself. It answers `200` for a valid key and `401` with the reason for a wrong key or the wrong region:

  ```bash
  curl -s -w "%{http_code}\n" -X POST https://ingest.maple.dev/v1/traces \
    -H "Authorization: Bearer $MAPLE_INGEST_KEY" \
    -H "Content-Type: application/json" -d '{"resourceSpans":[]}'
  ```

- **Sessions arrive without prompts, replies or turn titles.** The conversation's audience is `private` or `unknown`. [Set the audience](#set-the-audience-to-get-a-transcript-in-production).
- **Thousands of `workflow.*`, `world.*` and `step.*` spans.** The destination has no `exportPolicy`.
- **A turn that waited for an approval looks slow.** eve keeps the turn open while it waits, so the wait counts toward the turn and the tool call.
- **A failed tool shows as successful.** The tool returned an error value. Throw from `execute` instead.

## Related

- [Agent Sessions overview](/docs/agent-sessions/overview)
- [eve: OpenTelemetry](https://eve.dev/docs/observability/otel)
