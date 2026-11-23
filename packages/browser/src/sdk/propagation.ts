// W3C Trace Context and Baggage propagators, registered as the page's global
// propagator so app code using `@opentelemetry/api` propagates through them.
import {
	type BaggageEntry,
	baggageEntryMetadataFromString,
	type Context,
	createContextKey,
	diag,
	isSpanContextValid,
	propagation,
	type TextMapGetter,
	type TextMapPropagator,
	type TextMapSetter,
	TraceFlags,
	trace,
} from "@opentelemetry/api"
import { TraceState } from "./trace-state"

// `createContextKey` is `Symbol.for`, so this is the key the OTel JS SDK suppresses tracing with too.
const SUPPRESS_TRACING = createContextKey("OpenTelemetry SDK Context Key SUPPRESS_TRACING")

export const suppressTracing = (context: Context): Context => context.setValue(SUPPRESS_TRACING, true)
export const isTracingSuppressed = (context: Context): boolean => context.getValue(SUPPRESS_TRACING) === true

const TRACEPARENT =
	/^\s?((?!ff)[\da-f]{2})-((?![0]{32})[\da-f]{32})-((?![0]{16})[\da-f]{16})-([\da-f]{2})(-.*)?\s?$/

export class W3CTraceContextPropagator implements TextMapPropagator {
	inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
		const spanContext = trace.getSpanContext(context)
		if (!spanContext || isTracingSuppressed(context) || !isSpanContextValid(spanContext)) return
		const raw = Number(spanContext.traceFlags ?? TraceFlags.NONE)
		const flags = (Number.isNaN(raw) ? TraceFlags.NONE : raw).toString(16)
		setter.set(carrier, "traceparent", `00-${spanContext.traceId}-${spanContext.spanId}-0${flags}`)
		if (spanContext.traceState) setter.set(carrier, "tracestate", spanContext.traceState.serialize())
	}

	extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
		const header = getter.get(carrier, "traceparent")
		const value = Array.isArray(header) ? header[0] : header
		if (typeof value !== "string") return context
		const match = TRACEPARENT.exec(value)
		if (!match || (match[1] === "00" && match[5]) || !match[2] || !match[3] || !match[4]) return context
		const state = getter.get(carrier, "tracestate")
		const joined = Array.isArray(state) ? state.join(",") : state
		return trace.setSpanContext(context, {
			traceId: match[2],
			spanId: match[3],
			traceFlags: Number.parseInt(match[4], 16),
			isRemote: true,
			...(joined ? { traceState: new TraceState(joined) } : undefined),
		})
	}

	fields(): string[] {
		return ["traceparent", "tracestate"]
	}
}

const BAGGAGE_MAX_PAIRS = 180
const BAGGAGE_MAX_PAIR_LENGTH = 4096
const BAGGAGE_MAX_LENGTH = 8192

export class W3CBaggagePropagator implements TextMapPropagator {
	inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
		const baggage = propagation.getBaggage(context)
		if (!baggage || isTracingSuppressed(context)) return
		const pairs = baggage
			.getAllEntries()
			.map(([key, entry]) => {
				const pair = `${encodeURIComponent(key)}=${encodeURIComponent(entry.value)}`
				return entry.metadata === undefined ? pair : `${pair};${entry.metadata.toString()}`
			})
			.filter((pair) => pair.length <= BAGGAGE_MAX_PAIR_LENGTH)
			.slice(0, BAGGAGE_MAX_PAIRS)
		const header = pairs.reduce((value, pair) => {
			const next = value === "" ? pair : `${value},${pair}`
			return next.length > BAGGAGE_MAX_LENGTH ? value : next
		}, "")
		if (header.length > 0) setter.set(carrier, "baggage", header)
	}

	extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
		const header = getter.get(carrier, "baggage")
		if (header === undefined || header.length === 0) return context
		const entries: Record<string, BaggageEntry> = {}
		let total = 0
		let count = 0
		const members = (Array.isArray(header) ? header : [header]).flatMap((value) => value.split(","))
		for (const member of members) {
			if (count >= BAGGAGE_MAX_PAIRS) break
			if (member.length > BAGGAGE_MAX_PAIR_LENGTH) continue
			const entry = parseBaggageMember(member)
			if (!entry) continue
			const size = (count === 0 ? 0 : 1) + member.length
			if (total + size > BAGGAGE_MAX_LENGTH) break
			entries[entry.key] = entry.value
			count += 1
			total += size
		}
		return count === 0 ? context : propagation.setBaggage(context, propagation.createBaggage(entries))
	}

	fields(): string[] {
		return ["baggage"]
	}
}

function parseBaggageMember(member: string): { key: string; value: BaggageEntry } | undefined {
	const metadataAt = member.indexOf(";")
	const pair = metadataAt === -1 ? member : member.slice(0, metadataAt)
	const equals = pair.indexOf("=")
	if (equals <= 0) return undefined
	const rawKey = pair.slice(0, equals).trim()
	const rawValue = pair.slice(equals + 1).trim()
	if (!rawKey || !rawValue) return undefined
	const key = safeDecode(rawKey)
	const value = safeDecode(rawValue)
	if (key === undefined || value === undefined) return undefined
	const metadata =
		metadataAt !== -1 && metadataAt < member.length - 1
			? baggageEntryMetadataFromString(member.slice(metadataAt + 1))
			: undefined
	return { key, value: metadata ? { value, metadata } : { value } }
}

function safeDecode(value: string): string | undefined {
	try {
		return decodeURIComponent(value)
	} catch {
		return undefined
	}
}

/** Runs each propagator in turn; one that throws is logged and skipped. */
export class CompositePropagator implements TextMapPropagator {
	constructor(private readonly propagators: ReadonlyArray<TextMapPropagator>) {}

	inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
		for (const propagator of this.propagators) {
			try {
				propagator.inject(context, carrier, setter)
			} catch (error) {
				diag.warn(`Failed to inject with ${propagator.constructor.name}. Err: ${String(error)}`)
			}
		}
	}

	extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
		return this.propagators.reduce((current, propagator) => {
			try {
				return propagator.extract(current, carrier, getter)
			} catch (error) {
				diag.warn(`Failed to extract with ${propagator.constructor.name}. Err: ${String(error)}`)
				return current
			}
		}, context)
	}

	fields(): string[] {
		return [...new Set(this.propagators.flatMap((propagator) => propagator.fields()))]
	}
}
