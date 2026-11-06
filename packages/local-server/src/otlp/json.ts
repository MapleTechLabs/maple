// The OTLP/JSON shapes the encoders read, checked at the ingest boundary so a
// body of the wrong shape is a 400 naming the path, not an encoder crash (500).
// Protobuf bodies need no check: the generated decoder already types them.
// Lenient where the encoders are: every field may be absent or null, int64s may
// be numbers or strings, unknown fields pass through untouched.
import { Result, Schema } from "effect"

const opt = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))
/** For fields the encoders test with `!== undefined`: there `null` would read as present. */
const present = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)
/** A double: proto3 JSON allows a number or a string ("NaN", "1.5"); the encoders check the string. */
const Numeric = Schema.Union([Schema.Number, Schema.String])
/** int64 and uint64: an integer, or its decimal string. */
const Int64 = Schema.Union([Schema.Int, Schema.String.check(Schema.isPattern(/^-?\d+$/))])
const list = <S extends Schema.Top>(schema: S) => opt(Schema.Array(schema))
/** What `atob` decodes; the encoders and ingest rules call it unguarded. */
const Base64 = Schema.String.check(
	Schema.makeFilter((value: string) => Result.isSuccess(Result.try(() => atob(value))), {
		title: "base64",
		expected: "a base64 string",
	}),
)

interface AnyValueJson {
	readonly stringValue?: string
	readonly boolValue?: boolean
	readonly intValue?: string | number
	readonly doubleValue?: string | number
	readonly bytesValue?: string
	readonly arrayValue?: { readonly values?: ReadonlyArray<AnyValueJson> | null }
	readonly kvlistValue?: { readonly values?: ReadonlyArray<KeyValueJson> | null }
}
interface KeyValueJson {
	readonly key?: string | null
	readonly value?: AnyValueJson | null
}

const AnyValue: Schema.Codec<AnyValueJson> = Schema.Struct({
	stringValue: present(Schema.String),
	boolValue: present(Schema.Boolean),
	intValue: present(Numeric),
	doubleValue: present(Numeric),
	bytesValue: present(Base64),
	arrayValue: present(Schema.Struct({ values: list(Schema.suspend(() => AnyValue)) })),
	kvlistValue: present(Schema.Struct({ values: list(Schema.suspend(() => KeyValue)) })),
})
const KeyValue: Schema.Codec<KeyValueJson> = Schema.Struct({
	key: opt(Schema.String),
	value: opt(AnyValue),
})

const attributes = list(KeyValue)
const Resource = Schema.Struct({ attributes })
const Scope = Schema.Struct({ name: opt(Schema.String), version: opt(Schema.String), attributes })

const Span = Schema.Struct({
	traceId: opt(Schema.String),
	spanId: opt(Schema.String),
	parentSpanId: opt(Schema.String),
	traceState: opt(Schema.String),
	name: opt(Schema.String),
	kind: opt(Schema.Int),
	startTimeUnixNano: opt(Int64),
	endTimeUnixNano: opt(Int64),
	attributes,
	events: list(Schema.Struct({ timeUnixNano: opt(Int64), name: opt(Schema.String), attributes })),
	links: list(
		Schema.Struct({
			traceId: opt(Schema.String),
			spanId: opt(Schema.String),
			traceState: opt(Schema.String),
			attributes,
		}),
	),
	status: opt(Schema.Struct({ code: opt(Schema.Int), message: opt(Schema.String) })),
})

const TraceRequest = Schema.Struct({
	resourceSpans: list(
		Schema.Struct({
			resource: opt(Resource),
			schemaUrl: opt(Schema.String),
			scopeSpans: list(
				Schema.Struct({ scope: opt(Scope), schemaUrl: opt(Schema.String), spans: list(Span) }),
			),
		}),
	),
})

const LogRecord = Schema.Struct({
	timeUnixNano: opt(Int64),
	observedTimeUnixNano: opt(Int64),
	severityNumber: opt(Schema.Int),
	severityText: opt(Schema.String),
	body: opt(AnyValue),
	attributes,
	flags: opt(Int64),
	traceId: opt(Schema.String),
	spanId: opt(Schema.String),
})

const LogsRequest = Schema.Struct({
	resourceLogs: list(
		Schema.Struct({
			resource: opt(Resource),
			schemaUrl: opt(Schema.String),
			scopeLogs: list(
				Schema.Struct({
					scope: opt(Scope),
					schemaUrl: opt(Schema.String),
					logRecords: list(LogRecord),
				}),
			),
		}),
	),
})

const Exemplar = Schema.Struct({
	traceId: opt(Schema.String),
	spanId: opt(Schema.String),
	timeUnixNano: opt(Int64),
	asDouble: present(Numeric),
	asInt: present(Int64),
	filteredAttributes: attributes,
})

const pointBase = {
	attributes,
	startTimeUnixNano: opt(Int64),
	timeUnixNano: opt(Int64),
	exemplars: list(Exemplar),
	flags: opt(Int64),
}
const NumberDataPoint = Schema.Struct({ ...pointBase, asDouble: present(Numeric), asInt: present(Int64) })
const HistogramDataPoint = Schema.Struct({
	...pointBase,
	count: opt(Int64),
	sum: opt(Numeric),
	bucketCounts: list(Int64),
	explicitBounds: list(Numeric),
	min: opt(Numeric),
	max: opt(Numeric),
})
const Buckets = Schema.Struct({ offset: opt(Int64), bucketCounts: list(Int64) })
const ExpHistogramDataPoint = Schema.Struct({
	...pointBase,
	count: opt(Int64),
	sum: opt(Numeric),
	scale: opt(Int64),
	zeroCount: opt(Int64),
	positive: opt(Buckets),
	negative: opt(Buckets),
	min: opt(Numeric),
	max: opt(Numeric),
})

const Metric = Schema.Struct({
	name: opt(Schema.String),
	description: opt(Schema.String),
	unit: opt(Schema.String),
	gauge: opt(Schema.Struct({ dataPoints: list(NumberDataPoint) })),
	sum: opt(
		Schema.Struct({
			dataPoints: list(NumberDataPoint),
			aggregationTemporality: opt(Schema.Int),
			isMonotonic: opt(Schema.Boolean),
		}),
	),
	histogram: opt(
		Schema.Struct({ dataPoints: list(HistogramDataPoint), aggregationTemporality: opt(Schema.Int) }),
	),
	exponentialHistogram: opt(
		Schema.Struct({
			dataPoints: list(ExpHistogramDataPoint),
			aggregationTemporality: opt(Schema.Int),
		}),
	),
})

const MetricsRequest = Schema.Struct({
	resourceMetrics: list(
		Schema.Struct({
			resource: opt(Resource),
			schemaUrl: opt(Schema.String),
			scopeMetrics: list(
				Schema.Struct({ scope: opt(Scope), schemaUrl: opt(Schema.String), metrics: list(Metric) }),
			),
		}),
	),
})

const check =
	<T>(schema: Schema.Decoder<T>) =>
	(body: unknown): Result.Result<unknown, Schema.SchemaError> =>
		Schema.decodeUnknownResult(schema)(body)

const checks = {
	traces: check(TraceRequest),
	logs: check(LogsRequest),
	metrics: check(MetricsRequest),
}

/** The body as given when it has the shape the encoders read, else why not. */
export const checkOtlpJson = (
	signal: "traces" | "logs" | "metrics",
	body: unknown,
): Result.Result<unknown, string> =>
	checks[signal](body).pipe(
		Result.map(() => body),
		Result.mapError((error) => `invalid OTLP/JSON ${signal} body: ${error.message}`),
	)
