// A CLIENT span per XMLHttpRequest, as OTel JS instrumentation-xml-http-request
// 0.301 made it: opened at `open()`, propagated at `send()`, ended 300ms after
// the request settles so its resource timing can be attached.
import { context, diag, type HrTime, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { hrTime } from "./time"
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

export interface XhrInstrumentationConfig extends RequestInstrumentationConfig {
	/** Runs as the request settles, before the span's deferred end. */
	readonly applyCustomAttributesOnSpan: (span: Span, xhr: XMLHttpRequest) => void
}

type OriginalOpen = (this: XMLHttpRequest, ...args: [string, string | URL, ...unknown[]]) => void

interface Pending {
	readonly span: Span
	readonly url: string
	sendStartTime?: HrTime
	status?: number
	resources?: ReturnType<typeof observeResources>
	detach?: () => void
	settled?: boolean
	/** When it reached DONE, if that was before the event that settles it. */
	doneAt?: { readonly performance: HrTime; readonly epochMs: number }
}

/** Patch `XMLHttpRequest.prototype.open` and `send`; returns the unpatch. */
export function instrumentXhr(config: XhrInstrumentationConfig): () => void {
	if (typeof XMLHttpRequest === "undefined") return () => {}
	const proto = XMLHttpRequest.prototype
	// Both saved to call later with the request as `this`.
	// oxlint-disable-next-line typescript/unbound-method
	const originalOpen: OriginalOpen = proto.open
	// oxlint-disable-next-line typescript/unbound-method
	const originalSend = proto.send
	let enabled = true
	let pending = new WeakMap<XMLHttpRequest, Pending>()
	const used = new WeakSet<PerformanceResourceTiming>()
	/** A request reopened at DONE with no response, whose `error`/`timeout`/`abort` event is still to come. */
	const staleFailure = new WeakMap<XMLHttpRequest, Pending>()

	const finish = (eventName: string, entry: Pending, performanceEndTime: HrTime, endTime: number): void => {
		entry.resources?.disconnect()
		const { span } = entry
		// Ended early (the page went away) or never recorded: nothing left to add.
		if (!span.isRecording()) return
		if (entry.sendStartTime && entry.resources) {
			const request = {
				...entry.resources,
				url: parseUrl(entry.url).href,
				startTime: entry.sendStartTime,
			}
			addResourceTiming(config.tracer, span, request, performanceEndTime, used, "xmlhttprequest")
		}
		span.addEvent(eventName, endTime)
		if (entry.status !== undefined && entry.status !== 0)
			span.setAttribute("http.response.status_code", entry.status)
		span.end(endTime)
	}

	const settle = (
		xhr: XMLHttpRequest,
		entry: Pending,
		eventName: string,
		errorType?: string,
		status: number = xhr.status,
	): void => {
		if (entry.settled === true) return
		entry.settled = true
		// Detached now, not at the deferred end: the app may reuse the xhr for its next request at once.
		entry.detach?.()
		entry.status = status
		if (pending.get(xhr) === entry) pending.delete(xhr)
		const { span } = entry
		safely("applyCustomAttributesOnSpan", () => config.applyCustomAttributesOnSpan(span, xhr))
		if (errorType) {
			span.setStatus({ code: SpanStatusCode.ERROR, message: errorType })
			span.setAttribute("error.type", errorType)
		} else if (entry.status >= 400) {
			span.setStatus({ code: SpanStatusCode.ERROR })
			span.setAttribute("error.type", String(entry.status))
		}
		const performanceEndTime = entry.doneAt?.performance ?? hrTime()
		const endTime = entry.doneAt?.epochMs ?? Date.now()
		setTimeout(() => finish(eventName, entry, performanceEndTime, endTime), OBSERVER_WAIT_TIME_MS)
	}

	// The app's own arguments pass through as given, however many it passed.
	function open(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]): void {
		if (enabled) start(this, String(url), method)
		originalOpen.apply(this, [method, url, ...rest])
	}

	/**
	 * `open()` on an xhr whose last request has not settled. Reopened at DONE (from a
	 * `readystatechange` handler) the browser fires no `load`, so a response ends the span
	 * here; with no response its `error`, `timeout` or `abort` event still follows, and a
	 * fallback ends it if none does. Reopened mid-flight, the browser drops the request silently.
	 */
	const closePrevious = (xhr: XMLHttpRequest, previous: Pending): void => {
		pending.delete(xhr)
		if (previous.sendStartTime === undefined) {
			// Opened, never sent: nothing went out, so there is nothing to report.
			previous.detach?.()
			previous.resources?.disconnect()
		} else if (xhr.readyState !== XMLHttpRequest.DONE) {
			settle(xhr, previous, "abort")
		} else if (xhr.status !== 0) {
			settle(xhr, previous, xhr.status < 299 ? "loaded" : "error")
		} else {
			// Its failure event fires right after this handler, to whichever listeners are on the xhr then.
			previous.detach?.()
			previous.doneAt = { performance: hrTime(), epochMs: Date.now() }
			staleFailure.set(xhr, previous)
			setTimeout(() => {
				if (staleFailure.get(xhr) !== previous) return
				staleFailure.delete(xhr)
				settle(xhr, previous, "error", "error", 0)
			}, 0)
		}
	}

	const start = (xhr: XMLHttpRequest, url: string, method: string): void => {
		const previous = pending.get(xhr)
		if (previous) closePrevious(xhr, previous)
		const parsed = parseUrl(url)
		if (isUrlIgnored(parsed.href, config.ignoreUrls)) return
		const methods = methodAttributes(method)
		const port = serverPort(parsed)
		const span = config.tracer.startSpan(methods["http.request.method"] ?? method, {
			kind: SpanKind.CLIENT,
			attributes: {
				...methods,
				"url.full": redactUrl(parsed.toString()),
				"server.address": parsed.hostname,
				...(port !== undefined ? { "server.port": port } : undefined),
			},
		})
		span.addEvent("open")
		pending.set(xhr, { span, url })
	}

	const beginSend = (xhr: XMLHttpRequest, entry: Pending): void => {
		entry.sendStartTime = hrTime()
		entry.span.addEvent("send")
		// This request's own listeners, so settling it never detaches another request's.
		// A failure event still owed to the request this one replaced is that request's, not this one's.
		const failed = (eventName: string, errorType?: string) => (): void => {
			const stale = staleFailure.get(xhr)
			if (stale) {
				staleFailure.delete(xhr)
				settle(xhr, stale, eventName, errorType, 0)
			} else settle(xhr, entry, eventName, errorType)
		}
		const listeners = {
			load: () => settle(xhr, entry, xhr.status < 299 ? "loaded" : "error"),
			error: failed("error", "error"),
			abort: failed("abort"),
			timeout: failed("timeout", "timeout"),
		}
		entry.detach?.()
		for (const [type, listener] of Object.entries(listeners)) xhr.addEventListener(type, listener)
		entry.detach = () => {
			for (const [type, listener] of Object.entries(listeners)) xhr.removeEventListener(type, listener)
			entry.detach = undefined
		}
		const headers = traceHeaders(parseUrl(entry.url).href, config.propagateTraceHeaderCorsUrls)
		for (const [name, value] of Object.entries(headers ?? {})) xhr.setRequestHeader(name, value)
		if (typeof PerformanceResourceTiming === "function") {
			entry.resources = observeResources(parseUrl(entry.url).href, "xmlhttprequest")
		}
	}

	function send(this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["send"]>): void {
		const entry = enabled ? pending.get(this) : undefined
		if (entry)
			context.with(trace.setSpan(context.active(), entry.span), beginSend, undefined, this, entry)
		originalSend.apply(this, args)
	}

	// Both or neither: `open` without `send` would start spans nothing ever ends.
	if (!tryReplace(proto, "open", open) || !tryReplace(proto, "send", send)) {
		if (proto.open === open) proto.open = originalOpen
		diag.warn("XMLHttpRequest.prototype is read-only; XMLHttpRequest calls will not be traced")
		return () => {}
	}
	return () => {
		enabled = false
		pending = new WeakMap()
		if (proto.open === open) proto.open = originalOpen
		if (proto.send === send) proto.send = originalSend
	}
}
