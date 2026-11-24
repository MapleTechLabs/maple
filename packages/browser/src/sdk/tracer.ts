// An `@opentelemetry/api` TracerProvider: sampling, ids and span processors,
// with the OTel JS SDK's parenting and sampling rules.
import {
	type Attributes,
	type Context,
	context as contextApi,
	diag,
	INVALID_SPAN_CONTEXT,
	isSpanContextValid,
	type Link,
	type Span as ApiSpan,
	SpanKind,
	type SpanOptions,
	type Tracer as ApiTracer,
	type TracerOptions,
	type TracerProvider as ApiTracerProvider,
	TraceFlags,
	type TraceState,
	trace,
} from "@opentelemetry/api"
import { cleanAttributes } from "./attributes"
import { isTracingSuppressed } from "./propagation"
import {
	cleanLink,
	type InstrumentationScope,
	type ReadableSpan,
	type Resource,
	type Span,
	SpanImpl,
	type SpanProcessor,
} from "./span"

/** Numbered as the OTel SDK's decisions (the api's copy is deprecated). */
export const SamplingDecision = { NOT_RECORD: 0, RECORD: 1, RECORD_AND_SAMPLED: 2 } as const
export type SamplingDecision = (typeof SamplingDecision)[keyof typeof SamplingDecision]

export interface SamplingResult {
	readonly decision: SamplingDecision
	readonly attributes?: Readonly<Attributes>
	readonly traceState?: TraceState
}

export interface Sampler {
	shouldSample(
		context: Context,
		traceId: string,
		spanName: string,
		spanKind: SpanKind,
		attributes: Attributes,
		links: Link[],
	): SamplingResult
	toString(): string
}

export interface IdGenerator {
	generateTraceId(): string
	generateSpanId(): string
}

