import { formatWarehouseDateTimeMs } from "@maple/query-engine"
import { buildTraceDetail, type SpanHierarchyRow } from "@maple/ui/lib/span-tree"

import { LONG_SERVICE, type WorstCaseMode } from "./worst-case-fixture"

const T0_MS = new Date("2026-07-21T10:00:00.000Z").getTime()

function row(overrides: Partial<SpanHierarchyRow> & { spanId: string; spanName: string }): SpanHierarchyRow {
	return {
		traceId: "worst-case-lab-trace",
		parentSpanId: "",
		serviceName: "checkout-api",
		spanKind: "Internal",
		durationMs: 20,
		startTime: formatWarehouseDateTimeMs(T0_MS),
		statusCode: "Ok",
		statusMessage: "",
		spanAttributes: "{}",
		resourceAttributes: "{}",
		...overrides,
	}
}

const SERVICES = [LONG_SERVICE, "checkout-api", "unknown_service:node", "a"]

// What each span called, cycling down the chain: the waterfall marks each one.
const CALLS: ReadonlyArray<Record<string, string>> = [
	{},
	{ "db.system.name": "postgresql" },
	{ "gen_ai.provider.name": "anthropic" },
	{ "messaging.system": "kafka" },
	{ "messaging.system": "some_inhouse_queue" },
]

// What runs each service, so a service entering the chain shows its runtime.
const RUNTIMES = new Map<string, Record<string, string>>([
	["api", { "telemetry.sdk.name": "effect", "process.runtime.name": "bun" }],
	[LONG_SERVICE, { "telemetry.sdk.name": "@maple-dev/effect-sdk", "process.runtime.name": "nodejs" }],
	["checkout-api", { "process.runtime.name": "bun" }],
	["unknown_service:node", { "telemetry.sdk.language": "python" }],
])

/** A single parent chain, `depth` spans deep, so indentation is the only thing that grows. */
function chain(depth: number, worst: boolean): SpanHierarchyRow[] {
	return Array.from({ length: depth }, (_, i) => {
		const serviceName = worst ? SERVICES[i % SERVICES.length]! : "api"
		return row({
			spanId: `d${i}`,
			parentSpanId: i === 0 ? "" : `d${i - 1}`,
			spanName: worst
				? `${i === 0 ? "POST" : "call"} /api/v2/organizations/{orgId}/projects/{projectId}/checkout/step-${i}`
				: `step ${i}`,
			serviceName,
			spanKind: i === 0 ? "Server" : "Internal",
			spanAttributes: JSON.stringify(CALLS[i % CALLS.length]),
			resourceAttributes: JSON.stringify(RUNTIMES.get(serviceName) ?? {}),
			startTime: formatWarehouseDateTimeMs(T0_MS + i * 5),
			durationMs: Math.max(0.001, 2000 - i * 33),
			statusCode: worst && i === depth - 1 ? "Error" : "Ok",
			statusMessage: worst && i === depth - 1 ? "x".repeat(300) : "",
		})
	})
}

export function worstCaseTrace(mode: WorstCaseMode) {
	const depth = mode === "worst" ? 60 : 4
	return { detail: buildTraceDetail(chain(depth, mode === "worst")), deepestSpanId: `d${depth - 1}` }
}
