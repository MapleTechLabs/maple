// Warehouse rows -> the observability view models.
//
// The `Number(...)` / `String(...)` wrappers that used to be on every field
// here were a second, untyped parse layer: rows now decode through the compiled
// query's row schema, which is where a quoted `UInt64` becomes a number and a
// missing column becomes an error. Coercing again downstream only hid which
// layer was responsible.

import { Option, Schema } from "effect"
import { SpanId, TraceId } from "@maple/domain"
import type { ListLogsOutput, ErrorsByTypeOutput } from "@maple/domain/tinybird"
import type { TracesRootListOutput } from "../ch"
import type { SpanResult, LogEntry, ErrorSummary } from "./types"

const decodeAttributeMap = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

/** The list query's projected attribute map (a JSON string); empty values are absent keys. */
export const parseProjectedAttributes = (raw: string): Record<string, string> => {
	const out: Record<string, string> = {}
	const parsed = raw.length === 0 ? Option.none() : decodeAttributeMap(raw)
	if (Option.isNone(parsed)) return out
	for (const [key, value] of Object.entries(parsed.value)) {
		if (typeof value === "string" && value.length > 0) out[key] = value
	}
	return out
}

/**
 * A `list_traces` row as a span result. The status is the stored one (Title
 * case `Ok`/`Error`/`Unset`), matching the span-level, slow-trace and
 * inspect-trace paths. Resource attributes are not read on this path.
 */
export const toSpanResult = (t: TracesRootListOutput): SpanResult => ({
	traceId: Schema.decodeSync(TraceId)(t.traceId),
	spanId: Option.getOrNull(Schema.decodeUnknownOption(SpanId)(t.rootSpanId)),
	spanName: t.rootSpanName,
	serviceName: t.services[0] ?? "",
	durationMs: t.durationMicros / 1000,
	statusCode: t.rootSpanStatusCode || (t.hasError ? "Error" : "Unset"),
	statusMessage: t.rootSpanStatusMessage,
	attributes: parseProjectedAttributes(t.rootSpanAttributes),
	resourceAttributes: {},
	timestamp: t.startTime,
})

export const toLogEntry = (l: ListLogsOutput): LogEntry => ({
	timestamp: l.timestamp,
	severityText: l.severityText || "INFO",
	serviceName: l.serviceName,
	body: l.body,
	traceId: l.traceId,
	spanId: l.spanId,
})

export const toErrorSummary = (e: ErrorsByTypeOutput): ErrorSummary => ({
	fingerprintHash: e.fingerprintHash,
	label: e.errorLabel,
	sampleMessage: e.sampleMessage ?? "",
	count: e.count,
	affectedServicesCount: e.affectedServicesCount,
	lastSeen: e.lastSeen,
})