const randomHex = (bytes: number): string => {
	const values = crypto.getRandomValues(new Uint8Array(bytes))
	// An all-zero id is invalid; the odds are negligible, but never emit one.
	if (values.every((byte) => byte === 0)) values[bytes - 1] = 1
	return Array.from(values, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const randomIds: IdGenerator = {
	generateTraceId: () => randomHex(16),
	generateSpanId: () => randomHex(8),
}

/** The OTel default: follow a parent's decision, sample every root. */
const parentBasedAlwaysOn: Sampler = {
	shouldSample: (context): SamplingResult => {
		const parent = trace.getSpanContext(context)
		if (!parent || !isSpanContextValid(parent)) return { decision: SamplingDecision.RECORD_AND_SAMPLED }
		return {
			decision:
				(parent.traceFlags & TraceFlags.SAMPLED) !== 0
					? SamplingDecision.RECORD_AND_SAMPLED
					: SamplingDecision.NOT_RECORD,
		}
	},
	toString: () => "ParentBased{root=AlwaysOnSampler}",
}

interface TracerState {
	readonly resource: Resource
	readonly sampler: Sampler
	readonly ids: IdGenerator
	readonly processor: SpanProcessor
}

export class Tracer implements ApiTracer {
	constructor(
		readonly instrumentationScope: InstrumentationScope,
		private readonly state: TracerState,
	) {}

	startSpan(name: string, options: SpanOptions = {}, parent: Context = contextApi.active()): ApiSpan {
		const context = options.root ? trace.deleteSpan(parent) : parent
		if (isTracingSuppressed(context)) return trace.wrapSpanContext(INVALID_SPAN_CONTEXT)
		const parentContext = trace.getSpan(context)?.spanContext()
		const validParent = parentContext && isSpanContextValid(parentContext) ? parentContext : undefined
		const spanId = this.state.ids.generateSpanId()
		const traceId = validParent?.traceId ?? this.state.ids.generateTraceId()
		const kind = options.kind ?? SpanKind.INTERNAL
		const links = (options.links ?? []).map(cleanLink)
		const initial = cleanAttributes(options.attributes)
		const result = this.state.sampler.shouldSample(
			context,
			traceId,
			name,
			kind,
			initial.attributes,
			links,
		)
		const traceState = result.traceState ?? validParent?.traceState
		const sampled = result.decision === SamplingDecision.RECORD_AND_SAMPLED
		const spanContext = {
			traceId,
			spanId,
			traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
			traceState,
		}
		if (result.decision === SamplingDecision.NOT_RECORD) return trace.wrapSpanContext(spanContext)
		const attributes = cleanAttributes({ ...initial.attributes, ...result.attributes })
		return new SpanImpl({
			resource: this.state.resource,
			scope: this.instrumentationScope,
			context,
			spanContext,
			name,
			kind,
			links,
			parentSpanContext: validParent,
			attributes: attributes.attributes,
			droppedAttributesCount: initial.dropped + attributes.dropped,
			startTime: options.startTime,
			processor: this.state.processor,
		})
	}

	startActiveSpan<F extends (span: ApiSpan) => ReturnType<F>>(name: string, fn: F): ReturnType<F>
	startActiveSpan<F extends (span: ApiSpan) => ReturnType<F>>(
		name: string,
		options: SpanOptions,
		fn: F,
	): ReturnType<F>
	startActiveSpan<F extends (span: ApiSpan) => ReturnType<F>>(
		name: string,
		options: SpanOptions,
		context: Context,
		fn: F,
	): ReturnType<F>
	startActiveSpan<F extends (span: ApiSpan) => ReturnType<F>>(
		name: string,
		...rest: [F] | [SpanOptions, F] | [SpanOptions, Context, F]
	): ReturnType<F> {
		const [options, parent, fn] =
			rest.length === 1
				? [{}, undefined, rest[0]]
				: rest.length === 2
					? [rest[0], undefined, rest[1]]
					: rest
		const context = parent ?? contextApi.active()
		const span = this.startSpan(name, options, context)
		return contextApi.with(trace.setSpan(context, span), fn, undefined, span)
	}
}

/** Fans each span out to every processor, in order. */
class MultiSpanProcessor implements SpanProcessor {
	constructor(readonly processors: ReadonlyArray<SpanProcessor>) {}

	onStart(span: Span, context: Context): void {
		for (const processor of this.processors) processor.onStart(span, context)
	}

	onEnding(span: Span): void {
		for (const processor of this.processors) processor.onEnding?.(span)
	}

	onEnd(span: ReadableSpan): void {
		for (const processor of this.processors) processor.onEnd(span)
	}

	async forceFlush(): Promise<void> {
		await Promise.all(this.processors.map((processor) => processor.forceFlush())).catch(
			(error: unknown) => diag.error("MultiSpanProcessor: forceFlush failed", error),
		)
	}

	async shutdown(): Promise<void> {
		await Promise.all(this.processors.map((processor) => processor.shutdown()))
	}
}

const FLUSH_TIMEOUT_MS = 30_000

export interface TracerProviderOptions {
	readonly resource?: Resource
	readonly sampler?: Sampler
	readonly idGenerator?: IdGenerator
	readonly spanProcessors?: ReadonlyArray<SpanProcessor>
}

export class TracerProvider implements ApiTracerProvider {
	private readonly tracers = new Map<string, Tracer>()
	private readonly processor: MultiSpanProcessor
	private readonly state: TracerState

	constructor(options: TracerProviderOptions = {}) {
		this.processor = new MultiSpanProcessor(options.spanProcessors ?? [])
		this.state = {
			resource: options.resource ?? { attributes: {} },
			sampler: options.sampler ?? parentBasedAlwaysOn,
			ids: options.idGenerator ?? randomIds,
			processor: this.processor,
		}
	}

	getTracer(name: string, version?: string, options?: TracerOptions): Tracer {
		const key = `${name}@${version || ""}:${options?.schemaUrl || ""}`
		const existing = this.tracers.get(key)
		if (existing) return existing
		const tracer = new Tracer({ name, version, schemaUrl: options?.schemaUrl }, this.state)
		this.tracers.set(key, tracer)
		return tracer
	}

	/** Flush every processor; one that has not finished within 30s fails the flush. */
	async forceFlush(): Promise<void> {
		const results = await Promise.all(
			this.processor.processors.map(
				(processor) =>
					new Promise<unknown>((resolve) => {
						const timer = setTimeout(
							() =>
								resolve(
									new Error(
										`Span processor did not complete within ${FLUSH_TIMEOUT_MS} ms`,
									),
								),
							FLUSH_TIMEOUT_MS,
						)
						processor.forceFlush().then(
							() => {
								clearTimeout(timer)
								resolve(undefined)
							},
							(error: unknown) => {
								clearTimeout(timer)
								resolve(error ?? new Error("forceFlush failed"))
							},
						)
					}),
			),
		)
		const errors = results.filter((result) => result !== undefined)
		if (errors.length > 0) return Promise.reject(errors)
	}

	shutdown(): Promise<void> {
		return this.processor.shutdown()
	}
}
