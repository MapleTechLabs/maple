// A CLIENT span per `fetch()`, as OTel JS instrumentation-fetch 0.301 made it:
// named after the method, `traceparent` to allowed URLs, ended 300ms after the
// body is read so its resource timing can be attached.
import { context, diag, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { hrTime, millisToHrTime } from "./time"
import {
	addResourceTiming,
	isUrlIgnored,
	methodAttributes,
	OBSERVER_WAIT_TIME_MS,
	observeResources,
	parseUrl,
	type RequestInstrumentationConfig,
	redactUrl,
	safely,
	serverPort,
	traceHeaders,
	tryReplace,
} from "./web"

export interface FetchInstrumentationConfig extends RequestInstrumentationConfig {
	/** Runs as the response settles or the request rejects, before the span's deferred end. */
	readonly applyCustomAttributesOnSpan: (
		span: Span,
		request: Request | RequestInit,
		result: Response | Error | undefined,
	) => void
}

interface Settled {
	readonly status: number
	readonly url: string
}

type Observed = ReturnType<typeof observeResources> & { readonly url: string }

/** Marks a span ended before its response body finished (the page left, or the SDK shut down). */
const BODY_UNFINISHED = "maple.response_body_unfinished"

export interface FetchInstrumentation {
	/** Unpatch `fetch`. */
	readonly stop: () => void
	/**
	 * End the spans of responses whose body is still streaming, at once, with their
	 * headers-time data, and stop reading their clones. For page exit and shutdown.
	 */
	readonly endUnfinishedBodies: () => void
}

/** Patch `globalThis.fetch`. */
export function instrumentFetch(config: FetchInstrumentationConfig): FetchInstrumentation {
	const original = globalThis.fetch
	if (typeof PerformanceObserver === "undefined" || typeof original !== "function") return INACTIVE
	let enabled = true
	const used = new WeakSet<PerformanceResourceTiming>()
	/** Responses whose body is still being read, and how to end each one now. */
	const unfinished = new Map<Span, () => void>()

	const endSpan = (span: Span, request: Observed, settled: Settled): void => {
		const endTime = millisToHrTime(Date.now())
		const performanceEndTime = hrTime()
		span.setAttribute("http.response.status_code", settled.status)
		const responseUrl = parseUrl(settled.url)
		span.setAttribute("server.address", responseUrl.hostname)
		const port = serverPort(responseUrl)
		if (port !== undefined) span.setAttribute("server.port", port)
		if (settled.status >= 400) {
			span.setStatus({ code: SpanStatusCode.ERROR })
			span.setAttribute("error.type", String(settled.status))
		}
		setTimeout(() => {
			request.disconnect()
			// Ended early (the page went away) or never recorded: nothing left to add.
			if (!span.isRecording()) return
			addResourceTiming(config.tracer, span, request, performanceEndTime, used, "fetch")
			span.end(endTime)
		}, OBSERVER_WAIT_TIME_MS)
	}

	const patched = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
		const [input, init] = args
		if (!enabled) return original.apply(this, args)
		const url = parseUrl(input instanceof Request ? input.url : String(input)).href
		const options: Request | RequestInit =
			input instanceof Request ? (init != null ? new Request(input, init) : input) : (init ?? {})
		if (isUrlIgnored(url, config.ignoreUrls)) return original.apply(this, args)
		const method = methodAttributes(options.method || "GET")
		const span = config.tracer.startSpan(method["http.request.method"] ?? "GET", {
			kind: SpanKind.CLIENT,
			attributes: { ...method, "url.full": redactUrl(url) },
		})
		const request: Observed = { ...observeResources(url, "fetch"), url }
		const settle = (result: Response | Error | undefined, settled: Settled): void => {
			safely("applyCustomAttributesOnSpan", () =>
				config.applyCustomAttributesOnSpan(span, options, result),
			)
			endSpan(span, request, settled)
		}
		// A non-Error rejection reaches the hook as undefined.
		const fail = (error: Error | undefined): void => settle(error, { status: statusOf(error), url })
		const onSuccess = (response: Response): Response => {
			const ok = response.status >= 200 && response.status < 400
			const settleResponse = (): void =>
				settle(response, ok ? response : { status: response.status, url })
			// An event stream may never end: its span ends at the headers, and no clone holds its data.
			if (isEventStream(response)) {
				settleResponse()
				return response
			}
			// Each outcome runs once: the body ending, failing, or being cut off by `endUnfinishedBodies`.
			const first = (): boolean => unfinished.delete(span)
			let cancelRead = (): void => {}
			unfinished.set(span, () => {
				cancelRead()
				span.setAttribute(BODY_UNFINISHED, true)
				settleResponse()
				span.end()
			})
			cancelRead = readToEnd(
				response,
				() => {
					if (first()) settleResponse()
				},
				(error) => {
					if (first()) fail(error)
				},
				() => {
					if (first()) endSpan(span, request, { status: 0, url })
				},
			)
			return response
		}
		const onError = (error: unknown): never => {
			// A fetch wrapper earlier in the chain may reject with the Response itself: keep its status.
			if (error instanceof Response) settle(error, { status: error.status, url })
			else fail(error instanceof Error ? error : undefined)
			throw error
		}
		return context.with(trace.setSpan(context.active(), span), () => {
			addTraceHeaders(options, url, config.propagateTraceHeaderCorsUrls)
			const call: Parameters<typeof fetch> = options instanceof Request ? [options] : [url, options]
			const pending: Promise<Response> = original.apply(this, call)
			return pending.then(onSuccess, onError)
		})
	}

	if (!tryReplace(globalThis, "fetch", patched)) {
		diag.warn("globalThis.fetch is read-only; fetch() calls will not be traced")
		return INACTIVE
	}
	return {
		stop: () => {
			enabled = false
			// Guarded: a script that locked `fetch` since must not stop the rest of shutdown.
			if (globalThis.fetch === patched) tryReplace(globalThis, "fetch", original)
		},
		endUnfinishedBodies: () => {
			for (const cut of unfinished.values()) cut()
			unfinished.clear()
		},
	}
}

