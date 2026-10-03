// The log record every shared collector emits. Neutral on purpose: each SDK
// maps it onto its own pipeline (the OTel logs SDK, the Effect log buffer).

export type LogAttributeValue = string | number | boolean

/** OTel severity numbers for the levels the SDKs emit. */
export const Severity = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 } as const

/** A span to link a record to; structurally an OTel `SpanContext`. */
export interface SpanLink {
	readonly traceId: string
	readonly spanId: string
	readonly traceFlags: number
}

export interface SignalLogRecord {
	/** Set for a log-based event (`LogRecord.event_name`); absent for a plain log line. */
	readonly eventName?: string | undefined
	readonly severityNumber: number
	readonly severityText: string
	readonly body?: string | undefined
	readonly attributes?: Readonly<Record<string, LogAttributeValue>> | undefined
	/** Epoch ms when it happened. Defaults to now. */
	readonly timestamp?: number | undefined
	/** The span to link to. Defaults to whatever the SDK considers active. */
	readonly link?: SpanLink | undefined
}

export type EmitLog = (record: SignalLogRecord) => void

/** A `Map`, not an object: a level string like `"constructor"` must not reach the prototype. */
const LEVELS = new Map<string, keyof typeof Severity>([
	["error", "ERROR"],
	["warn", "WARN"],
	["debug", "DEBUG"],
])

/** Severity for a console level: `log` and `info` are INFO. */
export function severityOf(level: string | undefined): {
	readonly number: number
	readonly text: keyof typeof Severity
} {
	const text = (level !== undefined ? LEVELS.get(level) : undefined) ?? "INFO"
	return { number: Severity[text], text }
}
