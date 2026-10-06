import { Effect } from "effect"
import * as CH from "../ch"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { TimeRange } from "./types"

/** The label error_events gives a span with status Error and no message or exception. */
export const UNKNOWN_ERROR_LABEL = "Unknown Error"

export const isUnlabelledError = (label: string): boolean => label === "" || label === UNKNOWN_ERROR_LABEL

export interface OccurrenceSpanFacts {
	readonly spanName: string
	readonly httpMethod: string
	readonly httpRoute: string
	readonly httpStatus: string
}

/**
 * "GET 404 /api/org" from what the failing span was doing, or "" when it says nothing.
 * Used in place of "Unknown Error", which hid that 22k events were bot 404s.
 */
export const spanErrorLabel = (span: OccurrenceSpanFacts): string => {
	const method = span.httpMethod.trim()
	const status = span.httpStatus.trim()
	const name = span.spanName.trim()
	// Server span names usually lead with the method already ("GET /api/org").
	const target =
		span.httpRoute.trim() ||
		(method !== "" && name.toUpperCase().startsWith(`${method.toUpperCase()} `)
			? name.slice(method.length + 1)
			: name)
	if (method === "" && status === "") return name === "" ? "" : `${name} (no exception)`
	return [method, status, target].filter((part) => part !== "").join(" ")
}

/**
 * Span-derived labels for the given exception-less fingerprints, keyed by fingerprint.
 * Two point reads: the newest occurrence of each fingerprint (error_events, sorted by
 * fingerprint), then those spans by trace id. Fingerprints whose span aged out are absent.
 */
export const labelExceptionlessFingerprints = Effect.fn("Observability.labelExceptionlessFingerprints")(
	function* (input: { readonly fingerprintHashes: ReadonlyArray<string>; readonly timeRange: TimeRange }) {
		const labels = new Map<string, string>()
		if (input.fingerprintHashes.length === 0) return labels
		const executor = yield* WarehouseExecutor
		const params = {
			orgId: executor.orgId,
			startTime: input.timeRange.startTime,
			endTime: input.timeRange.endTime,
		}
		const occurrences = yield* executor.compiledQuery(
			CH.compile(
				CH.errorFingerprintOccurrencesQuery({ fingerprintHashes: input.fingerprintHashes }),
				params,
			),
			{ profile: "list", context: "errorFingerprintOccurrences" },
		)
		const withSpan = occurrences.filter((o) => o.spanId !== "" && o.traceId !== "")
		if (withSpan.length === 0) return labels
		const spans = yield* executor.compiledQuery(
			CH.compile(
				CH.errorOccurrenceSpansQuery({
					traceIds: withSpan.map((o) => o.traceId),
					spanIds: withSpan.map((o) => o.spanId),
				}),
				params,
			),
			{ profile: "list", context: "errorOccurrenceSpans" },
		)
		const bySpan = new Map(spans.map((span) => [span.spanId, span]))
		for (const occurrence of withSpan) {
			const span = bySpan.get(occurrence.spanId)
			const label = span === undefined ? "" : spanErrorLabel(span)
			if (label !== "") labels.set(occurrence.fingerprintHash, label)
		}
		return labels
	},
)
