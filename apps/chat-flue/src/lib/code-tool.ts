import type { ToolDefinition } from "@flue/runtime"
import * as v from "valibot"
import type { ChatFlueEnv } from "./env.ts"

/**
 * The Code Mode `code` tool (Cloudflare Code Mode). Instead of calling Maple's
 * ~50 read tools one at a time, the model writes a single JavaScript snippet that
 * calls them as `await maple.<tool>(input)`, chains/filters across the results,
 * and returns the answer — one round-trip for a multi-step investigation.
 *
 * The snippet runs in a Worker-Loader sandbox isolate (no network, only the
 * `maple.*` capability) hosted by apps/api's per-org runtime DO; this tool just
 * forwards the code to `POST /internal/codemode/run` (internal-service auth, org
 * pinned in `x-org-id`, same as `submit_diagnosis`). Tool discovery is progressive:
 * the model uses `codemode.search(query)` / `codemode.describe(name)` inside the
 * snippet to find the right tool and its input shape on demand.
 */
export const CodeToolInputSchema = v.object({
	code: v.string(),
})

/** Output shape returned by `/internal/codemode/run` (the runtime's proxy-tool result). */
type ProxyOutput =
	| { status: "completed"; result?: unknown; logs?: string[] }
	| { status: "paused"; pending?: Array<{ connector: string; method: string }> }
	| { status: "error"; error?: string }

const stringify = (value: unknown): string =>
	typeof value === "string" ? value : JSON.stringify(value, null, 2)

/** Render the runtime output into the text the model reads back. */
const formatOutput = (raw: string): string => {
	let parsed: ProxyOutput
	try {
		parsed = JSON.parse(raw) as ProxyOutput
	} catch {
		return raw
	}

	if (parsed.status === "completed") {
		const logs = parsed.logs?.length ? `Console output:\n${parsed.logs.join("\n")}\n\n` : ""
		return `${logs}${parsed.result === undefined ? "(no value returned)" : stringify(parsed.result)}`
	}
	if (parsed.status === "paused") {
		const names = (parsed.pending ?? []).map((p) => p.method).join(", ")
		return `Paused for approval: ${names || "pending change"}. The change is awaiting the user's approval and has not been applied.`
	}
	return `Error: ${parsed.error ?? "code mode run failed"}`
}

const DESCRIPTION = [
	"Run JavaScript to investigate this Maple organization's observability data in one step.",
	"",
	"Call Maple's tools as `await maple.<tool>(input)` and compose them — loop, filter, correlate across",
	"calls — then `return` the answer. Read tools (errors, traces, logs, metrics, services, dashboards,",
	"alerts, sessions) run immediately; tools that change state pause for the user's approval.",
	"",
	"Discover tools on demand inside your snippet:",
	"- `await codemode.search('slow traces')` → find relevant tool names",
	"- `await codemode.describe('find_slow_traces')` → see a tool's input shape",
	"",
	"Each `maple.<tool>()` returns text that includes a `Structured content:` JSON block — `JSON.parse`",
	"the JSON to filter and feed into the next call. Prefer ONE snippet that does the whole investigation",
	"over many separate tool calls.",
	"",
	"Example:",
	"```js",
	"const errors = await maple.find_errors({ lookbackMinutes: 60 });",
	"// parse the JSON block, pick the worst service, then drill in:",
	"const ops = await maple.get_service_top_operations({ service: 'api', lookbackMinutes: 60 });",
	"return { errors, ops };",
	"```",
].join("\n")

export const buildCodeTool = (
	env: ChatFlueEnv,
	orgId: string,
): ToolDefinition<typeof CodeToolInputSchema> => ({
	name: "code",
	description: DESCRIPTION,
	parameters: CodeToolInputSchema,
	execute: async ({ code }) => {
		const url = new URL("/internal/codemode/run", env.MAPLE_API_URL).toString()
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Bearer maple_svc_${env.INTERNAL_SERVICE_TOKEN}`,
				"x-org-id": orgId,
			},
			body: JSON.stringify({ code }),
		})
		const text = await res.text()
		if (!res.ok) {
			throw new Error(`code run failed (${res.status}): ${text.slice(0, 300)}`)
		}
		return formatOutput(text)
	},
})