const INACTIVE: FetchInstrumentation = { stop: () => {}, endUnfinishedBodies: () => {} }

/** `text/event-stream` by media type, whatever its case, spacing or parameters. */
function isEventStream(response: Response): boolean {
	const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
	return type === "text/event-stream"
}

/** Onto the Request itself, or the init's headers replaced by a `Headers` carrying them. */
function addTraceHeaders(options: Request | RequestInit, url: string, corsUrls: ReadonlyArray<RegExp>): void {
	const headers = traceHeaders(url, corsUrls)
	if (!headers) return
	const target = options instanceof Request ? options.headers : new Headers(options.headers)
	// A Request with immutable headers throws on set: send it as it is rather than fail the app's fetch.
	safely("inject trace headers", () => {
		for (const [name, value] of Object.entries(headers)) target.set(name, value)
	})
	if (!(options instanceof Request)) options.headers = target
}

/** A rejection's own `status`, if it carries one; 0 otherwise. */
function statusOf(error: Error | undefined): number {
	const status = error !== undefined && "status" in error ? error.status : 0
	return typeof status === "number" && !Number.isNaN(status) ? status : 0
}

/**
 * Read a clone of the body to its end, so the span covers the download. Returns a
 * cancel for the clone only: the app's own body is untouched.
 */
function readToEnd(
	response: Response,
	done: () => void,
	fail: (error: Error | undefined) => void,
	broken: () => void,
): () => void {
	try {
		const body = response.clone().body
		if (!body) {
			done()
			return () => {}
		}
		const reader = body.getReader()
		const read = (): void => {
			reader.read().then(
				({ done: finished }) => (finished ? done() : read()),
				(error: unknown) => fail(error instanceof Error ? error : undefined),
			)
		}
		read()
		return () => {
			reader.cancel().catch(() => {})
		}
	} catch (error) {
		diag.error("Failed to read fetch response body", error)
		broken()
		return () => {}
	}
}
