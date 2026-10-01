// Buffer-backed OTLP tracer (platform-agnostic)
//
// Pure Tracer that pushes OTLP-shaped spans into a caller-owned buffer. URL,
// resource, and headers are NOT baked in here — the caller (the Cloudflare,
// server, or client flushable preset) resolves them and POSTs the drained
// buffer on `flush`, so the layer itself can be constructed without I/O.
import { Cause, Context, Exit, Layer, Option, Predicate, Tracer } from "effect"
import * as ErrorReporter from "effect/ErrorReporter"
import * as OtlpResource from "effect/unstable/observability/OtlpResource"
import type { ExtractTag } from "effect/Types"
import { resolveSpanFilter, type SpanFilter, type SpanFilterInput } from "./span-options.js"

export interface CaptureExceptionOptions {
	/** Span name. Default `"exception"`. */
	readonly name?: string | undefined
	/** Extra span attributes (e.g. the URL the error happened on). */
	readonly attributes?: Record<string, unknown> | undefined
}

export interface SpanBuffer {
	readonly tracerLayer: Layer.Layer<never>
	/**
	 * Record a thrown value that never passed through an Effect span.
	 *
	 * Everything else in this buffer arrives because an Effect *span* failed —
	 * which means an error thrown outside Effect had no path here at all. In a
	 * browser that is most of them: a React render crash caught by an error
	 * boundary, a throw in an event handler, a rejected promise nobody awaited.
	 *
	 * The error is recorded as a one-off span carrying a `Die` cause, so it takes
	 * the same road as every other failure: `makeOtlpSpan` gives it status
	 * `Error` and an `exception` event with type/message/stacktrace, which is
	 * exactly the shape `error_events_mv` fingerprints on. A `Die` (not a `Fail`)
	 * because an uncaught throw is by definition not an anticipated failure —
	 * that also keeps it clear of the `anticipatedErrorIdentifiers` filter, which
	 * would otherwise let a caller silence real crashes by tag.
	 *
	 * BOUNDARY: a thrown value is unparsed by definition — JavaScript can throw
	 * anything. `Cause.prettyErrors` narrows it on the way into the event.
	 */
	readonly captureException: (error: unknown, options?: CaptureExceptionOptions) => void
	readonly drain: () => Array<OtlpSpan>
	readonly restore: (items: ReadonlyArray<OtlpSpan>) => void
	readonly setDisabled: (value: boolean) => void
	readonly size: () => number
}

const MAX_BUFFER = 10_000

export type SpanBufferOptions = SpanFilterInput

// Errors carrying Effect's `[ErrorReporter.ignore]` flag are benign by design —
// Effect's own "don't report this failure" signal. The canonical case is
// `HttpServerError { reason: RouteNotFound }` (unmatched routes → 404), which
// would otherwise surface as an Error-status span. We key off the annotation
// rather than concrete error tags so the check stays robust and HTTP-agnostic;
// genuine failures (400 parse errors, 500s) keep `ignore = false` and trace.
const isIgnoredFailure = (error: unknown): boolean =>
	Predicate.hasProperty(error, ErrorReporter.ignore) && error[ErrorReporter.ignore] === true

const isIgnoredExit = (exit: Exit.Exit<unknown, unknown>): boolean => {
	if (exit._tag !== "Failure") return false
	if (exit.cause.reasons.some(Cause.isDieReason)) return false
	const failures = exit.cause.reasons.filter(Cause.isFailReason)
	return failures.length > 0 && failures.every((reason) => isIgnoredFailure(reason.error))
}

/**
 * Turns a finished span into its OTLP shape, or `undefined` when it must not be
 * exported (unsampled, dropped, or an ignored failure).
 */
export const makeSpanEncoder = (filter: SpanFilter) => {
	const drop = filter.drop
	return (span: SpanImpl): OtlpSpan | undefined => {
		if (!span.sampled) return undefined
		const status = span.status as ExtractTag<Tracer.SpanStatus, "Ended">
		if (
			drop !== undefined &&
			drop({ name: span.name, kind: span.kind, attributes: span.attributes, exit: status.exit })
		)
			return undefined
		if (isIgnoredExit(status.exit)) return undefined
		return makeOtlpSpan(span, filter)
	}
}

/**
 * A Tracer whose finished spans go to `exportFn`. A span matching
 * `dropSpanSubtrees` starts unsampled, which its descendants inherit (Effect
 * only samples a child of a sampled parent), so the whole subtree is skipped.
 * Only ever forced to `false`: trace levels and incoming `00` headers win.
 */
export const makeMapleTracer = (filter: SpanFilter, exportFn: (span: SpanImpl) => void): Tracer.Tracer => {
	const dropSubtree = filter.dropSubtree
	return Tracer.make({
		span(spanOptions) {
			return makeSpan({
				...spanOptions,
				sampled: spanOptions.sampled && (dropSubtree === undefined || !dropSubtree(spanOptions.name)),
				status: { _tag: "Started", startTime: spanOptions.startTime },
				attributes: new Map(),
				export: exportFn,
			})
		},
	})
}

