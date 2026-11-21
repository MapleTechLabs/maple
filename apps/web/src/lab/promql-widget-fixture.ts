import type { PromqlQueryResult } from "@maple/query-engine"
import { Array as Arr, Option, Record as Rec } from "effect"

// Request rate per service over the last hour at a 30s step, as the engine returns a range query.

const STEP_MS = 30_000
const STEPS = 121

const SERVICES = [
	{ job: "checkout", base: 42, swing: 9, phase: 0 },
	{ job: "api-gateway", base: 118, swing: 22, phase: 1.3 },
	{ job: "payments", base: 17, swing: 5, phase: 2.1 },
] as const

export const promqlLabResult = (nowMs: number): PromqlQueryResult => {
	const endMs = Math.floor(nowMs / STEP_MS) * STEP_MS
	const startMs = endMs - (STEPS - 1) * STEP_MS
	return {
		resultType: "matrix",
		result: Arr.map(SERVICES, ({ job, base, swing, phase }) => ({
			labels: { job, instance: `${job}-0` },
			points: Arr.makeBy(STEPS, (i) => ({
				t: startMs + i * STEP_MS,
				v:
					Math.round(
						(base + swing * Math.sin(i / 9 + phase) + (swing / 3) * Math.sin(i / 2.3)) * 100,
					) / 100,
			})),
		})),
	}
}

/** What the editor's autocomplete discovers: metric names, label names and label values. */
export const PROMQL_LAB_METRICS = [
	"http_server_request_duration_seconds_bucket",
	"http_server_request_duration_seconds_count",
	"http_server_request_duration_seconds_sum",
	"http_server_active_requests",
	"process_cpu_seconds_total",
	"process_resident_memory_bytes",
	"up",
]

const LABELS = ["__name__", "job", "instance", "http_route", "http_response_status_code", "service_namespace"]

const VALUES = {
	job: ["api-gateway", "checkout", "payments", "search", "worker"],
	instance: ["api-gateway-0", "checkout-0", "payments-0"],
	http_route: ["/api/cart", "/api/checkout", "/api/search", "/healthz"],
	http_response_status_code: ["200", "201", "404", "500"],
} satisfies Record<string, ReadonlyArray<string>>

/** A discovery read as the API answers it: `__name__` lists metrics, no label lists label names. */
export const promqlLabDiscovery = (label: string | undefined): ReadonlyArray<string> =>
	label === undefined
		? LABELS
		: label === "__name__"
			? PROMQL_LAB_METRICS
			: Arr.findFirst(Rec.toEntries(VALUES), ([name]) => name === label).pipe(
					Option.match({ onNone: (): ReadonlyArray<string> => [], onSome: ([, values]) => values }),
				)
