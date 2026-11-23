// BOUNDARY-FILE: This module intentionally carries opaque values; callers decode them before domain use.
import { Array as Arr, Order, Result, Schema, String as Str } from "effect"

/**
 * Dependency-free OTLP protobuf codec for the request and response messages the local server
 * handles. Field numbers follow opentelemetry-proto v1.x (profiles: v1development as of v1.10.0
 * to v1.11.1) and MUST match upstream so payloads from real OTLP exporters decode correctly.
 *
 * Decoded objects take the OTLP/JSON shape, the same one `protobufjs` `toObject` produced with
 * `{ longs: String, enums: Number, bytes: String, defaults: true, arrays: true, oneofs: true }`:
 *   - keys are lowerCamelCase; 64-bit ints are DECIMAL STRINGS (exact, read through BigInt)
 *   - bytes are BASE64 STRINGS; enums stay NUMBERS
 *   - absent scalars take their default, absent messages are `null`, absent lists are `[]`
 *   - a set oneof member also writes the oneof's name (`{ stringValue: "x", value: "stringValue" }`);
 *     proto3 `optional` fields (`sum`, `min`, `max`) appear only when present
 */

export class OtlpProtobufDecodeError extends Schema.TaggedError<OtlpProtobufDecodeError>()(
	"@maple/local-server/OtlpProtobufDecodeError",
	{ message: Schema.String, offset: Schema.Number },
) {}

type Scalar =
	| "string"
	| "bytes"
	| "bool"
	| "double"
	| "int32"
	| "uint32"
	| "sint32"
	| "fixed32"
	| "int64"
	| "uint64"
	| "fixed64"
	| "sfixed64"

type Kind = Scalar | (() => MessageType)
type Mode = "repeated" | "optional" | { readonly oneof: string }

interface Field {
	readonly no: number
	readonly name: string
	readonly scalar: Scalar | undefined
	readonly message: (() => MessageType) | undefined
	readonly repeated: boolean
	/** Wire type of one element: 0 varint, 1 fixed64, 2 length-delimited, 5 fixed32. */
	readonly wire: number
	/** The real oneof this field belongs to, and the other members a write clears. */
	readonly oneof: string | undefined
	readonly siblings: ReadonlyArray<string>
}

interface MessageType {
	readonly fields: ReadonlyArray<Field>
	readonly byNo: ReadonlyArray<Field | undefined>
	readonly create: () => Record<string, unknown>
}

const wireOf = (kind: Kind): number => {
	switch (kind) {
		case "double":
		case "fixed64":
		case "sfixed64":
			return 1
		case "fixed32":
			return 5
		case "string":
		case "bytes":
			return 2
		case "bool":
		case "int32":
		case "uint32":
		case "sint32":
		case "int64":
		case "uint64":
			return 0
		default:
			return 2
	}
}

const scalarDefault = (kind: Scalar): unknown => {
	switch (kind) {
		case "string":
		case "bytes":
			return ""
		case "bool":
			return false
		case "int64":
		case "uint64":
		case "fixed64":
		case "sfixed64":
			return "0"
		default:
			return 0
	}
}

const messageType = (specs: ReadonlyArray<readonly [number, string, Kind, Mode?]>): MessageType => {
	const groupOf = (mode: Mode | undefined) => (typeof mode === "object" ? mode.oneof : undefined)
	const sorted = Arr.sort(
		specs,
		Order.mapInput(Order.Number, (spec: (typeof specs)[number]) => spec[0]),
	)
	const fields: ReadonlyArray<Field> = Arr.map(sorted, ([no, name, kind, mode]) => {
		const oneof = groupOf(mode)
		const siblings = Arr.filter(
			sorted,
			(s) => oneof !== undefined && s[1] !== name && groupOf(s[3]) === oneof,
		)
		return {
			no,
			name,
			scalar: typeof kind === "string" ? kind : undefined,
			message: typeof kind === "string" ? undefined : kind,
			repeated: mode === "repeated",
			wire: wireOf(kind),
			oneof,
			siblings: Arr.map(siblings, (s) => s[1]),
		}
	})
	const byNo: Array<Field | undefined> = []
	for (const field of fields) byNo[field.no] = field
	// Same key order as protobufjs `toObject`: lists, then plain fields, both by field number;
	// oneof and `optional` members carry no default and are added when read.
	const lists = Arr.map(
		Arr.filter(sorted, (s) => s[3] === "repeated"),
		(s) => s[1],
	)
	const defaults = Arr.map(
		Arr.filter(sorted, (s) => s[3] === undefined),
		([, name, kind]): readonly [string, unknown] => [
			name,
			typeof kind === "string" ? scalarDefault(kind) : null,
		],
	)
	const create = (): Record<string, unknown> => {
		const object: Record<string, unknown> = {}
		for (const name of lists) object[name] = []
		for (const [name, value] of defaults) object[name] = value
		return object
	}
	return { fields, byNo, create }
}

