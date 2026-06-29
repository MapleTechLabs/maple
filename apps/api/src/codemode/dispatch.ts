/**
 * Tool dispatch for the Code Mode connector.
 *
 * The Code Mode runtime runs inside a Durable Object; the model's `maple.<tool>()`
 * calls have to reach the real tool handlers, which live in the api worker's
 * request pipeline (full Effect `MainLive` layer + tenant resolution). Rather than
 * rebuild that layer inside the DO, the connector calls back to the worker over a
 * `Self` service binding, hitting the internal `/internal/codemode/tool` route —
 * which runs a single tool exactly like the `/mcp` server does, resolving the
 * tenant from the internal-service token + `x-org-id` (never trusted from model
 * output). This mirrors how chat-flue's `submit_diagnosis` writes back to the api.
 */

/** Bindings the self-dispatch needs from the DO env. */
export interface CodemodeDispatchEnv {
	/** Service binding back to the api worker (a self `WorkerStub`). */
	readonly SELF: Fetcher
	/** Internal-service token, mirrored from the worker env. */
	readonly INTERNAL_SERVICE_TOKEN?: string
}

/** Full binding surface the {@link CodemodeRuntimeDO} reads off its env. */
export interface CodemodeRuntimeEnv extends CodemodeDispatchEnv {
	/** Worker Loader (Dynamic Workers, open beta) — runs the model's snippet in an isolate. */
	readonly LOADER?: WorkerLoader
}

/** A function the connector calls to run one Maple tool: `(name, input) => result text`. */
export type MapleToolDispatch = (name: string, args: unknown) => Promise<unknown>

/** The internal route the dispatch posts to. Host is arbitrary — the Self binding ignores it. */
const TOOL_ROUTE_URL = "https://maple-api.internal/internal/codemode/tool"

/** Shape returned by `/internal/codemode/tool`. */
interface ToolCallResponse {
	readonly content?: string
	readonly isError?: boolean
}

/**
 * Build a dispatch bound to one organization. Each call POSTs `{ name, arguments }`
 * to the internal tool route with the org pinned out-of-band in `x-org-id`. The
 * tool's text output (human-readable + `Structured content:` JSON) is returned to
 * the sandbox so the model can parse and correlate; an `isError` result is returned
 * as text too (so the snippet can read the message), while a transport/auth failure
 * throws (the runtime surfaces it as a failed call).
 */
export const makeSelfToolDispatch =
	(env: CodemodeDispatchEnv, orgId: string): MapleToolDispatch =>
	async (name, args) => {
		const token = env.INTERNAL_SERVICE_TOKEN
		if (!token) throw new Error("INTERNAL_SERVICE_TOKEN is not configured")

		const response = await env.SELF.fetch(TOOL_ROUTE_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer maple_svc_${token}`,
				"x-org-id": orgId,
			},
			body: JSON.stringify({ name, arguments: args ?? {} }),
		})

		const text = await response.text()
		if (!response.ok) {
			throw new Error(`maple.${name} failed (${response.status}): ${text.slice(0, 500)}`)
		}

		const parsed = JSON.parse(text) as ToolCallResponse
		return parsed.content ?? ""
	}
