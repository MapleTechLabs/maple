import { formatWarehouseDateTimeMs } from "@maple/query-engine"
import { buildTraceDetail, type SpanHierarchyRow } from "@maple/ui/lib/span-tree"

import { LONG_SERVICE, type WorstCaseMode } from "@/lab/worst-case-fixture"

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

/** A single parent chain, `depth` spans deep, so indentation is the only thing that grows. */
function chain(depth: number, worst: boolean): SpanHierarchyRow[] {
	return Array.from({ length: depth }, (_, i) =>
		row({
			spanId: `d${i}`,
			parentSpanId: i === 0 ? "" : `d${i - 1}`,
			spanName: worst
				? `${i === 0 ? "POST" : "call"} /api/v2/organizations/{orgId}/projects/{projectId}/checkout/step-${i}`
				: `step ${i}`,
			serviceName: worst ? SERVICES[i % SERVICES.length]! : "api",
			spanKind: i === 0 ? "Server" : "Internal",
			startTime: formatWarehouseDateTimeMs(T0_MS + i * 5),
			durationMs: Math.max(0.001, 2000 - i * 33),
			statusCode: worst && i === depth - 1 ? "Error" : "Ok",
			statusMessage: worst && i === depth - 1 ? "x".repeat(300) : "",
		}),
	)
}

export function worstCaseTrace(mode: WorstCaseMode) {
	const depth = mode === "worst" ? 60 : 4
	return { detail: buildTraceDetail(chain(depth, mode === "worst")), deepestSpanId: `d${depth - 1}` }
}