export const makeSpanBuffer = (options: SpanBufferOptions = {}): SpanBuffer => {
	let buffer: Array<OtlpSpan> = []
	let disabled = false
	const filter = resolveSpanFilter(options)
	const encode = makeSpanEncoder(filter)

	const exportFn = (span: SpanImpl) => {
		if (disabled) return
		if (buffer.length >= MAX_BUFFER) return
		const otlp = encode(span)
		if (otlp !== undefined) buffer.push(otlp)
	}

	const tracer = makeMapleTracer(filter, exportFn)

	const captureException = (error: unknown, captureOptions: CaptureExceptionOptions = {}): void => {
		if (disabled) return
		const now = BigInt(Date.now()) * 1_000_000n
		const span = makeSpan({
			name: captureOptions.name ?? "exception",
			parent: Option.none(),
			annotations: Context.empty(),
			status: { _tag: "Started", startTime: now },
			attributes: new Map(Object.entries(captureOptions.attributes ?? {})),
			links: [],
			sampled: true,
			kind: "internal",
			export: exportFn,
		})
		span.end(now, Exit.failCause(Cause.die(error)))
	}

	return {
		tracerLayer: Layer.succeed(Tracer.Tracer, tracer),
		captureException,
		drain: () => {
			const items = buffer
			buffer = []
			return items
		},
		restore: (items) => {
			if (disabled || items.length === 0) return
			buffer = [...items, ...buffer].slice(0, MAX_BUFFER)
		},
		setDisabled: (value) => {
			disabled = value
			if (value) buffer = []
		},
		size: () => buffer.length,
	}
}

// OTLP span construction (adapted from `effect/unstable/observability/OtlpTracer`)

const ATTR_EXCEPTION_TYPE = "exception.type"
const ATTR_EXCEPTION_MESSAGE = "exception.message"
const ATTR_EXCEPTION_STACKTRACE = "exception.stacktrace"

export interface SpanImpl extends Tracer.Span {
	readonly export: (span: SpanImpl) => void
	readonly attributes: Map<string, unknown>
	readonly links: Array<Tracer.SpanLink>
	readonly events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown> | undefined]>
	status: Tracer.SpanStatus
}

const SpanProto = {
	_tag: "Span" as const,
	end(this: SpanImpl, endTime: bigint, exit: import("effect/Exit").Exit<unknown, unknown>) {
		this.status = { _tag: "Ended", startTime: this.status.startTime, endTime, exit }
		this.export(this)
	},
	attribute(this: SpanImpl, key: string, value: unknown) {
		this.attributes.set(key, value)
	},
	event(this: SpanImpl, name: string, startTime: bigint, attributes?: Record<string, unknown>) {
		this.events.push([name, startTime, attributes])
	},
	addLinks(this: SpanImpl, links: ReadonlyArray<Tracer.SpanLink>) {
		this.links.push(...links)
	},
}

const makeSpan = (options: {
	readonly name: string
	readonly parent: Option.Option<Tracer.AnySpan>
	readonly annotations: Context.Context<never>
	readonly status: Tracer.SpanStatus
	readonly attributes: ReadonlyMap<string, unknown>
	readonly links: ReadonlyArray<Tracer.SpanLink>
	readonly sampled: boolean
	readonly kind: Tracer.SpanKind
	readonly export: (span: SpanImpl) => void
}): SpanImpl => {
	const self = Object.assign(Object.create(SpanProto), options) as SpanImpl
	;(self as { traceId: string }).traceId =
		self.parent._tag === "Some" ? self.parent.value.traceId : generateId(32)
	;(self as { spanId: string }).spanId = generateId(16)
	;(self as { events: unknown[] }).events = []
	return self
}

const generateId = (len: number): string => {
	const chars = "0123456789abcdef"
	let result = ""
	for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)]
	return result
}

// A span whose failure is caused *entirely* by anticipated errors (no
// defects/Die) records OTLP status `Ok` and emits no `exception` event.
const isFullyAnticipated = (
	cause: Cause.Cause<unknown>,
	isAnticipated: ((error: unknown) => boolean) | undefined,
): boolean => {
	if (isAnticipated === undefined) return false
	if (cause.reasons.some(Cause.isDieReason)) return false
	const failErrors = cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
	return failErrors.length > 0 && failErrors.every(isAnticipated)
}

// OTEL HTTP semconv for SERVER spans: a 5xx response is an error even when the
// handler rendered it as a plain response — exactly what the HTTP boundaries
// (`HttpRouter.toWebHandler`, alchemy's Worker bridge) do with a defect, so the
// span would otherwise reach the warehouse as `Ok` and the crash never reach
// error tracking. A 4xx is a rejection the service handled and stays `Ok`.
const renderedServerError = (self: SpanImpl): number | undefined => {
	if (self.kind !== "server") return undefined
	const raw = self.attributes.get("http.response.status_code")
	const code = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN
	return Number.isInteger(code) && code >= 500 ? code : undefined
}

