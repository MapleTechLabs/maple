// W3C `traceparent`: `version-traceid-parentid-flags`. Read and written here
// rather than through the global propagator, which the host app may own, may
// have configured for another format, or may not have registered at all.
import { context, isSpanContextValid, type SpanContext, trace } from "@opentelemetry/api"

const TRACEPARENT = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})(-.*)?$/

export function parseTraceparent(value: string | undefined): SpanContext | undefined {
	const match = value?.trim().match(TRACEPARENT)
	// Version ff is invalid; version 00 has exactly four fields
	if (!match || match[1] === "ff" || (match[1] === "00" && match[5] !== undefined)) return undefined
	const spanContext = {
		traceId: match[2],
		spanId: match[3],
		traceFlags: Number.parseInt(match[4], 16),
		isRemote: true,
	}
	// All-zero ids are well-formed but invalid; rejecting them lets the meta tag stand in
	return isSpanContextValid(spanContext) ? spanContext : undefined
}

/** The active span's context as a `traceparent`, sampled flag included; `undefined` without a valid one. */
export function activeTraceparent(): string | undefined {
	const spanContext = trace.getSpanContext(context.active())
	if (!spanContext || !isSpanContextValid(spanContext)) return undefined
	const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, "0")
	return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`
}
