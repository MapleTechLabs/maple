// The recording span, shaped like the OTel JS SDK's so processors, exporters and
// the OTLP encoder read the same fields (`ReadableSpan`).
import {
	type Attributes,
	type AnyValue,
	type Context,
	diag,
	type Exception,
	type HrTime,
	type Link,
	type Span as ApiSpan,
	type SpanContext,
	type SpanKind,
	type SpanStatus,
	SpanStatusCode,
	type TimeInput,
} from "@opentelemetry/api"
import { addAttribute, cleanAttributes } from "./attributes"
import { addHrTimes, hrTime, hrTimeDuration, isHrTime, isTimeInput, millisToHrTime } from "./time"

/** Events and links kept per span, as the OTel default limits. */
const EVENT_LIMIT = 128
const LINK_LIMIT = 128

export interface Resource {
	readonly attributes: Attributes
}

export interface InstrumentationScope {
	readonly name: string
	readonly version?: string | undefined
	readonly schemaUrl?: string | undefined
}

export interface TimedEvent {
	readonly name: string
	readonly time: HrTime
	readonly attributes?: Attributes
	readonly droppedAttributesCount?: number
}

export interface ReadableSpan {
	readonly name: string
	readonly kind: SpanKind
	readonly spanContext: () => SpanContext
	readonly parentSpanContext?: SpanContext | undefined
	readonly startTime: HrTime
	readonly endTime: HrTime
	readonly status: SpanStatus
	readonly attributes: Attributes
	readonly links: Link[]
	readonly events: TimedEvent[]
	readonly duration: HrTime
	readonly ended: boolean
	readonly resource: Resource
	readonly instrumentationScope: InstrumentationScope
	readonly droppedAttributesCount: number
	readonly droppedEventsCount: number
	readonly droppedLinksCount: number
}

/** A span still open to processors: `onEnding` may rewrite its status and attributes. */
export interface Span extends ApiSpan, Omit<ReadableSpan, "spanContext" | "status" | "attributes"> {
	status: SpanStatus
	readonly attributes: Attributes
}

export interface SpanProcessor {
	onStart(span: Span, parentContext: Context): void
	onEnding?(span: Span): void
	onEnd(span: ReadableSpan): void
	forceFlush(): Promise<void>
	shutdown(): Promise<void>
}

export interface ExportResult {
	readonly code: number
	readonly error?: Error
}

export const ExportResultCode = { SUCCESS: 0, FAILED: 1 } as const

export interface SpanExporter {
	export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void
	forceFlush?(): Promise<void>
	shutdown(): Promise<void>
}

export interface SpanInit {
	readonly resource: Resource
	readonly scope: InstrumentationScope
	readonly context: Context
	readonly spanContext: SpanContext
	readonly name: string
	readonly kind: SpanKind
	readonly links: Link[]
	readonly parentSpanContext: SpanContext | undefined
	readonly attributes: Attributes
	readonly droppedAttributesCount: number
	readonly startTime: TimeInput | undefined
	readonly processor: SpanProcessor
}

export class SpanImpl implements Span {
	readonly kind: SpanKind
	readonly parentSpanContext: SpanContext | undefined
	readonly attributes: Attributes
	readonly links: Link[]
	readonly events: TimedEvent[] = []
	readonly startTime: HrTime
	readonly resource: Resource
	readonly instrumentationScope: InstrumentationScope
	name: string
	status: SpanStatus = { code: SpanStatusCode.UNSET }
	endTime: HrTime = [0, 0]
	private readonly context: SpanContext
	private readonly processor: SpanProcessor
	private readonly performanceStart: number
	/** Epoch ms minus `timeOrigin + performance.now()`: how far the monotonic clock drifted. */
	private readonly performanceOffset: number
	private readonly startTimeProvided: boolean
	private attributeCount: number
	private droppedAttributes: number
	private droppedEvents = 0
	private droppedLinks: number
	private isEnded = false
	private spanDuration: HrTime = [-1, -1]

	constructor(init: SpanInit) {
		const now = Date.now()
		this.context = init.spanContext
		this.performanceStart = performance.now()
		this.performanceOffset = now - (this.performanceStart + performance.timeOrigin)
		this.startTimeProvided = init.startTime != null
		this.processor = init.processor
		this.name = init.name
		this.parentSpanContext = init.parentSpanContext
		this.kind = init.kind
		this.startTime = this.time(init.startTime ?? now)
		this.resource = init.resource
		this.instrumentationScope = init.scope
		this.links = init.links.slice(-LINK_LIMIT)
		this.droppedLinks = init.links.length - this.links.length
		this.attributes = init.attributes
		this.attributeCount = Object.keys(this.attributes).length
		this.droppedAttributes = init.droppedAttributesCount
		this.processor.onStart(this, init.context)
	}

	spanContext(): SpanContext {
		return this.context
	}

	setAttribute(key: string, value: AnyValue): this {
		if (this.endedWarn()) return this
		const decision = addAttribute(this.attributes, this.attributeCount, key, value)
		if (decision === "limit") {
			this.droppedAttributes += 1
			if (this.droppedAttributes === 1) diag.warn("Dropping extra attributes.")
		} else if (decision === "added") this.attributeCount += 1
		return this
	}

