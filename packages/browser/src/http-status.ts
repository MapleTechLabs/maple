// One rule for when an HTTP client span is an error, whichever instrumentation
// made it. The fetch instrumentation leaves 4xx/5xx responses Unset; the XHR
// one marks every status >= 400 Error, and every Error span becomes an issue.
// A response status is an error only when the app lists it in
// `errors.captureHttpStatus`; a network failure always is.
import { type Attributes, type SpanStatus, SpanKind, SpanStatusCode } from "@opentelemetry/api"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"

const HTTP_STATUS = /^\d{3}$/

/** A status code, or an inclusive `[from, to]` range. */
export type HttpStatusRange = number | readonly [number, number]

const statusOf = (span: ReadableSpan): number | undefined => {
	const value = span.attributes["http.response.status_code"] ?? span.attributes["http.status_code"]
	return typeof value === "number" ? value : undefined
}

const inRanges = (status: number, ranges: ReadonlyArray<HttpStatusRange>): boolean =>
	ranges.some((range) =>
		typeof range === "number" ? range === status : status >= range[0] && status <= range[1],
	)

/** `GET https://api.example.com/users/42 -> 500`, without the query: ids are redacted by the issue fingerprint. */
function failureMessage(span: ReadableSpan, status: number | string): string {
	const method = span.attributes["http.request.method"] ?? span.attributes["http.method"] ?? "GET"
	const url = String(span.attributes["url.full"] ?? span.attributes["http.url"] ?? "").replace(
		/[?#].*$/,
		"",
	)
	return `${String(method)} ${url} -> ${status}`
}

/** An Error set only because of the response status: `error.type` is the status code itself. */
function isStatusOnlyError(span: ReadableSpan): boolean {
	return (
		span.kind === SpanKind.CLIENT &&
		span.status.code === SpanStatusCode.ERROR &&
		HTTP_STATUS.test(String(span.attributes["error.type"] ?? "")) &&
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
		private readonly captureStatus: ReadonlyArray<HttpStatusRange> = [],
	) {}

	private apply(span: ReadableSpan): ReadableSpan {
		const status = statusOf(span)
		if (span.kind === SpanKind.CLIENT && status !== undefined && inRanges(status, this.captureStatus)) {
			if (span.events.some((event) => event.name === "exception")) return span
			return withStatus(
				span,
				{ code: SpanStatusCode.ERROR },
				{
					...span.attributes,
					"error.type": String(status),
					"error.message": failureMessage(span, status),
				},
			)
		}
		const errorType = span.attributes["error.type"]
		if (
			span.kind === SpanKind.CLIENT &&
			span.status.code === SpanStatusCode.ERROR &&
			typeof errorType === "string" &&
			!HTTP_STATUS.test(errorType) &&
			span.attributes["error.message"] === undefined &&
			!span.events.some((event) => event.name === "exception")
		) {
			// A network failure (`TypeError`, `error`, `timeout`): the same message shape as a status error.
			return withStatus(span, span.status, {
				...span.attributes,
				"error.message": failureMessage(span, errorType),
			})
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