/** Nesting cap, as in protoc and protobufjs: deeper input is refused instead of recursing. */
const MAX_DEPTH = 100

const looseUtf8 = new TextDecoder("utf-8", { ignoreBOM: true })
const utf8Encoder = new TextEncoder()
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/**
 * Protobuf wire-format cursor. A failure is sticky and moves the cursor past the end, so every
 * loop stops and the caller reads `error` once at the top instead of unwinding by exception.
 */
class WireReader {
	pos = 0
	limit: number
	error: string | undefined = undefined
	errorAt = 0
	/** The last 64-bit varint or fixed64 read, as two unsigned 32-bit halves. */
	lo = 0
	hi = 0
	private readonly view: DataView

	constructor(readonly buf: Uint8Array) {
		this.limit = buf.length
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	}

	fail(message: string): void {
		if (this.error === undefined) {
			this.error = message
			this.errorAt = this.pos
		}
		this.pos = this.buf.length
		this.limit = this.buf.length
	}

	/** A varint as uint32: bits past 32 are dropped, at most 10 bytes. */
	uint32(): number {
		let value = 0
		for (let i = 0; i < 10; i++) {
			if (this.pos >= this.limit) {
				this.fail("index out of range: truncated varint")
				return 0
			}
			const b = this.buf[this.pos++] ?? 0
			if (i < 4) value |= (b & 127) << (i * 7)
			else if (i === 4) value |= (b & 15) << 28
			if (b < 128) return value >>> 0
		}
		this.fail("invalid varint encoding")
		return 0
	}

	/** A tag or a length: at most 5 bytes, and the 5th may not exceed `fifthMax`. */
	private varint5(fifthMax: number, what: string): number {
		let value = 0
		for (let i = 0; i < 5; i++) {
			if (this.pos >= this.limit) {
				this.fail(`index out of range: truncated ${what}`)
				return 0
			}
			const b = this.buf[this.pos++] ?? 0
			if (i === 4) {
				if (b > fifthMax) break
				return (value | (b << 28)) >>> 0
			}
			value |= (b & 127) << (i * 7)
			if (b < 128) return value >>> 0
		}
		this.fail(`invalid ${what} encoding`)
		return 0
	}

	tag(): number {
		const b = this.buf[this.pos] ?? 128
		if (b < 128 && this.pos < this.limit) {
			this.pos++
			return b
		}
		return this.varint5(15, "tag")
	}

	size(): number {
		const b = this.buf[this.pos] ?? 128
		if (b < 128 && this.pos < this.limit) {
			this.pos++
			return b
		}
		return this.varint5(7, "length")
	}

	/** A varint into `lo`/`hi`; bits past 64 are dropped, at most 10 bytes. */
	varint64(): void {
		let lo = 0
		let hi = 0
		for (let i = 0; i < 10; i++) {
			if (this.pos >= this.limit) {
				this.fail("index out of range: truncated varint")
				return
			}
			const b = this.buf[this.pos++] ?? 0
			if (i < 4) lo |= (b & 127) << (i * 7)
			else if (i === 4) {
				lo |= (b & 127) << 28
				hi |= (b & 127) >> 4
			} else hi |= (b & 127) << ((i - 5) * 7 + 3)
			if (b < 128) {
				this.lo = lo >>> 0
				this.hi = hi >>> 0
				return
			}
		}
		this.fail("invalid varint encoding")
	}

	bool(): boolean {
		let value = false
		for (let i = 0; i < 10; i++) {
			if (this.pos >= this.limit) {
				this.fail("index out of range: truncated varint")
				return false
			}
			const b = this.buf[this.pos++] ?? 0
			if ((b & 127) !== 0) value = true
			if (b < 128) return value
		}
		this.fail("invalid varint encoding")
		return false
	}

	/** Reserves `n` bytes and returns their offset, or -1 when the input ends first. */
	private take(n: number): number {
		const start = this.pos
		if (start + n > this.limit) {
			this.fail(`index out of range: ${n} bytes past the end`)
			return -1
		}
		this.pos = start + n
		return start
	}