	setAttributes(attributes: Attributes): this {
		for (const [key, value] of Object.entries(attributes)) this.setAttribute(key, value)
		return this
	}

	addEvent(name: string, attributesOrTime?: Attributes | TimeInput, time?: TimeInput): this {
		if (this.endedWarn()) return this
		if (this.events.length >= EVENT_LIMIT) {
			if (this.droppedEvents === 0) diag.debug("Dropping extra events.")
			this.events.shift()
			this.droppedEvents += 1
		}
		const timeOnly = isTimeInput(attributesOrTime)
		const at = timeOnly && !isTimeInput(time) ? attributesOrTime : time
		const attributes = timeOnly ? undefined : attributesOrTime
		const event = { name, time: this.time(at) }
		if (typeof attributes !== "object" || attributes === null) this.events.push(event)
		else {
			const cleaned = cleanAttributes(attributes, true)
			this.events.push({
				...event,
				attributes: cleaned.attributes,
				droppedAttributesCount: cleaned.dropped,
			})
		}
		return this
	}

	addLink(link: Link): this {
		if (this.endedWarn()) return this
		if (this.links.length >= LINK_LIMIT) {
			this.links.shift()
			this.droppedLinks += 1
		}
		this.links.push(cleanLink(link))
		return this
	}

	addLinks(links: Link[]): this {
		for (const link of links) this.addLink(link)
		return this
	}

	setStatus(status: SpanStatus): this {
		if (this.endedWarn()) return this
		if (status.code === SpanStatusCode.UNSET || this.status.code === SpanStatusCode.OK) return this
		const next: SpanStatus = { code: status.code }
		if (status.code === SpanStatusCode.ERROR) {
			if (typeof status.message === "string") next.message = status.message
			else if (status.message != null) {
				diag.warn(
					`Dropping invalid status.message of type '${typeof status.message}', expected 'string'`,
				)
			}
		}
		this.status = next
		return this
	}

	updateName(name: string): this {
		if (this.endedWarn()) return this
		this.name = name
		return this
	}

	end(endTime?: TimeInput): void {
		if (this.isEnded) {
			diag.error(
				`${this.name} ${this.context.traceId}-${this.context.spanId} - You can only call end() on a span once.`,
			)
			return
		}
		this.endTime = this.time(endTime)
		this.spanDuration = hrTimeDuration(this.startTime, this.endTime)
		if (this.spanDuration[0] < 0) {
			diag.warn("Inconsistent start and end time, startTime > endTime. Setting span duration to 0ms.")
			this.endTime = [this.startTime[0], this.startTime[1]]
			this.spanDuration = [0, 0]
		}
		this.processor.onEnding?.(this)
		this.isEnded = true
		this.processor.onEnd(this)
	}

	isRecording(): boolean {
		return !this.isEnded
	}

	recordException(exception: Exception, time?: TimeInput): void {
		const attributes: Record<string, string> = {}
		if (typeof exception === "string") attributes["exception.message"] = exception
		else {
			// Truthiness, as the OTel SDK: a `code` of 0 or "" falls back to `name`.
			const code = exception.code === undefined || exception.code === 0 ? "" : String(exception.code)
			const type = code !== "" ? code : (exception.name ?? "")
			if (type !== "") attributes["exception.type"] = type
			if (exception.message !== undefined && exception.message !== "") {
				attributes["exception.message"] = exception.message
			}
			if (exception.stack !== undefined && exception.stack !== "") {
				attributes["exception.stacktrace"] = exception.stack
			}
		}
		if (attributes["exception.type"] !== undefined || attributes["exception.message"] !== undefined) {
			this.addEvent("exception", attributes, time)
		} else diag.warn("Failed to record an exception", exception)
	}

	get duration(): HrTime {
		return this.spanDuration
	}

	get ended(): boolean {
		return this.isEnded
	}

	get droppedAttributesCount(): number {
		return this.droppedAttributes
	}

	get droppedEventsCount(): number {
		return this.droppedEvents
	}

	get droppedLinksCount(): number {
		return this.droppedLinks
	}

	/** Epoch or `performance.now()` ms, a Date, an HrTime, or now on the span's monotonic clock. */
	private time(input: TimeInput | undefined): HrTime {
		if (typeof input === "number" && input <= performance.now())
			return hrTime(input + this.performanceOffset)
		if (typeof input === "number") return millisToHrTime(input)
		if (input instanceof Date) return millisToHrTime(input.getTime())
		if (isHrTime(input)) return input
		if (this.startTimeProvided) return millisToHrTime(Date.now())
		return addHrTimes(this.startTime, millisToHrTime(performance.now() - this.performanceStart))
	}

	private endedWarn(): boolean {
		if (this.isEnded) {
			diag.warn(
				`Cannot execute the operation on ended Span {traceId: ${this.context.traceId}, spanId: ${this.context.spanId}}`,
			)
		}
		return this.isEnded
	}
}

/** A link's attributes validated, as the span keeps it. */
export function cleanLink(link: Link): Link {
	if (link.attributes === undefined) return { context: link.context }
	const { attributes, dropped } = cleanAttributes(link.attributes)
	return { context: link.context, attributes, droppedAttributesCount: dropped }
}