const makeOtlpSpan = (self: SpanImpl, filter: SpanFilter): OtlpSpan => {
	const status = self.status as ExtractTag<Tracer.SpanStatus, "Ended">
	const attributes = OtlpResource.entriesToAttributes(self.attributes.entries())
	const events = self.events.map(([name, startTime, attrs]) => ({
		name,
		timeUnixNano: String(startTime),
		attributes: attrs ? OtlpResource.entriesToAttributes(Object.entries(attrs)) : [],
		droppedAttributesCount: 0,
	}))

	let otelStatus: Status
	const serverError = renderedServerError(self)
	if (serverError !== undefined && status.exit._tag === "Success") {
		const method = self.attributes.get("http.request.method")
		const path = self.attributes.get("url.path")
		const message =
			typeof method === "string" && typeof path === "string"
				? `HTTP ${serverError} (${method} ${path})`
				: `HTTP ${serverError}`
		otelStatus = { code: StatusCode.Error, message }
		// Only when nothing named the failure itself — relabelling a recorded exception would
		// collapse every such 5xx into one anonymous bucket in error tracking.
		if (!events.some((event) => event.name === "exception")) {
			events.push({
				name: "exception",
				timeUnixNano: String(status.endTime),
				droppedAttributesCount: 0,
				attributes: [
					{ key: ATTR_EXCEPTION_TYPE, value: { stringValue: "HttpServerErrorResponse" } },
					{ key: ATTR_EXCEPTION_MESSAGE, value: { stringValue: message } },
				],
			})
		}
	} else if (status.exit._tag === "Success") {
		otelStatus = constOtelStatusSuccess
	} else if (Cause.hasInterruptsOnly(status.exit.cause)) {
		otelStatus = { code: StatusCode.Ok, message: "Interrupted" }
		attributes.push(
			{ key: "span.label", value: { stringValue: "⚠︎ Interrupted" } },
			{ key: "status.interrupted", value: { boolValue: true } },
		)
	} else if (serverError === undefined && isFullyAnticipated(status.exit.cause, filter.isAnticipated)) {
		// Expected business outcome (4xx). Keep the span (latency / status code
		// stay visible) but don't flag it as an error or fingerprint it. A server
		// span that still answered 5xx is a real error, anticipated or not.
		otelStatus = constOtelStatusSuccess
	} else {
		const errors = Cause.prettyErrors(status.exit.cause, {
			includeCauseInStack: filter.includeCauseInStack,
		})
		otelStatus = { code: StatusCode.Error }
		const firstError = errors[0]
		if (firstError) {
			otelStatus.message = firstError.message
			for (const error of errors) {
				events.push({
					name: "exception",
					timeUnixNano: String(status.endTime),
					droppedAttributesCount: 0,
					attributes: [
						{ key: ATTR_EXCEPTION_TYPE, value: { stringValue: error.name } },
						{ key: ATTR_EXCEPTION_MESSAGE, value: { stringValue: error.message } },
						{
							key: ATTR_EXCEPTION_STACKTRACE,
							value: { stringValue: error.stack ?? "No stack trace available" },
						},
					],
				})
			}
		}
	}

	return {
		traceId: self.traceId,
		spanId: self.spanId,
		parentSpanId: self.parent._tag === "Some" ? self.parent.value.spanId : undefined,
		name: self.name,
		kind: SpanKind[self.kind],
		startTimeUnixNano: String(status.startTime),
		endTimeUnixNano: String(status.endTime),
		attributes,
		droppedAttributesCount: 0,
		events,
		droppedEventsCount: 0,
		status: otelStatus,
		links: self.links.map((link) => ({
			traceId: link.span.traceId,
			spanId: link.span.spanId,
			attributes: OtlpResource.entriesToAttributes(Object.entries(link.attributes)),
			droppedAttributesCount: 0,
		})),
		droppedLinksCount: 0,
	}
}

// OTLP wire types

export interface OtlpSpan {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string | undefined
	readonly name: string
	readonly kind: number
	readonly startTimeUnixNano: string
	readonly endTimeUnixNano: string
	readonly attributes: Array<OtlpResource.KeyValue>
	readonly droppedAttributesCount: number
	readonly events: Array<Event>
	readonly droppedEventsCount: number
	readonly status: Status
	readonly links: Array<Link>
	readonly droppedLinksCount: number
}
interface Event {
	readonly attributes: Array<OtlpResource.KeyValue>
	readonly name: string
	readonly timeUnixNano: string
	readonly droppedAttributesCount: number
}
interface Link {
	readonly attributes: Array<OtlpResource.KeyValue>
	readonly spanId: string
	readonly traceId: string
	readonly droppedAttributesCount: number
}
interface Status {
	readonly code: StatusCode
	message?: string
}

const StatusCode = {
	Unset: 0,
	Ok: 1,
	Error: 2,
} as const
type StatusCode = (typeof StatusCode)[keyof typeof StatusCode]

const SpanKind = {
	unspecified: 0,
	internal: 1,
	server: 2,
	client: 3,
	producer: 4,
	consumer: 5,
} as const

const constOtelStatusSuccess: Status = { code: StatusCode.Ok }
