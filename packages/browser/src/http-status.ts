// The OTel adapter for the shared HTTP status policy. The fetch and XHR
// instrumentations already mark 4xx/5xx client spans Error, as the HTTP semantic
// conventions say; this applies `errors.captureHttpStatus` when an app narrows it.
import {
	DEFAULT_ERROR_STATUS,
	type HttpStatusRange,
	httpErrorType,
	inStatusRanges,
	type ReadAttribute,
	responseStatus,
} from "@maple/sdk-core"
import { type Attributes, type SpanStatus, SpanKind, SpanStatusCode } from "@opentelemetry/api"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace"

const HTTP_STATUS = /^\d{3}$/

/** An Error set only because of the response status: `error.type` is the status code itself. */
function isStatusOnlyError(span: ReadableSpan): boolean {
	const errorType = span.attributes["error.type"]
	return (
		span.kind === SpanKind.CLIENT &&
		span.status.code === SpanStatusCode.ERROR &&
		(typeof errorType === "string" || typeof errorType === "number") &&
		HTTP_STATUS.test(String(errorType)) &&
		!span.events.some((event) => event.name === "exception")
	)
}

function withStatus(span: ReadableSpan, status: SpanStatus, attributes: Attributes): ReadableSpan {
	return {
		name: span.name,
		kind: span.kind,
		spanContext: () => span.spanContext(),
		parentSpanContext: span.parentSpanContext,
		startTime: span.startTime,
		endTime: span.endTime,
		status,
		attributes,
		links: span.links,
		events: span.events,
		duration: span.duration,
		ended: span.ended,
		resource: span.resource,
		instrumentationScope: span.instrumentationScope,
		droppedAttributesCount: span.droppedAttributesCount,
		droppedEventsCount: span.droppedEventsCount,
		droppedLinksCount: span.droppedLinksCount,
	}
}

export class HttpStatusExporter implements SpanExporter {
	constructor(
		private readonly inner: SpanExporter,
		private readonly captureStatus: ReadonlyArray<HttpStatusRange> = DEFAULT_ERROR_STATUS,
	) {}

	private apply(span: ReadableSpan): ReadableSpan {
		// Attributes are `AnyValue` since api 1.10; a status is only ever a scalar.
		const read: ReadAttribute = (key) => {
			const value = span.attributes[key]
			return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
				? value
				: undefined
		}
		const status = responseStatus(read)
		if (
			span.kind === SpanKind.CLIENT &&
			status !== undefined &&
			inStatusRanges(status, this.captureStatus)
		) {
			if (span.events.some((event) => event.name === "exception")) return span
			return withStatus(
				span,
				{ code: SpanStatusCode.ERROR },
				{ ...span.attributes, ...httpErrorType(status) },
			)
		}
		if (!isStatusOnlyError(span)) return span
		const { "error.type": _errorType, ...attributes } = span.attributes
		return withStatus(span, { code: SpanStatusCode.UNSET }, attributes)
	}

	export(spans: ReadableSpan[], callback: (result: { code: number; error?: Error }) => void): void {
		this.inner.export(
			spans.map((span) => this.apply(span)),
			callback,
		)
	}

	forceFlush(): Promise<void> {
		return this.inner.forceFlush?.() ?? Promise.resolve()
	}

	shutdown(): Promise<void> {
		return this.inner.shutdown()
	}
}
