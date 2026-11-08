// Buffer-backed OTLP logger (platform-agnostic)
//
// Pure Logger that pushes OTLP-shaped log records into a caller-owned buffer.
// Same pattern as the tracer — URL/resource/headers are resolved by the caller
// at flush time, not at construction time.
import { Array as Arr, Cause, Layer, Logger, type LogLevel, References, Record as Rec } from "effect"
import * as OtlpResource from "effect/observability/OtlpResource"
import type { SignalLogRecord } from "@maple/sdk-core"

export interface LogBuffer {
	readonly loggerLayer: Layer.Layer<never>
	readonly drain: () => Array<LogRecord>
	readonly restore: (items: ReadonlyArray<LogRecord>) => void
	/** Buffer a record that did not come through an Effect logger, e.g. a web vital. */
	readonly push: (record: SignalLogRecord) => void
	readonly setDisabled: (value: boolean) => void
	readonly size: () => number
}

const MAX_BUFFER = 10_000

export const makeLogBuffer = (options: { readonly excludeLogSpans?: boolean } = {}): LogBuffer => {
	let buffer: Array<LogRecord> = []
	let disabled = false
	const excludeLogSpans = options.excludeLogSpans ?? false

	const logger = Logger.make<unknown, void>((logOptions) => {
		if (disabled) return
		if (buffer.length >= MAX_BUFFER) return
		buffer.push(makeLogRecord(logOptions, excludeLogSpans))
	})

	return {
		loggerLayer: Logger.layer([logger], { mergeWithExisting: true }),
		drain: () => {
			const items = buffer
			buffer = []
			return items
		},
		restore: (items) => {
			if (disabled || items.length === 0) return
			buffer = [...items, ...buffer].slice(0, MAX_BUFFER)
		},
		push: (record) => {
			if (disabled || buffer.length >= MAX_BUFFER) return
			buffer.push(fromSignalRecord(record))
		},
		setDisabled: (value) => {
			disabled = value
			if (value) buffer = []
		},
		size: () => buffer.length,
	}
}

// Log record conversion (adapted from `effect/observability/OtlpLogger`)

const makeLogRecord = (logOptions: Logger.Options<unknown>, excludeLogSpans: boolean): LogRecord => {
	const nowMillis = logOptions.date.getTime()
	const nanosString = String(BigInt(nowMillis) * 1_000_000n)

	const attributes = OtlpResource.entriesToAttributes(
		Rec.toEntries(logOptions.fiber.getRef(References.CurrentLogAnnotations)),
	)
	attributes.push({ key: "fiberId", value: { intValue: logOptions.fiber.id } })
	if (!excludeLogSpans) {
		for (const [label, startTime] of logOptions.fiber.getRef(References.CurrentLogSpans)) {
			attributes.push({
				key: `logSpan.${label}`,
				value: { stringValue: `${nowMillis - startTime}ms` },
			})
		}
	}
	if (logOptions.cause.reasons.length > 0) {
		attributes.push({ key: "log.error", value: { stringValue: Cause.pretty(logOptions.cause) } })
	}

	const message = Arr.ensure(logOptions.message)

	const record: LogRecord = {
		severityNumber: logLevelToSeverityNumber(logOptions.logLevel),
		severityText: logOptions.logLevel,
		timeUnixNano: nanosString,
		observedTimeUnixNano: nanosString,
		attributes,
		body: OtlpResource.unknownToAttributeValue(message.length === 1 ? message[0] : message),
		droppedAttributesCount: 0,
	}

	const currentSpan = logOptions.fiber.cache.span
	if (currentSpan) {
		record.traceId = currentSpan.traceId
		record.spanId = currentSpan.spanId
	}

	return record
}

const fromSignalRecord = (record: SignalLogRecord): LogRecord => {
	const nanos = String(BigInt(Math.round(record.timestamp ?? Date.now())) * 1_000_000n)
	return {
		...(record.eventName === undefined ? undefined : { eventName: record.eventName }),
		severityNumber: record.severityNumber,
		severityText: record.severityText,
		timeUnixNano: nanos,
		observedTimeUnixNano: nanos,
		attributes: OtlpResource.entriesToAttributes(Rec.toEntries(record.attributes ?? {})),
		...(record.body === undefined ? undefined : { body: { stringValue: record.body } }),
		droppedAttributesCount: 0,
		...(record.link === undefined
			? undefined
			: { traceId: record.link.traceId, spanId: record.link.spanId, flags: record.link.traceFlags }),
	}
}

const logLevelToSeverityNumber = (logLevel: LogLevel.LogLevel): number => {
	switch (logLevel) {
		case "Trace":
			return 1
		case "Debug":
			return 5
		case "Info":
			return 9
		case "Warn":
			return 13
		case "Error":
			return 17
		case "Fatal":
			return 21
		default:
			return 0
	}
}

// OTLP wire types

export interface LogRecord {
	eventName?: string
	timeUnixNano: string
	observedTimeUnixNano: string
	severityNumber?: number
	severityText?: string
	body?: OtlpResource.AnyValue
	attributes: Array<OtlpResource.KeyValue>
	droppedAttributesCount: number
	traceId?: string
	spanId?: string
	flags?: number
}