	fixed32(): number {
		const at = this.take(4)
		return at < 0 ? 0 : this.view.getUint32(at, true)
	}

	fixed64(): void {
		const at = this.take(8)
		this.lo = at < 0 ? 0 : this.view.getUint32(at, true)
		this.hi = at < 0 ? 0 : this.view.getUint32(at + 4, true)
	}

	double(): number {
		const at = this.take(8)
		return at < 0 ? 0 : this.view.getFloat64(at, true)
	}

	/** Offset of a length-delimited payload (cursor moved past it), or -1. */
	delimited(): number {
		const length = this.size()
		return this.error === undefined ? this.take(length) : -1
	}

	/** Strict UTF-8, like proto3's `utf8_validation = VERIFY`: invalid text fails the decode. */
	string(): string {
		const start = this.delimited()
		const end = this.pos
		if (start < 0 || end === start) return ""
		if (end - start < 32) {
			// Short ASCII (most keys and names) is cheaper to build by hand than through TextDecoder.
			let ascii = ""
			for (let i = start; i < end; i++) {
				const c = this.buf[i] ?? 0
				if (c >= 128) {
					ascii = ""
					break
				}
				ascii += String.fromCharCode(c)
				if (i === end - 1) return ascii
			}
		}
		const text = looseUtf8.decode(this.buf.subarray(start, end))
		// The loose decoder writes U+FFFD for bad input; valid text re-encodes to the same bytes.
		if (Str.includes("\uFFFD")(text) && !sameBytes(utf8Encoder.encode(text), this.buf, start, end)) {
			this.fail("invalid UTF-8 in a string field")
			return ""
		}
		return text
	}

	bytesBase64(): string {
		const start = this.delimited()
		if (start < 0 || this.pos === start) return ""
		if (this.pos - start > 48)
			return Buffer.from(this.buf.buffer, this.buf.byteOffset + start, this.pos - start).toString(
				"base64",
			)
		// Ids (16 and 8 bytes) dominate; encoding them by hand skips a Buffer per field.
		let out = ""
		for (let i = start; i < this.pos; i += 3) {
			const left = this.pos - i
			const n =
				((this.buf[i] ?? 0) << 16) |
				((left > 1 ? (this.buf[i + 1] ?? 0) : 0) << 8) |
				(left > 2 ? (this.buf[i + 2] ?? 0) : 0)
			out += BASE64[(n >> 18) & 63] ?? ""
			out += BASE64[(n >> 12) & 63] ?? ""
			out += left > 1 ? (BASE64[(n >> 6) & 63] ?? "") : "="
			out += left > 2 ? (BASE64[n & 63] ?? "") : "="
		}
		return out
	}

	/** Skips one unknown field, groups (wire type 3) included. */
	skip(wire: number, fieldNo: number, depth: number): void {
		if (depth > MAX_DEPTH) return this.fail("max depth exceeded")
		if (fieldNo === 0) return this.fail("illegal tag: field number 0")
		switch (wire) {
			case 0:
				while (this.error === undefined) {
					if (this.pos >= this.limit) return this.fail("index out of range: truncated varint")
					if (((this.buf[this.pos++] ?? 0) & 128) === 0) return
				}
				return
			case 1:
				this.take(8)
				return
			case 2:
				this.delimited()
				return
			case 5:
				this.take(4)
				return
			case 3:
				while (this.error === undefined) {
					const tag = this.tag()
					const nested = tag >>> 3
					if (this.error !== undefined) return
					if (nested === 0) return this.fail("illegal tag: field number 0")
					if ((tag & 7) === 4) {
						if (nested !== fieldNo) this.fail("invalid end group tag")
						return
					}
					this.skip(tag & 7, nested, depth + 1)
				}
				return
			default:
				this.fail(`invalid wire type ${wire} at offset ${this.pos}`)
		}
	}
}

const sameBytes = (a: Uint8Array, buf: Uint8Array, start: number, end: number): boolean => {
	if (a.length !== end - start) return false
	for (let i = 0; i < a.length; i++) if (a[i] !== buf[start + i]) return false
	return true
}

const TWO_POW_32 = 4294967296

const unsignedDecimal = (lo: number, hi: number): string =>
	// Below 2^53 a double is exact; above, BigInt keeps every digit.
	hi < 0x200000 ? String(hi * TWO_POW_32 + lo) : ((BigInt(hi) << 32n) | BigInt(lo)).toString()

const signedDecimal = (lo: number, hi: number): string =>
	hi < 0x80000000 ? unsignedDecimal(lo, hi) : BigInt.asIntN(64, (BigInt(hi) << 32n) | BigInt(lo)).toString()

