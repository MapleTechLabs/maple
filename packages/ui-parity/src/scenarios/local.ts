import type { AreaModule, Scenario } from "./types.ts"

/**
 * apps/local-ui (local mode), hash-routed, on the local datasets (`fixtures/areas/local.ts`).
 * Every route gets default, empty, loading (held `/local/query`) and error (failing query) states.
 */

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const QUERY_FAILURE = {
	"local.query": {
		status: 400,
		body: { message: "query failed: Code: 60. DB::Exception: Unknown table expression (UNKNOWN_TABLE)" },
	},
}

interface LocalRoute {
	readonly id: string
	readonly title: string
	readonly hash: string
}

const ROUTES: ReadonlyArray<LocalRoute> = [
	{ id: "traces", title: "Traces", hash: "/traces" },
	{ id: "trace-detail", title: "Trace detail", hash: "/traces/0eab694ff33721d5a836ce7444afadcc" },
	{ id: "metric-detail", title: "Metric detail", hash: "/metrics/http.server.request.duration" },
	{ id: "service-detail", title: "Service detail", hash: "/services/checkout-api" },
	{ id: "session-detail", title: "Session detail", hash: "/sessions/sess-parity-missing" },
	{ id: "logs", title: "Logs", hash: "/logs" },
	{ id: "metrics", title: "Metrics", hash: "/metrics" },
	{ id: "services", title: "Services", hash: "/services" },
	{ id: "service-map", title: "Service map", hash: "/service-map" },
	{ id: "errors", title: "Errors", hash: "/errors" },
	{ id: "sessions", title: "Sessions", hash: "/sessions" },
	{ id: "query", title: "Query", hash: "/query" },
]

const scenario = (route: LocalRoute, state: string, extra: Partial<Scenario>): Scenario => ({
	id: `local-${route.id}${state === "" ? "" : `-${state}`}`,
	title: `Local ${route.title}${state === "" ? "" : ` (${state})`}`,
	path: `/#${route.hash}`,
	dataset: "local",
	app: "local",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "local",
	...extra,
})

const routeStates = (route: LocalRoute): ReadonlyArray<Scenario> => [
	scenario(route, "", {}),
	scenario(route, "empty", { dataset: "local-empty" }),
	scenario(route, "loading", { faults: { delays: { "local.query": HELD_MS } }, settle: "held" }),
	scenario(route, "error", { faults: { failures: QUERY_FAILURE } }),
]

const traces = ROUTES[0] ?? { id: "traces", title: "Traces", hash: "/traces" }

/** The shell's connection states, driven by `/local/status`. */
const connection: ReadonlyArray<Scenario> = [
	scenario(traces, "rejected", {
		faults: { failures: { "local.status": { status: 403, body: { message: "browser origin not allowed" } } } },
	}),
	scenario(traces, "server-error", {
		faults: { failures: { "local.status": { status: 500, body: { message: "chDB is restarting" } } } },
	}),
	scenario(traces, "legacy-binary", {
		faults: { failures: { "local.status": { status: 404, body: { message: "not found" } } } },
	}),
	// Nothing listening and nothing loaded: two refused probes (1 s apart) swap in the screen.
	scenario(traces, "disconnected", {
		faults: { refusals: ["local."] },
		steps: (page) => page.getByText("Can’t reach Maple Local").first().waitFor(),
	}),
]

export const localArea: AreaModule = {
	area: "local",
	scenarios: [...ROUTES.flatMap(routeStates), ...connection],
}
