// A CLIENT span per XMLHttpRequest, as OTel JS instrumentation-xml-http-request
// 0.301 made it: opened at `open()`, propagated at `send()`, ended 300ms after
// the request settles so its resource timing can be attached.
import { context, type HrTime, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
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
	removeListeners?: () => void
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

	const finish = (eventName: string, entry: Pending, performanceEndTime: HrTime, endTime: number): void => {
		entry.removeListeners?.()
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

	const settle = (xhr: XMLHttpRequest, eventName: string, errorType?: string): void => {
		const entry = pending.get(xhr)
		if (!entry) return
		entry.status = xhr.status
		pending.delete(xhr)
		const { span } = entry
		safely("applyCustomAttributesOnSpan", () => config.applyCustomAttributesOnSpan(span, xhr))
		if (errorType) {
			span.setStatus({ code: SpanStatusCode.ERROR, message: errorType })
			span.setAttribute("error.type", errorType)
		} else if (entry.status >= 400) {
			span.setStatus({ code: SpanStatusCode.ERROR })
			span.setAttribute("error.type", String(entry.status))
		}
		const performanceEndTime = hrTime()
		const endTime = Date.now()
		setTimeout(() => finish(eventName, entry, performanceEndTime, endTime), OBSERVER_WAIT_TIME_MS)
	}

	function onLoad(this: XMLHttpRequest): void {
		settle(this, this.status < 299 ? "loaded" : "error")
	}
	function onError(this: XMLHttpRequest): void {
		settle(this, "error", "error")
	}
	function onAbort(this: XMLHttpRequest): void {
		settle(this, "abort")
	}
	function onTimeout(this: XMLHttpRequest): void {
		settle(this, "timeout", "timeout")
	}
	const listeners = { load: onLoad, error: onError, abort: onAbort, timeout: onTimeout }

	// The app's own arguments pass through as given, however many it passed.
	function open(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]): void {
		if (enabled) start(this, String(url), method)
		originalOpen.apply(this, [method, url, ...rest])
	}

	const start = (xhr: XMLHttpRequest, url: string, method: string): void => {
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
		pending.get(xhr)?.removeListeners?.()
		pending.set(xhr, { span, url })
	}

	const beginSend = (xhr: XMLHttpRequest, entry: Pending): void => {
		entry.sendStartTime = hrTime()
		entry.span.addEvent("send")
		for (const [type, listener] of Object.entries(listeners)) xhr.addEventListener(type, listener)
		entry.removeListeners = () => {
			for (const [type, listener] of Object.entries(listeners)) xhr.removeEventListener(type, listener)
			entry.resources?.disconnect()
			entry.removeListeners = undefined
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

	proto.open = open
	proto.send = send
	return () => {
		enabled = false
		pending = new WeakMap()
		if (proto.open === open) proto.open = originalOpen
		if (proto.send === send) proto.send = originalSend
	}
}