const readScalar = (r: WireReader, kind: Scalar): unknown => {
	switch (kind) {
		case "string":
			return r.string()
		case "bytes":
			return r.bytesBase64()
		case "bool":
			return r.bool()
		case "double":
			return r.double()
		case "int32":
			return r.uint32() | 0
		case "uint32":
			return r.uint32()
		case "sint32": {
			const value = r.uint32()
			return ((value >>> 1) ^ -(value & 1)) | 0
		}
		case "fixed32":
			return r.fixed32()
		case "int64":
			r.varint64()
			return signedDecimal(r.lo, r.hi)
		case "uint64":
			r.varint64()
			return unsignedDecimal(r.lo, r.hi)
		case "fixed64":
			r.fixed64()
			return unsignedDecimal(r.lo, r.hi)
		case "sfixed64":
			r.fixed64()
			return signedDecimal(r.lo, r.hi)
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

const listOf = (target: Record<string, unknown>, name: string): Array<unknown> => {
	const current: unknown = target[name]
	if (Arr.isArray(current)) return current
	const list: Array<unknown> = []
	target[name] = list
	return list
}

/** Runs `body` with the cursor bounded by a length prefix; no-op once the reader has failed. */
const withinLength = (r: WireReader, body: (end: number) => void): void => {
	const length = r.size()
	if (r.error !== undefined) return
	const end = r.pos + length
	if (end > r.limit) return r.fail("index out of range: length past the end")
	const outer = r.limit
	r.limit = end
	body(end)
	if (r.error === undefined) r.limit = outer
}

/**
 * Reads fields into `target` until the cursor's limit. A field read again replaces a scalar,
 * appends to a list and merges into a message; a oneof write clears the other members. A known
 * field on an unexpected wire type is skipped like an unknown one.
 */
const decodeFields = (
	r: WireReader,
	type: MessageType,
	target: Record<string, unknown>,
	depth: number,
): void => {
	if (depth > MAX_DEPTH) return r.fail("max depth exceeded")
	while (r.error === undefined && r.pos < r.limit) {
		const tag = r.tag()
		if (r.error !== undefined) return
		const no = tag >>> 3
		const wire = tag & 7
		const field = type.byNo[no]
		if (field === undefined) r.skip(wire, no, depth)
		else if (field.repeated) {
			const list = listOf(target, field.name)
			const scalar = field.scalar
			if (wire === 2 && field.wire !== 2 && scalar !== undefined)
				withinLength(r, (end) => {
					while (r.error === undefined && r.pos < end) list.push(readScalar(r, scalar))
				})
			else if (wire !== field.wire) r.skip(wire, no, depth)
			else list.push(readValue(r, field, undefined, depth))
		} else if (wire !== field.wire) r.skip(wire, no, depth)
		else {
			const value = readValue(r, field, target[field.name], depth)
			if (field.oneof !== undefined)
				for (const sibling of field.siblings) Reflect.deleteProperty(target, sibling)
			target[field.name] = value
			if (field.oneof !== undefined) target[field.oneof] = field.name
		}
	}
}

const readValue = (r: WireReader, field: Field, existing: unknown, depth: number): unknown => {
	if (field.scalar !== undefined) return readScalar(r, field.scalar)
	const type = field.message?.()
	if (type === undefined) return null
	const target = isRecord(existing) ? existing : type.create()
	withinLength(r, () => decodeFields(r, type, target, depth + 1))
	return target
}

const decoderFor =
	(type: () => MessageType) =>
	(bytes: Uint8Array): Result.Result<unknown, OtlpProtobufDecodeError> => {
		const reader = new WireReader(bytes)
		const message = type().create()
		decodeFields(reader, type(), message, 0)
		return reader.error === undefined
			? Result.succeed(message)
			: Result.fail(new OtlpProtobufDecodeError({ message: reader.error, offset: reader.errorAt }))
	}

// --- common/v1, resource/v1 ---
const R = "repeated"
const OPTIONAL = "optional"
const VALUE = { oneof: "value" }

const AnyValue: MessageType = messageType([
	[1, "stringValue", "string", VALUE],
	[2, "boolValue", "bool", VALUE],
	[3, "intValue", "int64", VALUE],
	[4, "doubleValue", "double", VALUE],
	[5, "arrayValue", () => ArrayValue, VALUE],
	[6, "kvlistValue", () => KeyValueList, VALUE],
	[7, "bytesValue", "bytes", VALUE],
])
const ArrayValue: MessageType = messageType([[1, "values", () => AnyValue, R]])
const KeyValueList: MessageType = messageType([[1, "values", () => KeyValue, R]])
const KeyValue: MessageType = messageType([
	[1, "key", "string"],
	[2, "value", () => AnyValue],
])
const attributes = (no: number, name = "attributes") => [no, name, () => KeyValue, R] as const
const InstrumentationScope = messageType([
	[1, "name", "string"],
	[2, "version", "string"],
	attributes(3),
	[4, "droppedAttributesCount", "uint32"],
])
const Resource = messageType([attributes(1), [2, "droppedAttributesCount", "uint32"]])

// --- trace/v1 ---
const Status = messageType([
	[2, "message", "string"],
	[3, "code", "int32"],
])
const SpanEvent = messageType([
	[1, "timeUnixNano", "fixed64"],
	[2, "name", "string"],
	attributes(3),
	[4, "droppedAttributesCount", "uint32"],
])
const SpanLink = messageType([
	[1, "traceId", "bytes"],
	[2, "spanId", "bytes"],
	[3, "traceState", "string"],
	attributes(4),
	[5, "droppedAttributesCount", "uint32"],
	[6, "flags", "fixed32"],
])
const Span = messageType([
	[1, "traceId", "bytes"],
	[2, "spanId", "bytes"],
	[3, "traceState", "string"],
	[4, "parentSpanId", "bytes"],
	[5, "name", "string"],
	[6, "kind", "int32"],
	[7, "startTimeUnixNano", "fixed64"],
	[8, "endTimeUnixNano", "fixed64"],
	attributes(9),
	[10, "droppedAttributesCount", "uint32"],
	[11, "events", () => SpanEvent, R],
	[12, "droppedEventsCount", "uint32"],
	[13, "links", () => SpanLink, R],
	[14, "droppedLinksCount", "uint32"],
	[15, "status", () => Status],
	[16, "flags", "fixed32"],
])
const ScopeSpans = messageType([
	[1, "scope", () => InstrumentationScope],
	[2, "spans", () => Span, R],
	[3, "schemaUrl", "string"],
])
const ResourceSpans = messageType([
	[1, "resource", () => Resource],
	[2, "scopeSpans", () => ScopeSpans, R],
	[3, "schemaUrl", "string"],
])
const ExportTraceServiceRequest = messageType([[1, "resourceSpans", () => ResourceSpans, R]])

// --- logs/v1 (field 4 is reserved) ---
const LogRecord = messageType([
	[1, "timeUnixNano", "fixed64"],
	[2, "severityNumber", "int32"],
	[3, "severityText", "string"],
	[5, "body", () => AnyValue],
	attributes(6),
	[7, "droppedAttributesCount", "uint32"],
	[8, "flags", "fixed32"],
	[9, "traceId", "bytes"],
	[10, "spanId", "bytes"],
	[11, "observedTimeUnixNano", "fixed64"],
	[12, "eventName", "string"],
])
const ScopeLogs = messageType([
	[1, "scope", () => InstrumentationScope],
	[2, "logRecords", () => LogRecord, R],
	[3, "schemaUrl", "string"],
])
const ResourceLogs = messageType([
	[1, "resource", () => Resource],
	[2, "scopeLogs", () => ScopeLogs, R],
	[3, "schemaUrl", "string"],
])
const ExportLogsServiceRequest = messageType([[1, "resourceLogs", () => ResourceLogs, R]])

// --- metrics/v1 ---
const Exemplar = messageType([
	[2, "timeUnixNano", "fixed64"],
	[3, "asDouble", "double", VALUE],
	[4, "spanId", "bytes"],
	[5, "traceId", "bytes"],
	[6, "asInt", "sfixed64", VALUE],
	attributes(7, "filteredAttributes"),
])
const exemplars = (no: number) => [no, "exemplars", () => Exemplar, R] as const
const NumberDataPoint = messageType([
	[2, "startTimeUnixNano", "fixed64"],
	[3, "timeUnixNano", "fixed64"],
	[4, "asDouble", "double", VALUE],
	exemplars(5),
	[6, "asInt", "sfixed64", VALUE],
	attributes(7),
	[8, "flags", "uint32"],
])
const HistogramDataPoint = messageType([
	[2, "startTimeUnixNano", "fixed64"],
	[3, "timeUnixNano", "fixed64"],
	[4, "count", "fixed64"],
	[5, "sum", "double", OPTIONAL],
	[6, "bucketCounts", "fixed64", R],
	[7, "explicitBounds", "double", R],
	exemplars(8),
	attributes(9),
	[10, "flags", "uint32"],
	[11, "min", "double", OPTIONAL],
	[12, "max", "double", OPTIONAL],
])
const Buckets = messageType([
	[1, "offset", "sint32"],
	[2, "bucketCounts", "uint64", R],
])
const ExponentialHistogramDataPoint = messageType([
	attributes(1),
	[2, "startTimeUnixNano", "fixed64"],
	[3, "timeUnixNano", "fixed64"],
	[4, "count", "fixed64"],
	[5, "sum", "double", OPTIONAL],
	[6, "scale", "sint32"],
	[7, "zeroCount", "fixed64"],
	[8, "positive", () => Buckets],
	[9, "negative", () => Buckets],
	[10, "flags", "uint32"],
	exemplars(11),
	[12, "min", "double", OPTIONAL],
	[13, "max", "double", OPTIONAL],
	[14, "zeroThreshold", "double"],
])
const ValueAtQuantile = messageType([
	[1, "quantile", "double"],
	[2, "value", "double"],
])
const SummaryDataPoint = messageType([
	[2, "startTimeUnixNano", "fixed64"],
	[3, "timeUnixNano", "fixed64"],
	[4, "count", "fixed64"],
	[5, "sum", "double"],
	[6, "quantileValues", () => ValueAtQuantile, R],
	attributes(7),
	[8, "flags", "uint32"],
])
const temporality = [2, "aggregationTemporality", "int32"] as const
const Gauge = messageType([[1, "dataPoints", () => NumberDataPoint, R]])
const Sum = messageType([
	[1, "dataPoints", () => NumberDataPoint, R],
	temporality,
	[3, "isMonotonic", "bool"],
])
const Histogram = messageType([[1, "dataPoints", () => HistogramDataPoint, R], temporality])
const ExponentialHistogram = messageType([
	[1, "dataPoints", () => ExponentialHistogramDataPoint, R],
	temporality,
])
const Summary = messageType([[1, "dataPoints", () => SummaryDataPoint, R]])
const DATA = { oneof: "data" }
const Metric = messageType([
	[1, "name", "string"],
	[2, "description", "string"],
	[3, "unit", "string"],
	[5, "gauge", () => Gauge, DATA],
	[7, "sum", () => Sum, DATA],
	[9, "histogram", () => Histogram, DATA],
	[10, "exponentialHistogram", () => ExponentialHistogram, DATA],
	[11, "summary", () => Summary, DATA],
	attributes(12, "metadata"),
])

const ScopeMetrics = messageType([
	[1, "scope", () => InstrumentationScope],
	[2, "metrics", () => Metric, R],
	[3, "schemaUrl", "string"],
])
const ResourceMetrics = messageType([
	[1, "resource", () => Resource],
	[2, "scopeMetrics", () => ScopeMetrics, R],
	[3, "schemaUrl", "string"],
])
const ExportMetricsServiceRequest = messageType([[1, "resourceMetrics", () => ResourceMetrics, R]])

// --- profiles/v1development (opentelemetry-proto v1.10.0 to v1.11.1; older layouts reuse these
// field numbers with other meanings). Since v1.10 a key or a string value may instead be an index
// into the dictionary's string table, so attributes get their own messages. ---
const ProfileAnyValue: MessageType = messageType([
	[1, "stringValue", "string", VALUE],
	[2, "boolValue", "bool", VALUE],
	[3, "intValue", "int64", VALUE],
	[4, "doubleValue", "double", VALUE],
	[5, "arrayValue", () => ProfileArrayValue, VALUE],
	[6, "kvlistValue", () => ProfileKeyValueList, VALUE],
	[7, "bytesValue", "bytes", VALUE],
	[8, "stringValueStrindex", "int32", VALUE],
])
const ProfileArrayValue: MessageType = messageType([[1, "values", () => ProfileAnyValue, R]])
const ProfileKeyValueList: MessageType = messageType([[1, "values", () => ProfileKeyValue, R]])
const ProfileKeyValue: MessageType = messageType([
	[1, "key", "string"],
	[2, "value", () => ProfileAnyValue],
	[3, "keyStrindex", "int32"],
])
const profileAttributes = (no: number) => [no, "attributes", () => ProfileKeyValue, R] as const
const indices = (no: number, name = "attributeIndices") => [no, name, "int32", R] as const
const ProfileResource = messageType([profileAttributes(1), [2, "droppedAttributesCount", "uint32"]])
const ProfileScope = messageType([
	[1, "name", "string"],
	[2, "version", "string"],
	profileAttributes(3),
	[4, "droppedAttributesCount", "uint32"],
])
const ProfileValueType = messageType([
	[1, "typeStrindex", "int32"],
	[2, "unitStrindex", "int32"],
])
const ProfileSample = messageType([
	[1, "stackIndex", "int32"],
	indices(2),
	[3, "linkIndex", "int32"],
	[4, "values", "int64", R],
	[5, "timestampsUnixNano", "fixed64", R],
])
const Profile = messageType([
	[1, "sampleType", () => ProfileValueType],
	[2, "samples", () => ProfileSample, R],
	[3, "timeUnixNano", "fixed64"],
	[4, "durationNano", "uint64"],
	[5, "periodType", () => ProfileValueType],
	[6, "period", "int64"],
	[7, "profileId", "bytes"],
	[8, "droppedAttributesCount", "uint32"],
	[9, "originalPayloadFormat", "string"],
	[10, "originalPayload", "bytes"],
	indices(11),
])
const ProfileMapping = messageType([
	[1, "memoryStart", "uint64"],
	[2, "memoryLimit", "uint64"],
	[3, "fileOffset", "uint64"],
	[4, "filenameStrindex", "int32"],
	indices(5),
])
const ProfileLine = messageType([
	[1, "functionIndex", "int32"],
	[2, "line", "int64"],
	[3, "column", "int64"],
])
const ProfileLocation = messageType([
	[1, "mappingIndex", "int32"],
	[2, "address", "uint64"],
	[3, "lines", () => ProfileLine, R],
	indices(4),
])
const ProfileFunction = messageType([
	[1, "nameStrindex", "int32"],
	[2, "systemNameStrindex", "int32"],
	[3, "filenameStrindex", "int32"],
	[4, "startLine", "int64"],
])
const ProfileLink = messageType([
	[1, "traceId", "bytes"],
	[2, "spanId", "bytes"],
])
const ProfileKeyValueAndUnit = messageType([
	[1, "keyStrindex", "int32"],
	[2, "value", () => ProfileAnyValue],
	[3, "unitStrindex", "int32"],
])

const ProfileStack = messageType([indices(1, "locationIndices")])
const ProfilesDictionary = messageType([
	[1, "mappingTable", () => ProfileMapping, R],
	[2, "locationTable", () => ProfileLocation, R],
	[3, "functionTable", () => ProfileFunction, R],
	[4, "linkTable", () => ProfileLink, R],
	[5, "stringTable", "string", R],
	[6, "attributeTable", () => ProfileKeyValueAndUnit, R],
	[7, "stackTable", () => ProfileStack, R],
])
const ScopeProfiles = messageType([
	[1, "scope", () => ProfileScope],
	[2, "profiles", () => Profile, R],
	[3, "schemaUrl", "string"],
])
const ResourceProfiles = messageType([
	[1, "resource", () => ProfileResource],
	[2, "scopeProfiles", () => ScopeProfiles, R],
	[3, "schemaUrl", "string"],
])
const ExportProfilesServiceRequest = messageType([
	[1, "resourceProfiles", () => ResourceProfiles, R],
	[2, "dictionary", () => ProfilesDictionary],
])

// --- collector responses ---
const responseType = (rejected: string) => {
	const partialSuccess = messageType([
		[1, rejected, "int64"],
		[2, "errorMessage", "string"],
	])
	return messageType([[1, "partialSuccess", () => partialSuccess]])
}
const rejectedField = {
	traces: "rejectedSpans",
	logs: "rejectedLogRecords",
	metrics: "rejectedDataPoints",
	profiles: "rejectedProfiles",
} as const
const responseTypes = {
	traces: responseType(rejectedField.traces),
	logs: responseType(rejectedField.logs),
	metrics: responseType(rejectedField.metrics),
	profiles: responseType(rejectedField.profiles),
} as const

export const decodeTraceRequest = decoderFor(() => ExportTraceServiceRequest)
export const decodeLogsRequest = decoderFor(() => ExportLogsServiceRequest)
export const decodeMetricsRequest = decoderFor(() => ExportMetricsServiceRequest)
export const decodeProfilesRequest = decoderFor(() => ExportProfilesServiceRequest)

// --- encoding: the export responses, and request fixtures for tests ---

class WireWriter {
	readonly out: Array<number> = []

	varint(value: bigint): void {
		let rest = BigInt.asUintN(64, value)
		while (rest >= 128n) {
			this.out.push(Number(rest & 127n) | 128)
			rest >>= 7n
		}
		this.out.push(Number(rest))
	}

	fixed(value: bigint, bytes: 4 | 8): void {
		const rest = BigInt.asUintN(bytes * 8, value)
		for (let i = 0; i < bytes; i++) this.out.push(Number((rest >> BigInt(i * 8)) & 255n))
	}

	raw(payload: ReadonlyArray<number> | Uint8Array): void {
		for (const b of payload) this.out.push(b)
	}

	delimited(payload: ReadonlyArray<number> | Uint8Array): void {
		this.varint(BigInt(payload.length))
		this.raw(payload)
	}
}

/** protobufjs `fromObject` accepted a number, a decimal string or a bigint for a 64-bit field. */
const toBigInt = (value: unknown): bigint => {
	if (typeof value === "bigint") return value
	if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n
	if (typeof value === "string" && /^\s*[-+]?\d+\s*$/.test(value)) return BigInt(Str.trim(value))
	return 0n
}

const writeScalar = (w: WireWriter, kind: Scalar, value: unknown): void => {
	switch (kind) {
		case "string":
			return w.delimited(utf8Encoder.encode(String(value)))
		case "bytes":
			return w.delimited(typeof value === "string" ? Buffer.from(value, "base64") : new Uint8Array())
		case "bool":
			return w.varint(value ? 1n : 0n)
		case "double": {
			const bytes = new Uint8Array(8)
			new DataView(bytes.buffer).setFloat64(0, Number(value), true)
			return w.raw(bytes)
		}
		case "int32":
			return w.varint(BigInt(Number(value) | 0))
		case "uint32":
			return w.varint(BigInt(Number(value) >>> 0))
		case "sint32": {
			const n = Number(value) | 0
			return w.varint(BigInt(((n << 1) ^ (n >> 31)) >>> 0))
		}
		case "fixed32":
			return w.fixed(BigInt(Number(value) >>> 0), 4)
		case "int64":
		case "uint64":
			return w.varint(toBigInt(value))
		case "fixed64":
		case "sfixed64":
			return w.fixed(toBigInt(value), 8)
	}
}

const writeTag = (w: WireWriter, no: number, wire: number): void => w.varint(BigInt((no << 3) | wire))

/** Writes every field present in `object` (null and undefined are absent), lists packed. */
const encodeMessage = (w: WireWriter, type: MessageType, object: Record<string, unknown>): void => {
	for (const field of type.fields) {
		const value = object[field.name]
		if (value === null || value === undefined) continue
		const items: ReadonlyArray<unknown> = field.repeated ? (Arr.isArray(value) ? value : []) : [value]
		const scalar = field.scalar
		if (field.repeated && field.wire !== 2 && scalar !== undefined) {
			if (items.length === 0) continue
			const packed = new WireWriter()
			for (const item of items) writeScalar(packed, scalar, item)
			writeTag(w, field.no, 2)
			w.delimited(packed.out)
			continue
		}
		for (const item of items) {
			if (scalar !== undefined) {
				writeTag(w, field.no, field.wire)
				writeScalar(w, scalar, item)
			} else if (isRecord(item) && field.message !== undefined) {
				const nested = new WireWriter()
				encodeMessage(nested, field.message(), item)
				writeTag(w, field.no, 2)
				w.delimited(nested.out)
			}
		}
	}
}

const encoderFor =
	(type: () => MessageType) =>
	(object: unknown): Uint8Array => {
		const w = new WireWriter()
		if (isRecord(object)) encodeMessage(w, type(), object)
		return Uint8Array.from(w.out)
	}

/** Test helpers: encode an OTLP/JSON-shaped request object to protobuf bytes. */
export const encodeTraceRequest = encoderFor(() => ExportTraceServiceRequest)
export const encodeLogsRequest = encoderFor(() => ExportLogsServiceRequest)
export const encodeMetricsRequest = encoderFor(() => ExportMetricsServiceRequest)
export const encodeProfilesRequest = encoderFor(() => ExportProfilesServiceRequest)

export function encodeExportResponse(
	signal: "traces" | "logs" | "metrics" | "profiles",
	rejected: number,
	errorMessage: string,
): Uint8Array {
	const object = rejected > 0 ? { partialSuccess: { [rejectedField[signal]]: rejected, errorMessage } } : {}
	return encoderFor(() => responseTypes[signal])(object)
}

export const encodeProfilesExportResponse = (rejected: number, errorMessage: string): Uint8Array =>
	encodeExportResponse("profiles", rejected, errorMessage)
