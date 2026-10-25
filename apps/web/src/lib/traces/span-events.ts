import type { SpanEvent } from "@maple/query-engine"
import { formatDurationAtStep } from "@maple/ui/lib/format"

/** OTel semconv attribute keys on an `exception` span event. */
const EXCEPTION_KEYS = ["exception.type", "exception.message", "exception.stacktrace"] as const

export type DescribedSpanEvent =
	| {
			readonly kind: "exception"
			readonly type: string | undefined
			readonly message: string | undefined
			readonly stacktrace: string | undefined
			/** Attributes beyond the three exception keys, e.g. `exception.escaped`. */
			readonly attributes: Readonly<Record<string, string>>
	  }
	| { readonly kind: "event"; readonly attributes: Readonly<Record<string, string>> }

const nonEmpty = (value: string | undefined) => (value ? value : undefined)

/** Splits an `exception` event's semconv fields from the rest of its attributes. */
export function describeSpanEvent(event: SpanEvent): DescribedSpanEvent {
	if (event.name !== "exception") return { kind: "event", attributes: event.attributes }
	const attributes = Object.fromEntries(
		Object.entries(event.attributes).filter(
			([key]) => !(EXCEPTION_KEYS as readonly string[]).includes(key),
		),
	)
	return {
		kind: "exception",
		type: nonEmpty(event.attributes["exception.type"]),
		message: nonEmpty(event.attributes["exception.message"]),
		stacktrace: nonEmpty(event.attributes["exception.stacktrace"]),
		attributes,
	}
}

/** `+12.400ms`: the event's offset into its span, to the microsecond. */
export function formatEventOffset(offsetMs: number): string {
	const sign = offsetMs < 0 ? "-" : "+"
	const magnitude = Math.abs(offsetMs)
	// Past a second the shared formatter rounds to the millisecond; keep the microseconds.
	if (magnitude >= 1000) return `${sign}${(magnitude / 1000).toFixed(6).replace(/0{1,3}$/, "")}s`
	return `${sign}${formatDurationAtStep(magnitude, 0.001)}`
}
