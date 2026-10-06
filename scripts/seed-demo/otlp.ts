/**
 * OTLP/JSON shapes, as the ingest gateway decodes them (opentelemetry-proto
 * `with-serde`): camelCase keys, hex ids, `*UnixNano` as decimal strings.
 */
export type AnyValue =
	| { stringValue: string }
	| { intValue: string }
	| { doubleValue: number }
	| { boolValue: boolean }
export interface KeyValue {
	readonly key: string
	readonly value: AnyValue
}

export const attr = (key: string, value: string | number | boolean): KeyValue => {
	if (typeof value === "boolean") return { key, value: { boolValue: value } }
	if (typeof value === "string") return { key, value: { stringValue: value } }
	return Number.isInteger(value)
		? { key, value: { intValue: String(value) } }
		: { key, value: { doubleValue: value } }
}

export const nano = (ms: number): string => (BigInt(Math.round(ms * 1000)) * 1000n).toString()

export const SpanKind = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const
export const StatusCode = { unset: 0, error: 2 } as const
export const Severity = {
	DEBUG: 5,
	INFO: 9,
	WARN: 13,
	ERROR: 17,
} as const
export type SeverityText = keyof typeof Severity

export interface SpanEvent {
	readonly timeUnixNano: string
	readonly name: string
	readonly attributes: ReadonlyArray<KeyValue>
}

export interface Span {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId?: string | undefined
	readonly name: string
	readonly kind: number
	readonly startTimeUnixNano: string
	readonly endTimeUnixNano: string
	readonly attributes: ReadonlyArray<KeyValue>
	/** `undefined` fields drop out of the JSON body. */
	readonly events?: ReadonlyArray<SpanEvent> | undefined
	readonly status: { readonly code: number; readonly message?: string }
}

export interface LogRecord {
	readonly timeUnixNano: string
	readonly observedTimeUnixNano: string
	readonly severityNumber: number
	readonly severityText: SeverityText
	readonly body: { readonly stringValue: string }
	readonly attributes: ReadonlyArray<KeyValue>
	readonly traceId: string | undefined
	readonly spanId: string | undefined
}

export interface NumberPoint {
	readonly startTimeUnixNano?: string
	readonly timeUnixNano: string
	readonly attributes: ReadonlyArray<KeyValue>
	readonly asDouble?: number
	readonly asInt?: number
}

export interface HistogramPoint {
	readonly startTimeUnixNano: string
	readonly timeUnixNano: string
	readonly attributes: ReadonlyArray<KeyValue>
	readonly count: string
	readonly sum: number
	readonly min: number
	readonly max: number
	readonly bucketCounts: ReadonlyArray<string>
	readonly explicitBounds: ReadonlyArray<number>
}

const DELTA = 1

export type Metric =
	| {
			readonly name: string
			readonly unit: string
			readonly gauge: { readonly dataPoints: ReadonlyArray<NumberPoint> }
	  }
	| {
			readonly name: string
			readonly unit: string
			readonly sum: {
				readonly aggregationTemporality: typeof DELTA
				readonly isMonotonic: boolean
				readonly dataPoints: ReadonlyArray<NumberPoint>
			}
	  }
	| {
			readonly name: string
			readonly unit: string
			readonly histogram: {
				readonly aggregationTemporality: typeof DELTA
				readonly dataPoints: ReadonlyArray<HistogramPoint>
			}
	  }

export const gauge = (name: string, unit: string, dataPoints: ReadonlyArray<NumberPoint>): Metric => ({
	name,
	unit,
	gauge: { dataPoints },
})

export const deltaSum = (name: string, unit: string, dataPoints: ReadonlyArray<NumberPoint>): Metric => ({
	name,
	unit,
	sum: { aggregationTemporality: DELTA, isMonotonic: true, dataPoints },
})

export const deltaHistogram = (
	name: string,
	unit: string,
	dataPoints: ReadonlyArray<HistogramPoint>,
): Metric => ({
	name,
	unit,
	histogram: { aggregationTemporality: DELTA, dataPoints },
})

const SCOPE = { name: "maple-seed-demo", version: "1.0.0" }

export const resourceSpans = (resource: ReadonlyArray<KeyValue>, spans: ReadonlyArray<Span>) => ({
	resourceSpans: [{ resource: { attributes: resource }, scopeSpans: [{ scope: SCOPE, spans }] }],
})

export const resourceLogs = (resource: ReadonlyArray<KeyValue>, logRecords: ReadonlyArray<LogRecord>) => ({
	resourceLogs: [{ resource: { attributes: resource }, scopeLogs: [{ scope: SCOPE, logRecords }] }],
})

export const resourceMetrics = (resource: ReadonlyArray<KeyValue>, metrics: ReadonlyArray<Metric>) => ({
	resourceMetrics: [{ resource: { attributes: resource }, scopeMetrics: [{ scope: SCOPE, metrics }] }],
})
