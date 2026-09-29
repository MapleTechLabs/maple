// One rule for when an HTTP client span is an error, whichever instrumentation
// made it. The fetch instrumentation leaves 4xx/5xx responses Unset; the XHR
// one marks every status >= 400 Error, and every Error span becomes an issue.
// A response status alone is not an error here; a network failure still is.
import { type Attributes, SpanKind, SpanStatusCode } from "@opentelemetry/api"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"

const HTTP_STATUS = /^\d{3}$/

/** An Error set only because of the response status: `error.type` is the status code itself. */
function isStatusOnlyError(span: ReadableSpan): boolean {
	return (
		span.kind === SpanKind.CLIENT &&
		span.status.code === SpanStatusCode.ERROR &&
		HTTP_STATUS.test(String(span.attributes["error.type"] ?? "")) &&
		!span.events.some((event) => event.name === "exception")
	)
}

function withoutStatusError(span: ReadableSpan): ReadableSpan {
	const { "error.type": _errorType, ...attributes } = span.attributes
	return {
		name: span.name,
		kind: span.kind,
		spanContext: () => span.spanContext(),
		parentSpanContext: span.parentSpanContext,
		startTime: span.startTime,
		endTime: span.endTime,
		status: { code: SpanStatusCode.UNSET },
		attributes: attributes satisfies Attributes,
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
	constructor(private readonly inner: SpanExporter) {}

	export(spans: ReadableSpan[], callback: (result: { code: number; error?: Error }) => void): void {
		this.inner.export(
			spans.map((span) => (isStatusOnlyError(span) ? withoutStatusError(span) : span)),
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
